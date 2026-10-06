import { NextResponse, after } from "next/server";
import { del } from "@vercel/blob";
import { GoogleGenAI } from "@google/genai";
import type { File as GenAiFile } from "@google/genai";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  buildAnalysisResult,
  formatBookmarkLines,
  parseBlobRef,
  reportStage,
  transcriptToCheckpointSegments,
  writeJobRecord,
  segmentsToTranscriptText,
} from "@/lib/analysisPipeline";
import type { BlobRef, IncomingBookmark } from "@/lib/analysisPipeline";
import {
  callAnalysisWorker,
  deleteUploadedFile,
  describeGeminiError,
  uploadReferenceFiles,
} from "@/lib/geminiAnalysis";
import type { IncomingSlideThumbnail } from "@/lib/geminiAnalysis";
import { getRedisClient, isRedisConfigured } from "@/lib/redis";
import { getSessions } from "@/lib/syncStore";
import type { BlockedChunkNotice, TranscriptSegment } from "@/lib/types";

// "자료 추가해서 다시 분석": rebuilds an analyzed session's lecture note from
// its EXISTING transcript plus newly attached reference material (for when
// the lecture slides/textbook weren't attached the first time). No audio is
// read and no speech-to-text runs — only the analysis step, with the same
// prompt as a normal analysis (lib/analysisPrompt.ts), so the attached
// material becomes the note's backbone and the professor's words still
// override it (the Core Backbone / Verbal Override rules).
//
// Same job shape as app/api/transcribe-and-summarize: POST starts the work in
// after() and returns a jobId; the client polls transcribe-and-summarize's
// GET ?jobId= (shared `job:{id}` record). The result carries the new
// summary/lectureNote/checklist; the client keeps its own transcript.

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MAX_REFERENCE_FILES = 5;
const MAX_SLIDE_THUMBNAILS = 120;

type MergeRequestBody = {
  sessionId?: unknown;
  referenceBlobs?: unknown;
  slideThumbnails?: unknown;
  keywords?: unknown;
  bookmarks?: unknown;
  // The browser's own copy — used only when the transcript can't be read
  // from the cloud (signed out, or the session was never synced).
  transcript?: unknown;
};

function isTranscriptSegment(value: unknown): value is TranscriptSegment {
  const s = value as Partial<TranscriptSegment> | null;
  return !!s && typeof s.text === "string" && typeof s.startMs === "number" && typeof s.endMs === "number";
}

// The transcript as saved in the cloud copy of this session (lib/syncStore.ts),
// for a signed-in user — the client pushes its latest copy right before
// calling this route, so it's current.
async function loadCloudTranscript(
  sessionId: string,
): Promise<{ transcript: TranscriptSegment[]; blockedChunks?: BlockedChunkNotice[] } | null> {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  const redis = getRedisClient();
  if (!email || !redis) return null;
  const [stored] = await getSessions(redis, email, [sessionId]);
  const transcript = stored?.aiResult?.transcript;
  if (!Array.isArray(transcript) || transcript.length === 0) return null;
  return { transcript, blockedChunks: stored?.aiResult?.blockedChunks };
}

async function runMergeJob(
  apiKey: string,
  jobId: string,
  transcript: TranscriptSegment[],
  blockedChunks: BlockedChunkNotice[] | undefined,
  referenceBlobs: BlobRef[],
  slideThumbnails: IncomingSlideThumbnail[],
  keywords: string[],
  bookmarks: IncomingBookmark[],
) {
  const ai = new GoogleGenAI({ apiKey });
  let uploadedReferences: GenAiFile[] = [];
  try {
    await reportStage(jobId, "새 자료를 AI에 올리는 중...");
    uploadedReferences = await uploadReferenceFiles(ai, apiKey, referenceBlobs);

    await reportStage(jobId, "기존 녹음 스크립트와 새 자료를 병합하여 단권화 중입니다...");
    const segments = transcriptToCheckpointSegments(transcript);
    const analysis = await callAnalysisWorker(
      ai,
      { kind: "transcript", text: segmentsToTranscriptText(segments) },
      uploadedReferences,
      slideThumbnails,
      keywords,
      formatBookmarkLines(bookmarks),
    );
    return buildAnalysisResult(segments, true, analysis, { blockedChunks });
  } catch (error) {
    console.error("[merge-material] job failed", { jobId, error });
    throw new Error(describeGeminiError(error));
  } finally {
    await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
    // Normally deleted right after upload to Gemini; covers a failure first.
    await Promise.all(referenceBlobs.map((ref) => del(ref.url).catch(() => {})));
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다. .env.local을 확인해주세요." },
      { status: 500 },
    );
  }
  if (!isRedisConfigured()) {
    return NextResponse.json(
      { error: "Redis 스토리지가 연결되어 있지 않습니다. Vercel 프로젝트에 Redis 통합을 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }

  let body: MergeRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
  if (!sessionId) {
    return NextResponse.json({ error: "세션 정보가 전달되지 않았습니다." }, { status: 400 });
  }

  const referenceBlobs = Array.isArray(body.referenceBlobs)
    ? body.referenceBlobs.map(parseBlobRef).filter((ref): ref is BlobRef => ref !== null)
    : [];
  if (referenceBlobs.length === 0) {
    return NextResponse.json({ error: "추가할 자료 파일이 전달되지 않았습니다." }, { status: 400 });
  }
  if (referenceBlobs.length > MAX_REFERENCE_FILES) {
    return NextResponse.json({ error: `자료는 최대 ${MAX_REFERENCE_FILES}개까지만 추가할 수 있습니다.` }, { status: 400 });
  }

  const slideThumbnails: IncomingSlideThumbnail[] = Array.isArray(body.slideThumbnails)
    ? body.slideThumbnails.filter(
        (item): item is IncomingSlideThumbnail =>
          !!item && typeof item.page === "number" && typeof item.dataUrl === "string",
      )
    : [];
  if (slideThumbnails.length > MAX_SLIDE_THUMBNAILS) {
    return NextResponse.json({ error: `슬라이드는 최대 ${MAX_SLIDE_THUMBNAILS}장까지만 참고할 수 있습니다.` }, { status: 400 });
  }
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const bookmarks: IncomingBookmark[] = Array.isArray(body.bookmarks)
    ? body.bookmarks.filter(
        (item): item is IncomingBookmark =>
          !!item && typeof item.id === "string" && typeof item.label === "string" && typeof item.atMs === "number",
      )
    : [];

  // Cloud copy first (signed in); the browser's copy otherwise.
  let source: "cloud" | "browser" = "cloud";
  let loaded = await loadCloudTranscript(sessionId).catch((error) => {
    console.error("[merge-material] reading cloud transcript failed", { sessionId, error });
    return null;
  });
  if (!loaded) {
    const fromBody = Array.isArray(body.transcript) ? body.transcript.filter(isTranscriptSegment) : [];
    if (fromBody.length > 0) {
      source = "browser";
      loaded = { transcript: fromBody };
    }
  }
  if (!loaded) {
    return NextResponse.json(
      { error: "이 노트의 음성 인식 스크립트를 찾을 수 없어 병합할 수 없습니다. 먼저 녹음을 분석해주세요." },
      { status: 404 },
    );
  }

  const jobId = crypto.randomUUID();
  await writeJobRecord(jobId, {
    status: "processing",
    createdAt: Date.now(),
    stage: "기존 녹음 스크립트와 새 자료를 병합하여 단권화 중입니다...",
  });
  const { transcript, blockedChunks } = loaded;

  after(async () => {
    try {
      const result = await runMergeJob(
        apiKey,
        jobId,
        transcript,
        blockedChunks,
        referenceBlobs,
        slideThumbnails,
        keywords,
        bookmarks,
      );
      await writeJobRecord(jobId, { status: "completed", createdAt: Date.now(), result });
    } catch (error) {
      await writeJobRecord(jobId, {
        status: "error",
        createdAt: Date.now(),
        error: error instanceof Error ? error.message : "자료 병합 분석에 실패했습니다.",
      });
    }
  });

  return NextResponse.json({ jobId, transcriptSource: source });
}

import { NextResponse, after } from "next/server";
import { del, get } from "@vercel/blob";
import {
  MAX_AUDIO_CHUNKS,
  buildAnalysisResult,
  deleteSttCheckpoint,
  formatBookmarkLines,
  parseBlobRef,
  readSttCheckpoint,
  reportStage,
  segmentsToTranscriptText,
  writeJobRecord,
  writeSttCheckpoint,
} from "@/lib/analysisPipeline";
import type { AnalysisResult, AudioChunkRef, BlobRef, CheckpointSegment, IncomingBookmark, SttCheckpoint } from "@/lib/analysisPipeline";
import { buildAnalysisPrompt } from "@/lib/analysisPrompt";
import { OPENAI_KEY_MISSING_MESSAGE, analyzeWithOpenAi, openAiApiKey, transcribeWithWhisper } from "@/lib/openai";
import { isRedisConfigured } from "@/lib/redis";
import type { UserApprovedFallbackReason } from "@/lib/types";

// The "OpenAI" analysis engine — only ever started by the user, from the
// retry button RecordingDetailView shows after a Gemini analysis fails
// (never automatically). An independent pipeline
// that never calls Gemini: Whisper transcribes, then a GPT model writes the
// lecture note from the transcript with the same prompt rules the Gemini
// engine uses (lib/analysisPrompt.ts). Same job-queue shape as
// app/api/transcribe-and-summarize: POST starts a job inside after() and
// returns its id; the client polls transcribe-and-summarize's
// GET ?jobId=, which reads the shared `job:{id}` record (lib/analysisPipeline.ts).
//
// Differences from the Gemini engine, by necessity:
// - Reference PDFs/text files arrive as text the browser extracted
//   (referenceTexts) rather than as files — gpt-4o-mini reads text far more
//   cheaply than page images. Image references are sent at low detail.
// - Slide thumbnails aren't sent; the note can still point at a slide via
//   the [슬라이드 N] page labels in the extracted text.

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MAX_REFERENCE_FILES = 5;
// Extracted reference text, all files combined — bounded since this is a
// public route, and generous for a few slide decks.
const MAX_REFERENCE_TEXT_CHARS = 300_000;
const MAX_REFERENCE_IMAGE_BYTES = 15 * 1024 * 1024;

type ReferenceText = { fileName: string; text: string };

type AnalyzeRequestBody = {
  sessionId?: unknown;
  audioBlob?: unknown;
  audioChunks?: unknown;
  referenceTexts?: unknown;
  referenceImages?: unknown;
  bookmarks?: unknown;
  keywords?: unknown;
  // Why the user approved this run (see AiResult.userApprovedFallback).
  fallbackReason?: unknown;
};

async function downloadBlob(ref: BlobRef): Promise<{ data: Blob; mimeType: string }> {
  const result = await get(ref.url, { access: "private" });
  if (!result) throw new Error("업로드된 파일을 찾을 수 없습니다. 다시 시도해주세요.");
  try {
    const data = await new Response(result.stream).blob();
    return { data, mimeType: result.blob.contentType || ref.mimeType };
  } finally {
    // The blob only ferries bytes from the browser to this Function.
    await del(ref.url).catch(() => {});
  }
}

// STAGE 1 — one Whisper call per piece (in parallel for a split recording),
// shifted back onto the recording's own timeline.
async function transcribe(
  apiKey: string,
  jobId: string,
  audioBlobRef: BlobRef | null,
  audioChunks: AudioChunkRef[],
  keywords: string[],
): Promise<CheckpointSegment[]> {
  const pieces: AudioChunkRef[] = audioChunks.length > 0 ? audioChunks : audioBlobRef ? [{ ...audioBlobRef, startMs: 0 }] : [];
  if (pieces.length === 0) {
    throw new Error("오디오 파일 업로드 정보가 없어 분석을 시작할 수 없습니다. 파일을 다시 첨부해주세요.");
  }
  await reportStage(jobId, pieces.length > 1 ? `OpenAI 음성 인식 중 (0/${pieces.length})...` : "OpenAI 음성 인식(Whisper) 중...");
  let done = 0;
  const results = await Promise.all(
    pieces.map(async (piece, index) => {
      try {
        const { data, mimeType } = await downloadBlob(piece);
        const { segments } = await transcribeWithWhisper(apiKey, data, piece.fileName, mimeType, keywords);
        done += 1;
        if (pieces.length > 1) await reportStage(jobId, `OpenAI 음성 인식 중 (${done}/${pieces.length})...`);
        const offsetSeconds = piece.startMs / 1000;
        return segments.map((segment) => ({
          ...segment,
          startSeconds: segment.startSeconds + offsetSeconds,
          endSeconds: segment.endSeconds + offsetSeconds,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 오류";
        throw new Error(pieces.length > 1 ? `오디오 조각 ${index + 1}/${pieces.length} 음성 인식 실패: ${message}` : message);
      }
    }),
  );
  return results.flat();
}

async function loadReferenceImages(refs: BlobRef[]): Promise<string[]> {
  const dataUrls: string[] = [];
  for (const ref of refs) {
    const { data, mimeType } = await downloadBlob(ref);
    if (data.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error(`참고 이미지 '${ref.fileName}'가 너무 큽니다.`);
    const base64 = Buffer.from(await data.arrayBuffer()).toString("base64");
    const imageType = mimeType.startsWith("image/") ? mimeType : ref.mimeType.startsWith("image/") ? ref.mimeType : "image/jpeg";
    dataUrls.push(`data:${imageType};base64,${base64}`);
  }
  return dataUrls;
}

// STAGE 2 — the shared lecture-note prompt over the finished transcript,
// plus the reference material in the forms this engine takes.
async function analyze(
  apiKey: string,
  jobId: string,
  checkpoint: SttCheckpoint,
  referenceTexts: ReferenceText[],
  referenceImages: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  fallbackReason: UserApprovedFallbackReason,
): Promise<AnalysisResult> {
  await reportStage(jobId, "OpenAI 강의노트 작성 중...");
  const imageDataUrls = await loadReferenceImages(referenceImages);
  const prompt = buildAnalysisPrompt(
    { kind: "transcript", text: checkpoint.transcriptText },
    referenceTexts.length + referenceImages.length,
    false,
    keywords,
    formatBookmarkLines(bookmarks),
  );

  const extra: string[] = [];
  if (referenceTexts.length > 0) {
    if (referenceTexts.some((ref) => ref.text.includes("[슬라이드 "))) {
      extra.push(
        "- [슬라이드 참조] 아래 참고자료 텍스트는 PDF 페이지마다 [슬라이드 N]으로 구분되어 있습니다(N은 전체 자료에서의 페이지 " +
          "번호). 도식·차트·표가 있는 페이지의 내용을 설명할 때는, 텍스트 설명을 먼저 완전하게 쓴 뒤 그 아래에 보조적으로 " +
          "`![슬라이드 N](slide_N)` 형식의 이미지 플레이스홀더를 넣을 수 있습니다. 텍스트뿐인 페이지에는 남용하지 마세요.",
      );
    }
    extra.push(
      "",
      "[강의 참고자료 텍스트] (첨부된 PDF·텍스트 파일에서 추출한 글자입니다 — 글자 색·형광펜 같은 시각적 강조 정보는 " +
        "포함되어 있지 않습니다.)",
      ...referenceTexts.map((ref) => `--- ${ref.fileName} ---\n${ref.text}`),
    );
  }
  if (imageDataUrls.length > 0) {
    extra.push("", `[참고 이미지] 이 텍스트 다음에 강의 참고 이미지 ${imageDataUrls.length}장이 첨부되어 있습니다.`);
  }
  const userPrompt = extra.length > 0 ? `${prompt.userPrompt}\n${extra.join("\n")}` : prompt.userPrompt;

  console.log("[transcribe-openai] calling OpenAI (analysis)", {
    transcriptChars: checkpoint.transcriptText.length,
    referenceTextChars: referenceTexts.reduce((sum, ref) => sum + ref.text.length, 0),
    referenceImageCount: imageDataUrls.length,
    promptChars: userPrompt.length,
  });
  const raw = await analyzeWithOpenAi(apiKey, prompt.systemInstruction, userPrompt, imageDataUrls);
  return buildAnalysisResult(checkpoint.segments, true, raw, { engine: "openai", userApprovedFallback: fallbackReason });
}

async function runOpenAiJob(
  apiKey: string,
  jobId: string,
  sessionId: string,
  audioBlobRef: BlobRef | null,
  audioChunks: AudioChunkRef[],
  referenceTexts: ReferenceText[],
  referenceImages: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  fallbackReason: UserApprovedFallbackReason,
): Promise<AnalysisResult> {
  try {
    let checkpoint = await readSttCheckpoint(sessionId, "openai");
    if (checkpoint) {
      await reportStage(jobId, "OpenAI 강의노트 작성 중... (음성 인식 결과 재사용)");
    } else {
      const segments = await transcribe(apiKey, jobId, audioBlobRef, audioChunks, keywords);
      if (segments.length === 0) {
        return buildAnalysisResult([], false, {}, { engine: "openai", userApprovedFallback: fallbackReason });
      }
      checkpoint = { createdAt: Date.now(), transcriptText: segmentsToTranscriptText(segments), segments, hasSpeech: true };
      // Same STAGE 1 checkpoint idea as the Gemini engine — a stage-2
      // failure (e.g. the note hitting the model's output cap) shouldn't
      // cost a second round of Whisper on retry.
      await writeSttCheckpoint(sessionId, "openai", checkpoint);
    }
    return await analyze(apiKey, jobId, checkpoint, referenceTexts, referenceImages, bookmarks, keywords, fallbackReason);
  } finally {
    // Normally already deleted right after download; covers pieces a
    // failure kept us from reaching.
    const leftovers = [...audioChunks, ...(audioBlobRef ? [audioBlobRef] : []), ...referenceImages];
    await Promise.all(leftovers.map((ref) => del(ref.url).catch(() => {})));
  }
}

function parseReferenceTexts(raw: unknown): ReferenceText[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const refs: ReferenceText[] = [];
  for (const item of raw) {
    const ref = item as { fileName?: unknown; text?: unknown } | null;
    if (!ref || typeof ref.fileName !== "string" || typeof ref.text !== "string") return null;
    refs.push({ fileName: ref.fileName, text: ref.text });
  }
  return refs;
}

export async function POST(request: Request) {
  const apiKey = openAiApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: OPENAI_KEY_MISSING_MESSAGE }, { status: 503 });
  }
  if (!isRedisConfigured()) {
    return NextResponse.json(
      { error: "Redis 스토리지가 연결되어 있지 않습니다. Vercel 프로젝트에 Redis 통합을 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }

  let body: AnalyzeRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
  if (!sessionId) {
    return NextResponse.json({ error: "세션 정보가 전달되지 않았습니다." }, { status: 400 });
  }

  const audioBlobRef = body.audioBlob ? parseBlobRef(body.audioBlob) : null;
  const rawChunks = Array.isArray(body.audioChunks) ? body.audioChunks : [];
  if (rawChunks.length > MAX_AUDIO_CHUNKS) {
    return NextResponse.json({ error: `오디오 조각은 최대 ${MAX_AUDIO_CHUNKS}개까지 지원합니다.` }, { status: 400 });
  }
  const audioChunks: AudioChunkRef[] = [];
  for (const raw of rawChunks) {
    const ref = parseBlobRef(raw);
    const startMs = (raw as { startMs?: unknown } | null)?.startMs;
    if (!ref || typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0) {
      return NextResponse.json({ error: "오디오 조각 정보가 올바르지 않습니다." }, { status: 400 });
    }
    audioChunks.push({ ...ref, startMs });
  }
  if (!audioBlobRef && audioChunks.length === 0 && !(await readSttCheckpoint(sessionId, "openai"))) {
    return NextResponse.json(
      { error: "오디오 파일 업로드 정보가 전달되지 않았습니다. 파일을 다시 첨부해주세요." },
      { status: 400 },
    );
  }

  const referenceTexts = parseReferenceTexts(body.referenceTexts);
  if (!referenceTexts) {
    return NextResponse.json({ error: "참고자료 텍스트 형식이 올바르지 않습니다." }, { status: 400 });
  }
  if (referenceTexts.reduce((sum, ref) => sum + ref.text.length, 0) > MAX_REFERENCE_TEXT_CHARS) {
    return NextResponse.json({ error: "참고자료 텍스트가 너무 깁니다." }, { status: 413 });
  }
  const referenceImages = Array.isArray(body.referenceImages)
    ? body.referenceImages.map(parseBlobRef).filter((ref): ref is BlobRef => ref !== null)
    : [];
  if (referenceTexts.length + referenceImages.length > MAX_REFERENCE_FILES) {
    return NextResponse.json(
      { error: `참고자료는 최대 ${MAX_REFERENCE_FILES}개까지만 첨부할 수 있습니다.` },
      { status: 400 },
    );
  }

  const bookmarks: IncomingBookmark[] = Array.isArray(body.bookmarks)
    ? body.bookmarks.filter(
        (item): item is IncomingBookmark =>
          !!item && typeof item.id === "string" && typeof item.label === "string" && typeof item.atMs === "number",
      )
    : [];
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  const fallbackReason: UserApprovedFallbackReason = body.fallbackReason === "policy" ? "policy" : "error";

  const jobId = crypto.randomUUID();
  await writeJobRecord(jobId, { status: "processing", createdAt: Date.now() });

  after(async () => {
    try {
      const result = await runOpenAiJob(
        apiKey,
        jobId,
        sessionId,
        audioBlobRef,
        audioChunks,
        referenceTexts,
        referenceImages,
        bookmarks,
        keywords,
        fallbackReason,
      );
      await writeJobRecord(jobId, { status: "completed", createdAt: Date.now(), result });
      await deleteSttCheckpoint(sessionId, "openai");
    } catch (error) {
      console.error("[transcribe-openai] job failed", { jobId, error });
      await writeJobRecord(jobId, {
        status: "error",
        createdAt: Date.now(),
        error: error instanceof Error ? error.message : "OpenAI 분석에 실패했습니다.",
      });
    }
  });

  return NextResponse.json({ jobId });
}

// ?status=1 -> { configured } (whether the retry button can offer OpenAI)
// ?checkpointFor=<sessionId> -> { hasCheckpoint } (OpenAI's own STT checkpoint)
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("status") === "1") {
    return NextResponse.json({ configured: openAiApiKey() !== null });
  }
  const checkpointFor = url.searchParams.get("checkpointFor");
  if (checkpointFor) {
    if (!isRedisConfigured()) return NextResponse.json({ hasCheckpoint: false });
    return NextResponse.json({ hasCheckpoint: (await readSttCheckpoint(checkpointFor, "openai")) !== null });
  }
  return NextResponse.json({ error: "지원하지 않는 요청입니다." }, { status: 400 });
}

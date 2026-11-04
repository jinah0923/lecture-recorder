import { NextResponse } from "next/server";
import { del, get } from "@vercel/blob";
import { GoogleGenAI } from "@google/genai";
import type { File as GenAiFile } from "@google/genai";
import {
  normalizeSttSegments,
  parseBlobRef,
  readSttCheckpoint,
  segmentsToTranscriptText,
  writeSttCheckpoint,
} from "@/lib/analysisPipeline";
import type { CheckpointSegment } from "@/lib/analysisPipeline";
import { PolicyBlockedError } from "@/lib/gemini";
import {
  deleteUploadedFile,
  describeGeminiError,
  downloadAndUploadToGemini,
  waitForFileActive,
} from "@/lib/geminiAnalysis";
import { blockedChunkTranscriptText } from "@/lib/geminiMessages";
import { callSttWorker } from "@/lib/geminiStt";
import { runWithJobDeadline } from "@/lib/jobDeadline";
import { OPENAI_KEY_MISSING_MESSAGE, openAiApiKey, transcribeWithWhisper } from "@/lib/openai";
import { isRedisConfigured } from "@/lib/redis";
import type { AnalysisEngine, BlockedChunkNotice } from "@/lib/types";

// Speech-to-text for ONE piece of a long recording, plus storing the
// stitched result. The browser splits the recording into ~10-minute pieces
// (lib/audioChunking.ts) and calls this once per piece, one after another
// (lib/chunkedTranscription.ts) — so each piece gets its own Function
// invocation and its own 300s budget, instead of every piece plus the note
// sharing one job's 300s. Then:
//   { action: "finalize", … } writes the whole transcript as the session's
//   STT checkpoint (Redis), and the client starts the regular analysis job,
//   which finds the checkpoint and goes straight to writing the note.
//
// A piece is answered directly (200 + its segments, already shifted onto
// the recording's timeline) — a 10-minute piece transcribes in well under a
// minute, so no job/polling is needed here.

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Generous for a multi-hour lecture's transcript, still bounded.
const MAX_TRANSCRIPT_CHARS = 2_000_000;
const MAX_SEGMENTS = 20_000;

type PieceRequest = {
  engine?: unknown;
  sessionId?: unknown;
  chunk?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  chunkIndex?: unknown;
  chunkCount?: unknown;
  keywords?: unknown;
};

type FinalizeRequest = {
  action: "finalize";
  engine?: unknown;
  sessionId?: unknown;
  segments?: unknown;
  blockedChunks?: unknown;
};

function parseEngine(value: unknown): AnalysisEngine {
  return value === "openai" ? "openai" : "gemini";
}

function isSegment(value: unknown): value is CheckpointSegment {
  const s = value as Partial<CheckpointSegment> | null;
  return (
    !!s &&
    typeof s.text === "string" &&
    typeof s.startSeconds === "number" &&
    Number.isFinite(s.startSeconds) &&
    typeof s.endSeconds === "number" &&
    Number.isFinite(s.endSeconds) &&
    (s.source === undefined || s.source === "blocked")
  );
}

function isBlockedChunkNotice(value: unknown): value is BlockedChunkNotice {
  const c = value as Partial<BlockedChunkNotice> | null;
  return !!c && typeof c.chunkIndex === "number" && typeof c.chunkCount === "number" && typeof c.startMs === "number";
}

async function transcribePieceWithGemini(
  apiKey: string,
  chunk: { url: string; fileName: string; mimeType: string },
  index: number,
): Promise<{ hasSpeech: boolean; segments: CheckpointSegment[]; blocked: boolean }> {
  const ai = new GoogleGenAI({ apiKey });
  let file: GenAiFile | null = null;
  try {
    // Also deletes the piece's blob once Gemini has the bytes.
    file = await waitForFileActive(ai, await downloadAndUploadToGemini(apiKey, chunk.url, `chunk-${index}`, chunk.mimeType || "audio/webm"));
    try {
      const result = await callSttWorker(ai, file);
      const segments = normalizeSttSegments(result.script);
      return { hasSpeech: result.hasSpeech === true && segments.length > 0, segments, blocked: false };
    } catch (error) {
      // One refused stretch shouldn't cost the whole lecture — it becomes a
      // marked gap in the transcript (same as the single-job path).
      if (error instanceof PolicyBlockedError) return { hasSpeech: false, segments: [], blocked: true };
      throw error;
    }
  } finally {
    if (file) await deleteUploadedFile(ai, file);
    await del(chunk.url).catch(() => {});
  }
}

async function transcribePieceWithWhisper(
  apiKey: string,
  chunk: { url: string; fileName: string; mimeType: string },
  keywords: string[],
): Promise<{ hasSpeech: boolean; segments: CheckpointSegment[]; blocked: boolean }> {
  try {
    const result = await get(chunk.url, { access: "private" });
    if (!result) throw new Error("업로드된 오디오 조각을 찾을 수 없습니다. 다시 시도해주세요.");
    const data = await new Response(result.stream).blob();
    const { hasSpeech, segments } = await transcribeWithWhisper(
      apiKey,
      data,
      chunk.fileName,
      result.blob.contentType || chunk.mimeType,
      keywords,
    );
    return { hasSpeech, segments, blocked: false };
  } finally {
    await del(chunk.url).catch(() => {});
  }
}

async function handlePiece(body: PieceRequest) {
  const engine = parseEngine(body.engine);
  const chunk = parseBlobRef(body.chunk);
  const startMs = typeof body.startMs === "number" && body.startMs >= 0 ? body.startMs : null;
  const endMs = typeof body.endMs === "number" && body.endMs >= 0 ? body.endMs : null;
  const chunkIndex = typeof body.chunkIndex === "number" ? body.chunkIndex : 0;
  const chunkCount = typeof body.chunkCount === "number" ? body.chunkCount : 1;
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  if (!chunk || startMs === null) {
    return NextResponse.json({ error: "오디오 조각 정보가 올바르지 않습니다." }, { status: 400 });
  }

  const label = `오디오 조각 ${chunkIndex + 1}/${chunkCount}`;
  try {
    const result = await runWithJobDeadline(maxDuration, async () => {
      if (engine === "openai") {
        const apiKey = openAiApiKey();
        if (!apiKey) throw new Error(OPENAI_KEY_MISSING_MESSAGE);
        return transcribePieceWithWhisper(apiKey, chunk, keywords);
      }
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("서버에 GEMINI_API_KEY가 설정되어 있지 않습니다.");
      return transcribePieceWithGemini(apiKey, chunk, chunkIndex);
    });

    const offsetSeconds = startMs / 1000;
    const segments: CheckpointSegment[] = result.blocked
      ? [
          {
            startSeconds: offsetSeconds,
            endSeconds: endMs !== null ? endMs / 1000 : offsetSeconds,
            text: blockedChunkTranscriptText({ chunkIndex: chunkIndex + 1, chunkCount, startMs, endMs }),
            source: "blocked",
          },
        ]
      : result.segments.map((segment) => ({
          ...segment,
          startSeconds: segment.startSeconds + offsetSeconds,
          endSeconds: segment.endSeconds + offsetSeconds,
        }));
    console.log("[transcribe-chunk] piece done", { engine, chunkIndex, chunkCount, segments: segments.length, blocked: result.blocked });
    return NextResponse.json({ segments, hasSpeech: result.hasSpeech, blocked: result.blocked });
  } catch (error) {
    console.error("[transcribe-chunk] piece failed", { engine, chunkIndex, chunkCount, error });
    const message = engine === "gemini" ? describeGeminiError(error) : error instanceof Error ? error.message : "음성 인식에 실패했습니다.";
    return NextResponse.json({ error: `${label} 음성 인식 실패: ${message}` }, { status: 502 });
  }
}

async function handleFinalize(body: FinalizeRequest) {
  if (!isRedisConfigured()) {
    return NextResponse.json(
      { error: "Redis 스토리지가 연결되어 있지 않습니다. Vercel 프로젝트에 Redis 통합을 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }
  const engine = parseEngine(body.engine);
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
  const segments = Array.isArray(body.segments) ? body.segments : null;
  if (!sessionId || !segments || segments.length === 0 || segments.length > MAX_SEGMENTS || !segments.every(isSegment)) {
    return NextResponse.json({ error: "음성 인식 결과가 올바르지 않습니다. 다시 시도해주세요." }, { status: 400 });
  }
  const transcriptText = segmentsToTranscriptText(segments);
  if (transcriptText.length > MAX_TRANSCRIPT_CHARS) {
    return NextResponse.json({ error: "음성 인식 결과가 너무 깁니다." }, { status: 413 });
  }
  const blockedChunks = Array.isArray(body.blockedChunks) ? body.blockedChunks.filter(isBlockedChunkNotice) : [];
  await writeSttCheckpoint(sessionId, engine, {
    createdAt: Date.now(),
    transcriptText,
    segments,
    hasSpeech: true,
    ...(blockedChunks.length > 0 ? { blockedChunks } : {}),
  });
  // writeSttCheckpoint is best-effort; the analysis job relies on this one.
  if (!(await readSttCheckpoint(sessionId, engine))) {
    return NextResponse.json({ error: "전체 스크립트를 서버에 저장하지 못했습니다. 잠시 후 다시 시도해주세요." }, { status: 503 });
  }
  console.log("[transcribe-chunk] transcript stored", { engine, sessionId, segments: segments.length, chars: transcriptText.length });
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  let body: PieceRequest | FinalizeRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }
  return (body as FinalizeRequest).action === "finalize" ? handleFinalize(body as FinalizeRequest) : handlePiece(body);
}

// Server-side pieces shared by both analysis engines —
// app/api/transcribe-and-summarize (Gemini) and app/api/transcribe-openai
// (OpenAI, started only from the retry button RecordingDetailView shows after
// a failed Gemini analysis). Both write the same
// job record under `job:{jobId}`, so the client polls either one through
// transcribe-and-summarize's GET ?jobId= and gets the same result shape.

import { stripMarkTags } from "@/lib/inlineMarkdown";
import { getRedisClient } from "@/lib/redis";
import type {
  AiResult,
  AnalysisEngine,
  BlockedChunkNotice,
  ChecklistItem,
  TranscriptSegment,
  UserApprovedFallbackReason,
} from "@/lib/types";

export type AnalysisResult = AiResult;

export type IncomingBookmark = {
  id: string;
  label: string;
  atMs: number;
};

export type BlobRef = { url: string; fileName: string; mimeType: string };
// One browser-made slice of a long recording (see lib/audioChunking.ts).
export type AudioChunkRef = BlobRef & { startMs: number };

// Long recordings are split into ~20-minute pieces IN THE BROWSER
// (lib/audioChunking.ts, ffmpeg.wasm) before upload — neither route ever
// splits audio itself (no server-side ffmpeg binary exists on Vercel's
// runtime). Cap guards these public routes against absurd inputs;
// 12 x 20min = 4h.
export const MAX_AUDIO_CHUNKS = 12;

export function parseBlobRef(raw: unknown): BlobRef | null {
  if (!raw || typeof raw !== "object") return null;
  const ref = raw as { url?: unknown; fileName?: unknown; mimeType?: unknown };
  const url = typeof ref.url === "string" ? ref.url : "";
  const fileName = typeof ref.fileName === "string" ? ref.fileName : "";
  const mimeType = typeof ref.mimeType === "string" ? ref.mimeType : "";
  if (!url || !fileName) return null;
  return { url, fileName, mimeType };
}

// The shape stored in Redis under `job:{jobId}` — see writeJobRecord/
// readJobRecord below. `stage` is optional, human-readable progress text
// (e.g. "청크 2/5 처리 중...") updated as a long, chunked job moves through
// each step — purely informational for the client's progress UI, not
// something correctness depends on.
export type JobRecord =
  | { status: "processing"; createdAt: number; stage?: string }
  | { status: "completed"; createdAt: number; result: AnalysisResult }
  | { status: "error"; createdAt: number; error: string };

// How long a job record survives in Redis — generous enough that reopening
// the app well after a background/close still finds the result, bounded so
// stale jobs don't accumulate forever.
const JOB_TTL_SECONDS = 24 * 60 * 60;

function jobKeyFor(jobId: string): string {
  return `job:${jobId}`;
}

export async function writeJobRecord(jobId: string, record: JobRecord): Promise<void> {
  const redis = getRedisClient();
  await redis?.set(jobKeyFor(jobId), JSON.stringify(record), "EX", JOB_TTL_SECONDS);
}

export async function readJobRecord(jobId: string): Promise<JobRecord | null> {
  const redis = getRedisClient();
  const raw = await redis?.get(jobKeyFor(jobId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

// Updates only the progress text on an in-flight job, preserving the
// original createdAt — the client's own poll timeout (see
// lib/analysisJob.ts) measures elapsed time from that original value, so
// this must never reset it the way a plain writeJobRecord("processing", ...)
// call with Date.now() would. Best-effort: a failed progress update doesn't
// fail the job itself, it just means the client sees a less specific
// "분석 중..." label until the next successful one.
export async function reportStage(jobId: string, stage: string): Promise<void> {
  try {
    const existing = await readJobRecord(jobId);
    const createdAt = existing?.status === "processing" ? existing.createdAt : Date.now();
    await writeJobRecord(jobId, { status: "processing", createdAt, stage });
  } catch (error) {
    console.error("[analysis-job] failed to report stage", { jobId, stage, error });
  }
}

// A single normalized STT segment, used both to build the checkpoint's
// transcript text and to feed buildAnalysisResult on a resumed retry — see
// SttCheckpoint below.
// source "blocked" = placeholder for a chunk Gemini refused (see
// transcribe-and-summarize's runChunkedAnalysisJob).
export type CheckpointSegment = { startSeconds: number; endSeconds: number; text: string; source?: "blocked" };

// STAGE 1 (STT) checkpoint — written the moment transcription finishes,
// independent of whether STAGE 2 (LLM analysis) that follows ever succeeds.
// Keyed by sessionId (sttCheckpointKeyFor below), not jobId, so a later
// retry's fresh POST/job can find it and skip STT entirely. Only ever
// written when hasSpeech is true — a no-speech result completes the whole
// job in one step with nothing worth checkpointing.
export type SttCheckpoint = {
  createdAt: number;
  transcriptText: string;
  segments: CheckpointSegment[];
  hasSpeech: true;
  // Carried so a resumed retry still reports which stretches were skipped.
  blockedChunks?: BlockedChunkNotice[];
};

// How long a STAGE 1 (STT) checkpoint survives in Redis, keyed by sessionId
// (not jobId — a checkpoint must outlive the specific job attempt that
// created it, since its whole purpose is to be found again by a LATER,
// separate POST/job when the user retries after a stage-2 failure). 24h
// mirrors JOB_TTL_SECONDS — generous for "come back later and retry"
// without keeping (potentially large) transcript text in Redis forever.
const STT_CHECKPOINT_TTL_SECONDS = 24 * 60 * 60;

// Separate keys per engine, so retrying with one engine never resumes from
// a transcript the other engine produced. The Gemini key keeps its original
// name so checkpoints written before this split are still found.
function sttCheckpointKeyFor(sessionId: string, engine: AnalysisEngine): string {
  return engine === "openai" ? `stt-checkpoint:openai:${sessionId}` : `stt-checkpoint:${sessionId}`;
}

export async function writeSttCheckpoint(
  sessionId: string,
  engine: AnalysisEngine,
  checkpoint: SttCheckpoint,
): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis?.set(sttCheckpointKeyFor(sessionId, engine), JSON.stringify(checkpoint), "EX", STT_CHECKPOINT_TTL_SECONDS);
  } catch (error) {
    // Best-effort, like reportStage — a failed checkpoint write shouldn't
    // fail the job that's still in progress; it just means a future retry
    // (if this job later fails at stage 2) won't have anything to resume
    // from and will redo STT from scratch instead.
    console.error("[analysis-job] failed to write STT checkpoint", { sessionId, engine, error });
  }
}

export async function readSttCheckpoint(sessionId: string, engine: AnalysisEngine): Promise<SttCheckpoint | null> {
  const redis = getRedisClient();
  const raw = await redis?.get(sttCheckpointKeyFor(sessionId, engine));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SttCheckpoint;
  } catch {
    return null;
  }
}

export async function deleteSttCheckpoint(sessionId: string, engine: AnalysisEngine): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis?.del(sttCheckpointKeyFor(sessionId, engine));
  } catch (error) {
    // Non-critical — TTL cleans it up eventually either way, and a
    // completed job never reads this key again regardless.
    console.error("[analysis-job] failed to delete STT checkpoint", { sessionId, engine, error });
  }
}

export function formatTimestamp(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatBookmarkLines(bookmarks: IncomingBookmark[]): string {
  return bookmarks.map((bookmark) => `- [${formatTimestamp(bookmark.atMs)}] ${bookmark.label}`).join("\n");
}

// Occasionally the model double-escapes newlines inside a JSON string value
// (literal backslash+n instead of a real line break). Normalize defensively
// so downstream markdown rendering sees real newlines either way.
export function fixEscapedNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

// Turns a worker's raw script array into concrete numeric segments — shared
// by every checkpoint write path so a resumed retry sees the exact same
// segment shape regardless of how the original attempt transcribed.
export function normalizeSttSegments(rawScript: unknown): CheckpointSegment[] {
  const rawSegments = Array.isArray(rawScript) ? rawScript : [];
  return rawSegments.map((segment) => {
    const s = segment as { startSeconds?: unknown; endSeconds?: unknown; text?: unknown };
    return {
      startSeconds: Number(s.startSeconds ?? 0),
      endSeconds: Number(s.endSeconds ?? 0),
      text: typeof s.text === "string" ? s.text : "",
    };
  });
}

// The timestamped-line format every analysis worker reads the transcript in.
export function segmentsToTranscriptText(segments: CheckpointSegment[]): string {
  return segments.map((s) => `[${formatTimestamp(s.startSeconds * 1000)}] ${s.text}`).join("\n");
}

export type RawAnalysisResponse = { summary?: unknown; lectureNote?: unknown; checklist?: unknown };

const NO_SPEECH_TRANSCRIPT = "감지된 음성 내용이 없습니다.";
const NO_SPEECH_SUMMARY = "오디오에서 명확한 강의 음성을 찾을 수 없습니다.";
const NO_SPEECH_NOTE = "오디오에서 강의 내용을 확인할 수 없어 상세 강의노트를 생성하지 못했습니다.";

// Shared by every path — turns the two workers' raw JSON into the final
// typed result, applying the same no-speech short circuit and field
// normalization either way.
export function buildAnalysisResult(
  sttSegments: unknown,
  hasSpeechFlag: boolean,
  analysisResult: RawAnalysisResponse,
  options: {
    blockedChunks?: BlockedChunkNotice[];
    engine?: AnalysisEngine;
    userApprovedFallback?: UserApprovedFallbackReason;
  } = {},
): AnalysisResult {
  const engine = {
    ...(options.engine === "openai" ? { engine: "openai" as const } : {}),
    ...(options.userApprovedFallback ? { userApprovedFallback: options.userApprovedFallback } : {}),
  };
  const rawSegments = Array.isArray(sttSegments) ? sttSegments : [];
  const hasSpeech = hasSpeechFlag && rawSegments.length > 0;

  if (!hasSpeech) {
    return {
      transcript: [{ id: "seg-0", startMs: 0, endMs: 0, text: NO_SPEECH_TRANSCRIPT }],
      fullText: NO_SPEECH_TRANSCRIPT,
      summary: NO_SPEECH_SUMMARY,
      lectureNote: NO_SPEECH_NOTE,
      checklist: [],
      ...engine,
    };
  }

  const transcript: TranscriptSegment[] = rawSegments.map((segment, index) => {
    const s = segment as { startSeconds?: unknown; endSeconds?: unknown; text?: unknown; source?: unknown };
    return {
      id: `seg-${index}`,
      startMs: Math.round(Number(s.startSeconds ?? 0) * 1000),
      endMs: Math.round(Number(s.endSeconds ?? 0) * 1000),
      text: typeof s.text === "string" ? fixEscapedNewlines(s.text.trim()) : "",
      ...(s.source === "blocked" ? { source: "blocked" as const } : {}),
    };
  });

  const fullText = transcript.map((segment) => segment.text).join(" ").trim();
  const summary = typeof analysisResult.summary === "string" ? fixEscapedNewlines(analysisResult.summary.trim()) : "";
  const lectureNote =
    typeof analysisResult.lectureNote === "string" ? fixEscapedNewlines(analysisResult.lectureNote.trim()) : "";
  const checklistTexts = Array.isArray(analysisResult.checklist)
    ? analysisResult.checklist.filter((item): item is string => typeof item === "string")
    : [];
  const checklist: ChecklistItem[] = checklistTexts.map((text, index) => ({
    id: `check-${index}`,
    // Checklist items render as plain text everywhere (ChecklistPanel, the
    // weekly feed, Notion to-dos), so a stray 형광펜 tag would show raw.
    text: stripMarkTags(fixEscapedNewlines(text)),
    done: false,
  }));

  const blockedChunks = options.blockedChunks ?? [];
  return {
    transcript,
    fullText,
    summary,
    lectureNote,
    checklist,
    ...(blockedChunks.length > 0 ? { blockedChunks } : {}),
    ...engine,
  };
}

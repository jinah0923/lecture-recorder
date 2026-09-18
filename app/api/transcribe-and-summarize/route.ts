import { NextResponse, after } from "next/server";
import { del, get } from "@vercel/blob";
import { ApiError, GoogleGenAI, Type, createPartFromBase64, createPartFromUri, createUserContent } from "@google/genai";
import type { File as GenAiFile, Part } from "@google/genai";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ffmpeg-static ships no type declarations; its default export is just a
// string path to the bundled platform binary (or null on an unsupported
// platform/arch — see its own index.js). TS falls back to `any` for it.
import ffmpegPath from "ffmpeg-static";
import { getRedisClient, isRedisConfigured } from "@/lib/redis";

// Node.js, not Edge — this route now talks to Redis via ioredis (see
// lib/redis.ts) for job tracking, and ioredis needs a real TCP socket
// (node:net/tls), which Edge Runtime's isolate doesn't expose at all. The
// earlier reason for Edge here — keeping a long SSE response streaming
// without Vercel's proxy or the browser killing an idle connection — no
// longer applies either: see the architecture note below.
export const runtime = "nodejs";
// Long lectures (2-3h) mean the background job (see after() in POST) can
// run well past a few minutes. 300s is Vercel Hobby's actual maximum for a
// Function's total duration on the Node.js runtime too (confirmed against
// https://vercel.com/docs/functions/limitations, checked 2026-08 — Hobby's
// default AND ceiling are both 300s regardless of runtime). There's no
// larger number to put here on this plan — a plan upgrade is the only way
// to raise this further for very long recordings.
export const maxDuration = 300;
// This route never caches (always fresh Gemini work) — opt out of static
// optimization explicitly rather than relying on Next's implicit dynamic
// detection.
export const dynamic = "force-dynamic";

// Architecture: async job queue, not a held-open request.
//
// Mobile browsers aggressively suspend a backgrounded tab's network
// connections — switching away from the app mid-analysis (or the OS just
// deciding to reclaim the tab) killed the in-flight request outright and
// surfaced as "network error" client-side, no matter how well-behaved the
// server's own response was (this app had already gone through an Edge +
// SSE-streaming iteration specifically to dodge server/proxy-side idle-
// connection kills — see git history — but that never addressed the client
// connection itself being suspended, which is a different failure mode
// streaming can't fix).
//
// So the request/response lifecycle here is now deliberately short:
// POST creates a job, kicks off the real work via after() (Next.js's
// primitive for continuing work past the point the response was sent —
// Vercel implements it with waitUntil(), bounded by the same maxDuration
// above), and returns just a jobId, fast. The client never holds a
// connection open for the actual analysis at all — instead it polls GET
// with that jobId (see lib/analysisJob.ts), and RecordingDetailView.tsx
// persists the jobId to localStorage so a closed/backgrounded/reopened tab
// can resume polling and safely pick up whatever Redis has, including a
// result that finished while nobody was watching.
//
// Audio/reference files still never touch this Function's own request body
// (see the Vercel Blob relay below) — that part of the architecture is
// unchanged, just no longer entangled with the connection-liveness problem.

type IncomingBookmark = {
  id: string;
  label: string;
  atMs: number;
};

type TranscriptSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

type IncomingSlideThumbnail = {
  page: number;
  dataUrl: string;
};

type IncomingBlobRef = {
  url?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
};

type BlobRef = { url: string; fileName: string; mimeType: string };

type AnalyzeRequestBody = {
  // Identifies the recording across separate job attempts — required so a
  // retry can find its predecessor's STT checkpoint (see SttCheckpoint).
  // Not a jobId: a fresh jobId is minted per POST regardless, but the
  // checkpoint has to outlive any single attempt to be resumable at all.
  sessionId?: unknown;
  // Optional when a checkpoint already exists for this sessionId — a
  // checkpoint resume never touches the original audio (see
  // runAnalysisOnlyFromCheckpoint), so the client skips re-uploading it
  // entirely on retry (see lib/analysisJob.ts's checkSttCheckpoint).
  audioBlob?: IncomingBlobRef;
  referenceBlobs?: unknown;
  bookmarks?: unknown;
  keywords?: unknown;
  slideThumbnails?: unknown;
  // Client-measured, not re-probed server-side (see CHUNK_THRESHOLD_MS below)
  // — this only ever drives a coarse "should we chunk" decision and how many
  // ~20-minute pieces to cut, not anything requiring frame accuracy, so
  // trusting the browser's own duration reading (already used elsewhere for
  // the session's durationMs) is cheap and good enough.
  durationMs?: unknown;
};

type AnalysisResult = {
  transcript: TranscriptSegment[];
  fullText: string;
  summary: string;
  lectureNote: string;
  checklist: ChecklistItem[];
};

// The shape stored in Redis under `job:{jobId}` — see writeJobRecord/
// readJobRecord below. `stage` is optional, human-readable progress text
// (e.g. "청크 2/5 처리 중...") updated as a long, chunked job moves through
// each step — purely informational for the client's progress UI, not
// something correctness depends on.
type JobRecord =
  | { status: "processing"; createdAt: number; stage?: string }
  | { status: "completed"; createdAt: number; result: AnalysisResult }
  | { status: "error"; createdAt: number; error: string };

// A single normalized STT segment, used both to build the checkpoint's
// transcript text and to feed buildAnalysisResult on a resumed retry — see
// SttCheckpoint below.
type CheckpointSegment = { startSeconds: number; endSeconds: number; text: string };

// STAGE 1 (STT) checkpoint — written the moment transcription finishes
// (see runDirectAnalysisJob/runChunkedAnalysisJob), independent of whether
// STAGE 2 (LLM analysis) that follows ever succeeds. Keyed by sessionId
// (sttCheckpointKeyFor below), not jobId, so a later retry's fresh POST/job
// can find it and skip STT entirely (runAnalysisOnlyFromCheckpoint). Only
// ever written when hasSpeech is true — a no-speech result completes the
// whole job in one step with nothing worth checkpointing (see both run*
// functions' early returns).
type SttCheckpoint = {
  createdAt: number;
  transcriptText: string;
  segments: CheckpointSegment[];
  hasSpeech: true;
};

const MODEL = "gemini-3.6-flash";
// Mirrors ReferenceDocDropzone's own cap (components/ReferenceDocDropzone.tsx)
// — enforced here too since the client-side limit is only a UX nicety, not
// something this publicly reachable route can rely on by itself.
const MAX_REFERENCE_FILES = 5;
// How long to wait for an uploaded file to finish Gemini-side processing
// (ACTIVE) before giving up.
const FILE_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
// How long a job record survives in Redis — generous enough that reopening
// the app well after a background/close still finds the result, bounded so
// stale jobs don't accumulate forever.
const JOB_TTL_SECONDS = 24 * 60 * 60;

// How long a STAGE 1 (STT) checkpoint survives in Redis, keyed by sessionId
// (not jobId — a checkpoint must outlive the specific job attempt that
// created it, since its whole purpose is to be found again by a LATER,
// separate POST/job when the user retries after a stage-2 failure). 24h
// mirrors JOB_TTL_SECONDS — generous for "come back later and retry"
// without keeping (potentially large) transcript text in Redis forever.
const STT_CHECKPOINT_TTL_SECONDS = 24 * 60 * 60;

// Above this, the raw audio never goes to Gemini as one file — see
// splitAudioFile/runChunkedAnalysisJob below. 30 minutes is comfortably
// under whatever a single STT call could plausibly handle within the 300s
// function budget on its own, so this is deliberately conservative rather
// than tuned to the exact edge of what fails.
const CHUNK_THRESHOLD_MS = 30 * 60 * 1000;
const CHUNK_DURATION_MS = 20 * 60 * 1000;

const NO_SPEECH_TRANSCRIPT = "감지된 음성 내용이 없습니다.";
const NO_SPEECH_SUMMARY = "오디오에서 명확한 강의 음성을 찾을 수 없습니다.";
const NO_SPEECH_NOTE = "오디오에서 강의 내용을 확인할 수 없어 상세 강의노트를 생성하지 못했습니다.";

// Split into two independent schemas/calls (see callSttWorker/callAnalysisWorker
// below) instead of one combined response — a single call sharing one
// maxOutputTokens budget across a 30min+ verbatim transcript AND a deep,
// textbook-length lecture note reliably ran out of budget mid-transcript.
// Separating them gives each its own full token budget.
const STT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    hasSpeech: {
      type: Type.BOOLEAN,
      description: "오디오에 사람이 말하는 강의 음성이 실제로 감지되었으면 true, 무음/배경음악/잡음뿐이면 false",
    },
    script: {
      type: Type.ARRAY,
      description:
        "발화 내용을 15~30초 분량의 자연스러운 1~2개 완성 문장 단위로 묶은 구간별 받아쓰기. 단어나 짧은 어절 단위로 잘게 쪼개지 말 것. 오디오 처음부터 끝까지 100% 빠짐없이.",
      items: {
        type: Type.OBJECT,
        properties: {
          startSeconds: { type: Type.NUMBER, description: "구간 시작 시각(초)" },
          endSeconds: { type: Type.NUMBER, description: "구간 종료 시각(초)" },
          text: { type: Type.STRING, description: "해당 구간(1~2문장)의 받아쓰기 텍스트" },
        },
        required: ["startSeconds", "endSeconds", "text"],
      },
    },
  },
  required: ["hasSpeech", "script"],
};

const ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description:
        "녹음 음성만을 기반으로 한 핵심 요약 3~5개를 '• '로 시작하는 글머리 기호 리스트로 작성 (마크다운, 줄글 문단 형태 금지)",
    },
    lectureNote: {
      type: Type.STRING,
      description:
        "강의 음성과 참고자료를 통합한 시험 대비용 상세 강의노트 (마크다운). 번호가 매겨진 대주제(## 1. ...) 구조, 본문은 일반 텍스트/불릿 기본, 강조가 필요한 항목에만 선택적으로 '> 🚨'/'> 🔥'/'> 🗣️' 콜아웃 사용",
    },
    checklist: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "학습자가 실천해야 할 과제/복습 체크리스트 문장 목록",
    },
  },
  required: ["summary", "lectureNote", "checklist"],
};

// Shared by both workers' system instructions — Gemini otherwise tends to
// reach for \rightarrow / $...$ style LaTeX for arrows and formulas, which
// this app's markdown renderer doesn't support and renders as broken raw
// syntax instead of the intended symbol.
const LATEX_BAN_RULE =
  "화살표나 기호를 작성할 때 절대 LaTeX 문법(예: \\rightarrow, $...$ 등 백슬래시 명령어나 달러 기호로 감싼 수식)을 " +
  "사용하지 마십시오. 반드시 일반 텍스트 기호(예: ->, =>, →, ≥, ≤, ±)만 사용하십시오.";

function formatTimestamp(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// "data:image/webp;base64,AAAA..." -> a Gemini inline-image Part. Slide
// thumbnails arrive this way (client-rendered canvas exports), never as an
// uploaded File, so they go in as inline base64 rather than through the
// Files API used for the audio/reference document.
function dataUrlToPart(dataUrl: string): Part | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return createPartFromBase64(match[2], match[1]);
}

// Occasionally the model double-escapes newlines inside a JSON string value
// (literal backslash+n instead of a real line break). Normalize defensively
// so downstream markdown rendering sees real newlines either way.
function fixEscapedNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

function describeGeminiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return `Gemini 모델(${MODEL})을 찾을 수 없습니다. 모델명이 올바른지, 이 API 키에서 사용 가능한 모델인지 확인해주세요. (${error.message})`;
    }
    if (error.status === 401 || error.status === 403) {
      return `Gemini API 인증에 실패했습니다. GEMINI_API_KEY가 유효한지 확인해주세요. (${error.message})`;
    }
    if (error.status === 429) {
      return "Google Gemini API 크레딧이 소진되었습니다. AI Studio에서 크레딧을 충전하거나 새 API 키를 등록해주세요.";
    }
    return `Gemini API 오류 (HTTP ${error.status}): ${error.message}`;
  }
  const message = error instanceof Error ? error.message : "AI 분석에 실패했습니다.";
  return `Gemini 분석 실패: ${message}`;
}

function parseBlobRef(raw: unknown): BlobRef | null {
  if (!raw || typeof raw !== "object") return null;
  const ref = raw as IncomingBlobRef;
  const url = typeof ref.url === "string" ? ref.url : "";
  const fileName = typeof ref.fileName === "string" ? ref.fileName : "";
  const mimeType = typeof ref.mimeType === "string" ? ref.mimeType : "";
  if (!url || !fileName) return null;
  return { url, fileName, mimeType };
}

function jobKeyFor(jobId: string): string {
  return `job:${jobId}`;
}

async function writeJobRecord(jobId: string, record: JobRecord): Promise<void> {
  const redis = getRedisClient();
  await redis?.set(jobKeyFor(jobId), JSON.stringify(record), "EX", JOB_TTL_SECONDS);
}

async function readJobRecord(jobId: string): Promise<JobRecord | null> {
  const redis = getRedisClient();
  const raw = await redis?.get(jobKeyFor(jobId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

// Updates only the progress text on an in-flight job (see runChunkedAnalysisJob),
// preserving the original createdAt — the client's own poll timeout (see
// lib/analysisJob.ts) measures elapsed time from that original value, so
// this must never reset it the way a plain writeJobRecord("processing", ...)
// call with Date.now() would. Best-effort: a failed progress update doesn't
// fail the job itself, it just means the client sees a less specific
// "분석 중..." label until the next successful one.
async function reportStage(jobId: string, stage: string): Promise<void> {
  try {
    const existing = await readJobRecord(jobId);
    const createdAt = existing?.status === "processing" ? existing.createdAt : Date.now();
    await writeJobRecord(jobId, { status: "processing", createdAt, stage });
  } catch (error) {
    console.error("[transcribe-and-summarize] failed to report stage", { jobId, stage, error });
  }
}

function sttCheckpointKeyFor(sessionId: string): string {
  return `stt-checkpoint:${sessionId}`;
}

async function writeSttCheckpoint(sessionId: string, checkpoint: SttCheckpoint): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis?.set(sttCheckpointKeyFor(sessionId), JSON.stringify(checkpoint), "EX", STT_CHECKPOINT_TTL_SECONDS);
  } catch (error) {
    // Best-effort, like reportStage — a failed checkpoint write shouldn't
    // fail the job that's still in progress; it just means a future retry
    // (if this job later fails at stage 2) won't have anything to resume
    // from and will redo STT from scratch instead.
    console.error("[transcribe-and-summarize] failed to write STT checkpoint", { sessionId, error });
  }
}

async function readSttCheckpoint(sessionId: string): Promise<SttCheckpoint | null> {
  const redis = getRedisClient();
  const raw = await redis?.get(sttCheckpointKeyFor(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SttCheckpoint;
  } catch {
    return null;
  }
}

async function deleteSttCheckpoint(sessionId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis?.del(sttCheckpointKeyFor(sessionId));
  } catch (error) {
    // Non-critical — TTL cleans it up eventually either way, and a
    // completed job never reads this key again regardless.
    console.error("[transcribe-and-summarize] failed to delete STT checkpoint", { sessionId, error });
  }
}

// Turns a worker's raw script array into concrete numeric segments — shared
// by the checkpoint write path (both run* functions) so a resumed retry
// (runAnalysisOnlyFromCheckpoint) sees the exact same segment shape either
// way, regardless of whether the original attempt was direct or chunked.
function normalizeSttSegments(rawScript: unknown): CheckpointSegment[] {
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

// Same timestamped-line format runChunkedAnalysisJob already used for its
// merged transcript — kept identical so the analysis worker sees the same
// shape of input whether it's reading a checkpointed transcript or a
// freshly-merged chunked one.
function segmentsToTranscriptText(segments: CheckpointSegment[]): string {
  return segments.map((s) => `[${formatTimestamp(s.startSeconds * 1000)}] ${s.text}`).join("\n");
}

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";
// Matches @google/genai's own chunk size for the same upload protocol.
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

// @google/genai's own `ai.files.upload()` sets a literal `Content-Length`
// header on each upload chunk request (see its uploadBlobInternal) — a name
// the Fetch spec lists as forbidden for scripts to set manually. Node's own
// fetch (undici) tolerates it in practice, but this hand-rolled version
// (proven under both Edge and Node during earlier iterations of this route)
// is kept as-is rather than reverted to the SDK call, since there's no
// upside to touching working upload code while restructuring everything
// else here.
async function uploadFileToGemini(
  apiKey: string,
  file: Blob,
  displayName: string,
  mimeType: string,
): Promise<GenAiFile> {
  const startResponse = await fetch(`${GEMINI_API_BASE_URL}/upload/v1beta/files?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({ file: { displayName } }),
  });
  if (!startResponse.ok) {
    throw new Error(`파일 업로드 세션을 시작하지 못했습니다 (HTTP ${startResponse.status}).`);
  }
  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("업로드 URL을 받지 못했습니다.");
  }

  let offset = 0;
  let finalFile: GenAiFile | undefined;
  while (offset < file.size) {
    const chunkSize = Math.min(UPLOAD_CHUNK_BYTES, file.size - offset);
    const chunk = file.slice(offset, offset + chunkSize);
    const isFinalChunk = offset + chunkSize >= file.size;

    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Command": isFinalChunk ? "upload, finalize" : "upload",
        "X-Goog-Upload-Offset": String(offset),
      },
      // No Content-Length header — fetch computes it from the Blob chunk itself.
      body: chunk,
    });
    if (!uploadResponse.ok) {
      throw new Error(`파일 업로드에 실패했습니다 (HTTP ${uploadResponse.status}).`);
    }
    offset += chunkSize;
    if (isFinalChunk) {
      const json = (await uploadResponse.json()) as { file?: GenAiFile };
      finalFile = json.file;
    }
  }

  if (!finalFile) {
    throw new Error("파일 업로드 응답을 확인하지 못했습니다.");
  }
  return finalFile;
}

// Reads a chunk file ffmpeg wrote to local disk (see splitAudioFile) and
// uploads it through the same resumable-upload path as everything else —
// chunks are typically small enough not to need the multi-chunk loop inside
// uploadFileToGemini to do more than a single pass, but reusing it keeps
// this consistent with the rest of the upload handling rather than a
// separate one-shot codepath.
async function uploadLocalFileToGemini(apiKey: string, filePath: string, displayName: string, mimeType: string): Promise<GenAiFile> {
  const buffer = await readFile(filePath);
  const blob = new Blob([buffer], { type: mimeType });
  return uploadFileToGemini(apiKey, blob, displayName, mimeType);
}

// Best-effort filename -> extension guess, falling back to the mime type's
// subtype. Only used to give ffmpeg's chunk output files a container that
// matches the source (see splitAudioFile) — `-c copy` needs the output
// container to actually be compatible with the input's codec, so a chunk
// has to keep the same container as the original file, not some fixed
// extension.
function guessAudioExtension(fileName: string, mimeType: string): string {
  const match = fileName.match(/\.([a-zA-Z0-9]+)$/);
  if (match) return match[1].toLowerCase();
  const subtype = mimeType.split("/")[1]?.split(";")[0];
  return subtype || "webm";
}

// Downloads a client-uploaded Vercel Blob straight to a local temp file
// (server-to-server — no CORS or Vercel body-size constraint applies here)
// rather than handing it to Gemini directly, since ffmpeg (splitAudioFile
// below) needs a real file on disk to read from. Only used on the chunked
// path — the direct (non-chunked) path still goes through
// downloadAndUploadToGemini below without ever touching disk.
async function downloadBlobToFile(blobUrl: string, destPath: string): Promise<void> {
  const blobResult = await get(blobUrl, { access: "private" });
  if (!blobResult) {
    throw new Error("업로드된 파일을 찾을 수 없습니다. 다시 시도해주세요.");
  }
  const arrayBuffer = await new Response(blobResult.stream).arrayBuffer();
  await writeFile(destPath, Buffer.from(arrayBuffer));
}

type AudioChunk = { path: string; startMs: number };

// Cuts [startMs, startMs + durationMs) out of inputPath into outputPath
// using the bundled static ffmpeg binary (ffmpeg-static), without
// re-encoding (-c copy) — fast, lossless, and avoids needing to know the
// right codec settings for whatever format the source audio happens to be.
// -ss before -i trades a little seek precision (it can snap to the nearest
// keyframe) for speed; a boundary landing a second or so off is harmless
// here since chunk transcripts are just concatenated afterward, not
// sample-diffed against anything.
async function runFfmpegChunk(inputPath: string, outputPath: string, startMs: number, durationMs: number): Promise<void> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg 실행 파일을 찾을 수 없습니다 (지원되지 않는 서버 플랫폼).");
  }
  try {
    // Vercel's file tracing occasionally ships a traced binary without the
    // executable bit intact — cheap to just always re-assert it rather than
    // find out at spawn time.
    await chmod(ffmpegPath, 0o755);
  } catch {
    // Already executable (the common case, e.g. local dev) — nothing to do.
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath as unknown as string, [
      "-y",
      "-ss",
      String(startMs / 1000),
      "-i",
      inputPath,
      "-t",
      String(durationMs / 1000),
      "-c",
      "copy",
      outputPath,
    ]);
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 청크 분할 실패 (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
}

// Splits a long audio file into CHUNK_DURATION_MS-sized pieces on disk. The
// last chunk's requested -t duration may run past the file's actual end
// (totalDurationMs is the client's own reading, not re-probed here) —
// ffmpeg just stops at EOF in that case, which is exactly the desired
// behavior, not an error.
async function splitAudioFile(inputPath: string, totalDurationMs: number, workDir: string, extension: string): Promise<AudioChunk[]> {
  const chunkCount = Math.max(1, Math.ceil(totalDurationMs / CHUNK_DURATION_MS));
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const startMs = i * CHUNK_DURATION_MS;
    const outputPath = join(workDir, `chunk-${i}.${extension}`);
    await runFfmpegChunk(inputPath, outputPath, startMs, CHUNK_DURATION_MS);
    chunks.push({ path: outputPath, startMs });
  }
  return chunks;
}

// Downloads a client-uploaded Vercel Blob (server-to-server — no CORS or
// Vercel body-size constraint applies here) and re-uploads its bytes to
// Gemini's Files API, then deletes the now-unneeded blob regardless of
// whether that re-upload succeeded. The blob only ever exists to ferry
// bytes from the browser to this Function; once Gemini has them, keeping it
// around is pure storage cost.
async function downloadAndUploadToGemini(
  apiKey: string,
  blobUrl: string,
  displayName: string,
  fallbackMimeType: string,
): Promise<GenAiFile> {
  const blobResult = await get(blobUrl, { access: "private" });
  if (!blobResult) {
    throw new Error("업로드된 파일을 찾을 수 없습니다. 다시 시도해주세요.");
  }
  try {
    const fileBlob = await new Response(blobResult.stream).blob();
    const mimeType = blobResult.blob.contentType || fallbackMimeType;
    return await uploadFileToGemini(apiKey, fileBlob, displayName, mimeType);
  } finally {
    await del(blobUrl).catch(() => {});
  }
}

// Uploaded files start in PROCESSING and must reach ACTIVE before they can
// be referenced in a generateContent call.
async function waitForFileActive(ai: GoogleGenAI, file: GenAiFile): Promise<GenAiFile> {
  const deadline = Date.now() + FILE_PROCESSING_TIMEOUT_MS;
  let current = file;
  while (current.state === "PROCESSING") {
    if (Date.now() > deadline) {
      throw new Error("파일 처리 시간이 초과되었습니다. 다시 시도해주세요.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (!current.name) break;
    current = await ai.files.get({ name: current.name });
  }
  if (current.state === "FAILED") {
    throw new Error("파일 업로드 처리에 실패했습니다.");
  }
  return current;
}

async function deleteUploadedFile(ai: GoogleGenAI, file: GenAiFile | null): Promise<void> {
  if (!file?.name) return;
  try {
    await ai.files.delete({ name: file.name });
  } catch {
    // non-critical — files auto-expire after 48h regardless
  }
}

type RawSttResponse = { hasSpeech?: unknown; script?: unknown };
type RawAnalysisResponse = { summary?: unknown; lectureNote?: unknown; checklist?: unknown };

// Worker A — STT only. Its entire maxOutputTokens budget goes toward the
// verbatim transcript alone, so a long lecture no longer competes with the
// lecture note for the same token ceiling. Plain (non-streaming) calls now
// that nothing is listening for incremental chunks — the background job has
// no connection to keep alive, unlike the SSE-streaming version this route
// used before moving to the job-queue architecture (see the file-level
// comment above).
async function callSttWorker(ai: GoogleGenAI, uploadedAudio: GenAiFile): Promise<RawSttResponse> {
  const systemInstruction = [
    "당신은 강의 녹음 오디오를 한 글자도 빠짐없이 받아쓰는 음성 인식(STT) 전문 어시스턴트입니다.",
    "반드시 지정된 JSON 스키마 형식으로만, 한국어로 응답하세요.",
    "당신의 유일한 임무는 오디오에 실제로 발화된 내용을 정확하게 받아쓰는 것입니다 — 요약하거나 압축하거나 의역하지 마세요.",
    "script는 반드시 오디오 00:00부터 끝까지에 대한 100% 완전한 받아쓰기여야 합니다. 오디오가 길다는 이유로 " +
      "일부 구간을 생략, 압축, 요약하는 것은 절대 허용되지 않습니다.",
    LATEX_BAN_RULE,
    "오디오에 사람이 말하는 음성이 실제로 들리면 hasSpeech를 true로 설정하고 script를 처음부터 끝까지 빠짐없이 채우세요.",
    "오디오에 사람의 말소리가 없거나 무음, 배경음악, 단순 신호음/잡음뿐이어서 내용을 알아들을 수 없는 경우 " +
      "hasSpeech를 false로, script는 빈 배열로 응답하세요. 이 경우 절대로 내용을 지어내지 마세요.",
  ].join(" ");

  const userPrompt = [
    "오디오의 00:00부터 끝까지 중간에 절대 생략하지 말고 모든 대화를 타임스탬프와 함께 스크립트로 변환하세요.",
    "- script: 발화 내용을 15~30초 분량의 자연스러운 1~2개 완성 문장 단위로 묶어서 나눈 정확한 받아쓰기. " +
      "단어나 짧은 어절 단위로 지나치게 잘게 쪼개지 마세요. 각 구간은 시작/종료 시각(초 단위 숫자)과 텍스트를 포함합니다.",
    "- [전체 스크립트 필수] 오디오가 아무리 길어도 절대 중간에 생략하거나 요약하지 마세요. 오디오의 처음부터 끝까지, " +
      "발화된 모든 구간을 100% 빠짐없이 받아쓰기하세요. 분량이 많다는 이유로 특정 구간을 건너뛰거나 '...(중략)' 같은 " +
      "생략 표시를 사용하는 것은 절대 금지입니다.",
  ].join("\n");

  console.log("[transcribe-and-summarize] calling Gemini (STT worker)", {
    model: MODEL,
    audioFile: { uri: uploadedAudio.uri, mimeType: uploadedAudio.mimeType, name: uploadedAudio.name },
  });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: createUserContent([
      userPrompt,
      createPartFromUri(uploadedAudio.uri ?? "", uploadedAudio.mimeType ?? "audio/webm"),
    ]),
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: STT_RESPONSE_SCHEMA,
      maxOutputTokens: 65536,
    },
  });

  if (response.promptFeedback?.blockReason) {
    throw new Error("안전 정책으로 인해 이 요청을 처리할 수 없습니다. 다른 파일로 시도해주세요.");
  }
  if (!response.text) {
    throw new Error("AI로부터 스크립트 응답을 받지 못했습니다. 다시 시도해주세요.");
  }
  try {
    return JSON.parse(response.text);
  } catch {
    throw new Error("스크립트 응답을 해석하는 데 실패했습니다. 다시 시도해주세요.");
  }
}

// Either the raw audio file (the normal, short-recording path) or an
// already-complete transcript string (the chunked long-recording path —
// see runChunkedAnalysisJob). The chunked STT pass already listened through
// the whole thing accurately in pieces, so re-attaching the full audio here
// too would just be redundant work exposed to the same duration risk this
// whole feature exists to avoid; the transcript is plenty for this worker's
// job of understanding and structuring content, not re-transcribing it.
type AnalysisAudioSource = { kind: "file"; file: GenAiFile } | { kind: "transcript"; text: string };

// Worker B — analysis only (summary/lectureNote/checklist). Never writes a
// transcript, so its whole token budget goes toward depth and coverage of
// the lecture note instead.
async function callAnalysisWorker(
  ai: GoogleGenAI,
  audioSource: AnalysisAudioSource,
  uploadedReferences: GenAiFile[],
  slideThumbnails: IncomingSlideThumbnail[],
  keywords: string[],
  bookmarkLines: string,
): Promise<RawAnalysisResponse> {
  const hasReference = uploadedReferences.length > 0;
  const hasSlideImages = slideThumbnails.length > 0;
  const sourceLabel = audioSource.kind === "file" ? "강의 녹음 오디오" : "강의 스크립트 전문(이미 완성된 정확한 받아쓰기)";

  const systemInstruction = [
    `당신은 ${sourceLabel}(및 첨부된 경우 강의 참고자료)를 분석해 시험 대비용 상세 학습 노트를 만드는 어시스턴트입니다.`,
    "반드시 지정된 JSON 스키마 형식으로만, 한국어로 응답하세요.",
    audioSource.kind === "file"
      ? "당신의 임무는 오디오를 그대로 받아쓰는 것이 아니라 내용을 이해하고 정리·구조화하는 것입니다 — 전체 스크립트(받아쓰기)는 " +
        "별도의 전담 프로세스가 처리하므로 신경 쓰지 마세요."
      : "아래 제공된 강의 스크립트 전문은 이미 완성된 정확한 받아쓰기입니다 — 이를 그대로 옮기지 말고, 내용을 이해하고 " +
        "정리·구조화하세요.",
    `${sourceLabel}와 참고자료에 실제로 있는 내용만 다루고, 추측하거나 지어내지 마세요.`,
    "summary와 lectureNote는 역할이 다릅니다: summary는 음성만으로 만드는 짧은 개요이고, lectureNote는 음성과 참고자료를 " +
      "모두 반영한 상세하고 포괄적인 시험 대비 노트입니다. 두 필드를 동일한 내용으로 채우지 마세요.",
    LATEX_BAN_RULE,
    audioSource.kind === "file"
      ? "오디오에 사람이 말하는 강의 음성이 실제로 들리면 summary/lectureNote/checklist를 모두 채우세요. 오디오에 사람의 " +
        "말소리가 없거나 무음, 배경음악, 단순 신호음/잡음뿐이어서 강의 내용을 알아들을 수 없는 경우 summary와 " +
        "lectureNote는 빈 문자열로, checklist는 빈 배열로 응답하세요. 이 경우 절대로 내용을 지어내지 마세요."
      : "제공된 스크립트를 바탕으로 summary/lectureNote/checklist를 모두 채우세요.",
  ].join(" ");

  const promptLines = [
    audioSource.kind === "file"
      ? "첨부된 강의 녹음 오디오(및 참고자료)를 바탕으로 아래 항목을 생성해주세요. 전체 스크립트(받아쓰기)는 별도로 " +
        "처리되니 신경 쓰지 않아도 됩니다."
      : "아래 [강의 스크립트 전문](및 첨부된 경우 참고자료)을 바탕으로 아래 항목을 생성해주세요.",
    "1. summary: 녹음 음성만을 기반으로 핵심 내용 3~5개를 골라 각 줄을 '• '로 시작하는 글머리 기호 리스트로 작성하세요 " +
      "(줄글 문단 형태로 쓰지 말 것). 참고자료 내용은 여기에 포함하지 마세요.",
    "2. lectureNote: 시험 대비용 상세 강의노트 (마크다운). 아래 [상세 강의노트 작성 지침]을 반드시 따르세요.",
    "3. checklist: 학습자가 실천해야 할 과제 또는 복습해야 할 핵심 항목 목록 (문장 배열).",
    "",
    "[상세 강의노트 작성 지침] lectureNote는 summary보다 훨씬 상세하고 포괄적으로 작성하세요.",
    "- [단순 요약 절대 금지] lectureNote를 짧은 요약문으로 작성하는 것은 절대 금지합니다. 강의에 등장하는 모든 전문 용어, " +
      "구체적인 수치와 지표(예: 5일선, 30주선 등 실제 언급된 숫자·기준), 핵심 기법(예: 눌림목 매매, 박스권 돌파 등 " +
      "실제 언급된 방법론·전략명)을 단 하나도 빠짐없이 포함하세요. 대학 전공 서적이나 실전 비법서처럼 구조화되고 " +
      "깊이 있는 텍스트로 작성하세요 — 표면적으로 훑고 지나가는 개요가 아니라, 각 개념을 왜/어떻게/언제 적용하는지까지 " +
      "설명하는 수준이어야 합니다.",
    "- [포괄성] 강의 중 언급된 사소한 팁, 교수의 코멘트, 슬라이드 속 세부 텍스트/표까지 빠짐없이 모두 수록하세요.",
    "- [활동 구간도 동등하게 취급 — 임의 축소 금지] 학생들 간의 조별 토론, 아이스브레이킹, 역할 분담, 팀별 발표처럼 " +
      "'활동/대화형' 구간이 교수님의 '학술적/이론적' 설명 구간과 함께 녹음에 들어있더라도, 활동 구간의 중요도를 AI가 " +
      "임의로 낮게 판단해 요약을 줄이거나 통째로 생략하지 마세요. 두 유형의 내용 모두 위 [단순 요약 절대 금지]/[포괄성] " +
      "규칙과 동일한 수준의 상세함으로 빠짐없이 다루세요 — 녹음이 길거나 여러 구간(활동 전반부 + 이론 후반부 등)으로 " +
      "이어지는 경우도 마찬가지입니다.",
    "- [중복 주제 통합] 강의가 여러 구간(전반부/후반부, 여러 차시 등)으로 나뉘어 있거나 같은 주제(예: 과제 안내, 평가 기준, " +
      "AI 활용/윤리 원칙 등)가 녹음 중 여러 번 반복해서 언급되더라도, 같은 대주제를 두 번 만들지 마세요. 겹치거나 " +
      "동일한 주제는 반드시 하나의 대주제로 통합해 한 곳에서만 다루세요.",
    "- [최종 결론만 반영] 교수가 강의 도중 말을 바꾸거나 이전 안내를 정정하는 과정이 그대로 들리더라도(예: '원래 " +
      "다음 주까지였는데 이번 주 금요일로 당길게요'), 그 논의·변경 과정 자체를 서술하지 마세요. 여러 차례 언급된 " +
      "내용 중 가장 나중에 확정된 최종 결론만 반영하고, 이미 폐기되거나 정정된 이전 안내(예: 변경 전 마감일)는 " +
      "결과에 남기지 마세요.",
    "- [핵심 단서 최상단 배치] 학점 컷오프, 최종 과제 제출 마감일처럼 절대 놓치면 안 되는 핵심 정보가 있다면, 본문 " +
      "어딘가에 묻혀 놓치기 쉽지 않도록 lectureNote의 맨 첫 줄(대주제 1번보다 앞)에 '> 🔥' 콜아웃으로 요약해 배치하세요. " +
      "해당하는 핵심 단서가 없다면 이 콜아웃은 생략하세요.",
    "- [구조] 이 최상단 콜아웃 다음으로, 전체 내용을 대주제 단위로 나누어 \"## 1. 대주제명\", \"## 2. 대주제명\"처럼 " +
      "번호를 매긴 H2 제목으로 구성하고, 필요하면 그 안에서 H3(###) 소제목으로 세분화하세요. 각 대주제 아래 일반적인 " +
      "설명·배경지식·세부 내용은 기본적으로 평범한 문단이나 글머리 기호(- 또는 •) 리스트로 작성하세요. 단, 바로 아래 " +
      "[1부/2부 시간 흐름 구조] 조건에 해당하는 녹음이라면 이 H2 번호 매김 대신 그 규칙을 최상위 구조로 사용하세요.",
    "- [1부/2부 시간 흐름 구조 — 조건부 고정 포맷] 녹음 안에 (a) 학생들끼리의 조별 토론/브레인스토밍/역할 분담/" +
      "아이스브레이킹/팀별 발표 같은 '활동' 구간과 (b) 그 뒤에 이어지는 교수님의 이론 설명/피드백/개념 정리 구간이 " +
      "실제로 시간 순서대로 모두 존재하는 경우에만 적용하는 규칙입니다. 이 조건을 만족하면, 위 [구조] 규칙의 " +
      "\"## 대주제\" 번호 매김 대신 최상단 콜아웃 바로 다음에 아래 두 제목을 정확히 이 문구 그대로, 고정 순서로 " +
      "사용해 최상위 구조를 만드세요:\n" +
      "  ### 1부: 학생 조별 토론 및 활동\n" +
      "  ### 2부: 교수님 이론 설명 및 피드백 (모범 답안)\n" +
      "1부에는 학생들 간 브레인스토밍, 역할 분담, 아이스브레이킹, 팀별 발표 내용을, 2부에는 학생 발표 이후 이어지는 " +
      "교수님의 피드백과 학자/이론 설명, 핵심 지식 정리를 담으세요. 각 부 안에서 세부 주제를 더 나눠야 한다면 " +
      "##/###(H2/H3)를 쓰지 말고 H4(####) 소제목이나 굵게(**) 강조 + 글머리 기호를 사용하세요 — 1부/2부보다 " +
      "시각적으로 더 크거나 같은 제목이 그 안에 나오면 안 됩니다. 이 조건에 해당하지 않는(학생 활동 구간이 없는) " +
      "순수 이론 강의라면 절대 억지로 1부/2부 구조를 만들지 말고, 기존 [구조] 규칙대로 대주제 단위로만 구성하세요.",
    "- [시험 출제 신호 감지 — 엄격한 조건에서만, 놓치면 안 됨] 교수가 \"시험에 나온다\", \"무조건 출제된다\", " +
      '"별표 쳐라", "이거 매우 중요하다", "이건 시험에 낼 거예요"처럼 시험 출제 가능성을 명시적으로/직접적으로 ' +
      "언급한 구간만 대상입니다. 이런 명시적 언급이 있다면 강의 전체에서 단 한 곳도 빠짐없이 찾아내세요. " +
      "절대 AI가 자의적으로 중요도를 판단해서 이 표시를 붙이지 마세요 — 단순히 참고자료(교재)에 없는 내용이라는 " +
      "이유, 설명 분량이 많다는 이유, 또는 여러 번 반복됐다는 이유만으로는 이 표시를 사용할 수 없습니다. 교수가 " +
      "위 예시처럼 시험 출제를 명시적으로 언급하지 않았다면 절대 이 형식을 사용하지 마세요. 해당 내용은 다른 " +
      "콜아웃이나 일반 텍스트와 뚜렷이 구별되도록 아래 형식을 정확히 그대로 사용해 표시하세요 (대괄호 안 문구와 " +
      "굵게 표시 포함):\n" +
      "  > 🚨 **[시험 출제 100%]** 교수님 강조 내용: (실제로 언급된 내용을 그대로 서술)",
    "- [선택적 강조, 중첩 금지] 모든 문장을 콜아웃 박스로 감싸지 마세요(도배 금지). 아래 세 경우에만 해당 문장 앞에 " +
      '"> " 를 붙인 인용(blockquote) 콜아웃으로 선택적으로 강조하세요. 콜아웃 박스 안에 또 다른 "> " 인용문을 ' +
      "중첩해서 넣지 마세요 — 콜아웃은 항상 1단계로만 작성합니다.",
    "  > 🚨 [시험 출제 확정]: 바로 위 [시험 출제 신호 감지] 규칙에 해당하는 내용 (형식은 그 규칙의 예시를 그대로 따르세요)",
    "  > 🔥 [핵심 강조]: 교수가 강조했지만 출제 여부를 직접 언급하지는 않은 중요 개념 — 🚨 항목과 중복해서 표시하지 마세요",
    "  > 🗣️ [교수님 코멘트/사례]: 맥락 이해를 돕는 교수님의 예시나 인상적인 멘트",
    "  그 외 일반적인 설명은 콜아웃 없이 작성하세요.",
    "- [비교 표 필수] 성적 평가 비율, 과제 제출 일정, AI 활용 가이드라인처럼 서로 비교 가능한 항목이 3개 이상 " +
      "나열되는 경우, 절대 줄글 문단이나 글머리 기호 리스트로 나열하지 말고 반드시 Markdown 표(\"| 항목 | 내용 |\" " +
      "형식, 구분선 행 포함)로 작성하세요.",
    "- [부가 정보는 토글로] 교수 소개, 본문 흐름과 무관한 잡담처럼 수업 내용 자체와 관련 없는 부가 참고 정보는 아래 " +
      "예시와 정확히 같은 형식으로 감싸서, 본문이 번잡해지지 않도록 하세요 (summary에는 짧은 제목만 넣고, " +
      "<details>/<summary>/</details> 태그는 반드시 각각 단독 줄에 작성). 단, 위 [1부/2부 시간 흐름 구조]가 적용되는 " +
      "경우 학생 조별 토론/아이스브레이킹/팀별 발표는 수업의 실제 활동 구간이므로 이 토글로 숨기지 말고 반드시 " +
      "1부 본문에 그대로 서술하세요 — 토글은 그 구조가 적용되지 않는 강의의 사소한 잡담에만 쓰세요:\n" +
      "  <details>\n" +
      "  <summary>부가 정보 제목</summary>\n" +
      "\n" +
      "  내용\n" +
      "\n" +
      "  </details>",
    "- [서식] 핵심 용어는 볼드체(**)로 강조하세요.",
  ];

  if (hasReference) {
    promptLines.push(
      "- [자료 연계] 강의자료에 도식/표/다이어그램이 포함된 구간을 다룰 때는 본문에 \"[슬라이드 N페이지: OO 도식 참조]\" 형태로 표기하세요. " +
        "정확한 페이지 번호를 알 수 없으면 \"[강의자료: OO 도식 참조]\"로 표기하세요. " +
        '교수가 말로 설명하지 않았지만 슬라이드/자료에만 있는 필수 개념은 "> 💡 [강의자료 보충] ..." 콜아웃으로 선택적으로 덧붙일 수 있습니다.',
      "- [출처 교차검증 태그] 강의 참고자료(교재)와 오디오 스크립트를 항목별로 교차 검증하세요. 내용을 누락하거나 " +
        "별도의 표로 분리하지 말고, lectureNote 본문의 해당 불릿 포인트/문장 끝에 아래 두 태그 중 해당하는 것만 " +
        "간단히 붙이세요:\n" +
        "  · 참고자료(교재)에는 없지만 교수가 강의에서 말로 추가로 덧붙인 설명이나 여담이라면 문장 끝에 " +
        "`🎙️ [녹음 추가]`를 붙이세요.\n" +
        "  · 참고자료(교재)에는 있지만 교수가 강의 중 소리 내어 읽거나 설명하지 않고 넘어간(스킵한) 내용이라면 " +
        "문장 끝에 `⚠️ [자료 생략]`를 붙이세요.\n" +
        "  참고자료와 강의 음성 양쪽에 모두 있는 공통 내용에는 시각적 깔끔함을 위해 어떤 태그도 붙이지 마세요. " +
        "이 태그는 항목 끝에 짧게 부착하는 표시일 뿐이므로, 이 태그를 붙인다는 이유로 해당 내용을 별도 섹션이나 " +
        "표로 분리하지 마세요.",
    );
  } else {
    promptLines.push("- 강의자료가 첨부되지 않았으므로 음성 강의 내용만으로 최대한 상세하게 작성하세요.");
  }

  if (hasSlideImages) {
    promptLines.push(
      "- [슬라이드 사진 연동 — 이미지는 어디까지나 보조 수단] 이어서 강의 슬라이드 사진이 페이지 순서대로" +
        "(슬라이드 1, 슬라이드 2, ...) 제공됩니다. 제공된 PDF 슬라이드 이미지(차트, 수식, 다이어그램)를 강의 내용과 " +
        "대조 분석하십시오. 사진 하나에 짧은 텍스트 한 줄만 적는 성의 없는 구조는 절대 금지합니다. 강의노트의 " +
        "핵심은 어디까지나 탄탄하고 상세한 텍스트 설명입니다 — 먼저 해당 개념·차트·수식을 글로 완전하게 풀어서 " +
        "설명한 뒤(위 [단순 요약 절대 금지] 지침 수준의 상세함으로), 시각적 이해가 반드시 필요한 경우에만 그 설명 " +
        "바로 아래에 보조적으로 `![슬라이드 X](slide_X)` 형식의 이미지 플레이스홀더를 삽입하십시오 (X는 해당 슬라이드의 " +
        "페이지 번호). 텍스트 설명 없이 이미지만 덩그러니 넣지 마세요. 실제로 차트/다이어그램/수식 등 시각 자료가 있어 " +
        "사진으로 보여주는 것이 학습에 도움이 되는 슬라이드에만 삽입하고, 텍스트뿐인 슬라이드에는 남용하지 마세요.",
    );
  }

  if (keywords.length > 0) {
    promptLines.push(
      "",
      "[STT 보정 지침] 다음은 이 강의의 전문 용어/고유명사 목록입니다. 발음이 비슷해 음성 인식 중 오타가 날 수 있는 단어들이니, " +
        `summary, lectureNote 작성 시 이 목록을 사전(Glossary)으로 참고하여 정확한 표기로 교정해주세요: ${keywords.join(", ")}`,
    );
  }

  if (hasReference) {
    promptLines.push(
      "",
      uploadedReferences.length > 1
        ? `[강의안 통합 지침] 오디오와 함께 강의 참고자료 ${uploadedReferences.length}개(슬라이드/문서)가 첨부되어 있습니다. 개별 자료로 따로 다루지 말고, 모두 하나의 강의 자료 묶음으로 취급해 종합적으로 활용하세요.`
        : "[강의안 통합 지침] 오디오와 함께 강의 참고자료(슬라이드/문서)가 첨부되어 있습니다.",
      "- STT 보정: 참고자료에 나오는 전문 용어와 고유명사도 사전으로 활용해 오인식을 교정하세요.",
      "- 통합 체크리스트: 교수가 음성으로 언급한 과제/공지사항뿐 아니라, 참고자료에 있는 연습문제나 반드시 암기해야 할 핵심 항목도 checklist에 포함하세요.",
    );
  }

  if (bookmarkLines) {
    promptLines.push("", `학습자가 녹음 중 남긴 타임스탬프 북마크:\n${bookmarkLines}`);
  }

  if (audioSource.kind === "transcript") {
    // Plain text, not a file Part — cheaper on input tokens than the raw
    // audio would have been anyway, and this worker only needs to read it,
    // not listen to it.
    promptLines.push("", "[강의 스크립트 전문]", audioSource.text);
  }

  const userPrompt = promptLines.join("\n");

  const contentParts: (string | Part)[] = [userPrompt];
  if (audioSource.kind === "file") {
    contentParts.push(createPartFromUri(audioSource.file.uri ?? "", audioSource.file.mimeType ?? "audio/webm"));
  }
  for (const uploadedReference of uploadedReferences) {
    contentParts.push(
      createPartFromUri(uploadedReference.uri ?? "", uploadedReference.mimeType ?? "application/pdf"),
    );
  }
  // Inline (not Files API) — these are small, client-compressed thumbnails,
  // well under Gemini's inline-data limit. Sent in page order so the "슬라이드
  // 1, 슬라이드 2, ..." framing in the prompt above lines up with what the
  // model actually sees.
  const sortedThumbnails = [...slideThumbnails].sort((a, b) => a.page - b.page);
  for (const thumbnail of sortedThumbnails) {
    const part = dataUrlToPart(thumbnail.dataUrl);
    if (part) contentParts.push(part);
  }

  console.log("[transcribe-and-summarize] calling Gemini (analysis worker)", {
    model: MODEL,
    audioSource:
      audioSource.kind === "file"
        ? { kind: "file", uri: audioSource.file.uri, mimeType: audioSource.file.mimeType, name: audioSource.file.name }
        : { kind: "transcript", chars: audioSource.text.length },
    referenceFiles: uploadedReferences.map((file) => ({ uri: file.uri, mimeType: file.mimeType, name: file.name })),
    slideThumbnailCount: sortedThumbnails.length,
    promptChars: userPrompt.length,
    keywordCount: keywords.length,
    bookmarkCount: bookmarkLines ? bookmarkLines.split("\n").length : 0,
  });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: createUserContent(contentParts),
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      maxOutputTokens: 65536,
    },
  });

  if (response.promptFeedback?.blockReason) {
    throw new Error("안전 정책으로 인해 이 요청을 처리할 수 없습니다. 다른 파일로 시도해주세요.");
  }
  if (!response.text) {
    throw new Error("AI로부터 분석 응답을 받지 못했습니다. 다시 시도해주세요.");
  }
  try {
    return JSON.parse(response.text);
  } catch {
    throw new Error("분석 응답을 해석하는 데 실패했습니다. 다시 시도해주세요.");
  }
}

// Shared by both the direct and chunked paths — turns the two workers' raw
// JSON into the final typed result, applying the same no-speech short
// circuit and field normalization either way.
function buildAnalysisResult(sttSegments: unknown, hasSpeechFlag: boolean, analysisResult: RawAnalysisResponse): AnalysisResult {
  const rawSegments = Array.isArray(sttSegments) ? sttSegments : [];
  const hasSpeech = hasSpeechFlag && rawSegments.length > 0;

  if (!hasSpeech) {
    return {
      transcript: [{ id: "seg-0", startMs: 0, endMs: 0, text: NO_SPEECH_TRANSCRIPT }],
      fullText: NO_SPEECH_TRANSCRIPT,
      summary: NO_SPEECH_SUMMARY,
      lectureNote: NO_SPEECH_NOTE,
      checklist: [],
    };
  }

  const transcript: TranscriptSegment[] = rawSegments.map((segment, index) => {
    const s = segment as { startSeconds?: unknown; endSeconds?: unknown; text?: unknown };
    return {
      id: `seg-${index}`,
      startMs: Math.round(Number(s.startSeconds ?? 0) * 1000),
      endMs: Math.round(Number(s.endSeconds ?? 0) * 1000),
      text: typeof s.text === "string" ? fixEscapedNewlines(s.text.trim()) : "",
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
    text: fixEscapedNewlines(text),
    done: false,
  }));

  return { transcript, fullText, summary, lectureNote, checklist };
}

// Shared by both paths — reference docs are always uploaded whole
// regardless of how the audio itself is handled.
async function uploadReferenceFiles(ai: GoogleGenAI, apiKey: string, referenceBlobRefs: BlobRef[]): Promise<GenAiFile[]> {
  const uploadedReferences: GenAiFile[] = [];
  for (const ref of referenceBlobRefs) {
    try {
      console.log("[transcribe-and-summarize] downloading reference blob and uploading to Gemini", {
        fileName: ref.fileName,
      });
      let uploadedReference = await downloadAndUploadToGemini(apiKey, ref.url, ref.fileName, ref.mimeType || "application/pdf");
      uploadedReference = await waitForFileActive(ai, uploadedReference);
      uploadedReferences.push(uploadedReference);
    } catch (error) {
      console.error("[transcribe-and-summarize] reference processing failed", { error, fileName: ref.fileName });
      await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
      throw new Error(`참고자료 '${ref.fileName}' 처리 실패: ${describeGeminiError(error)}`);
    }
  }
  return uploadedReferences;
}

// The original, still-default path for anything at or under
// CHUNK_THRESHOLD_MS — unchanged from before chunking existed: the whole
// audio file goes to Gemini once, and both workers run against it directly
// and in parallel. Runs inside after() (see POST), fully decoupled from
// whatever the client's connection is doing by that point.
async function runDirectAnalysisJob(
  apiKey: string,
  sessionId: string,
  audioBlobRef: BlobRef,
  referenceBlobRefs: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  slideThumbnails: IncomingSlideThumbnail[],
): Promise<AnalysisResult> {
  const ai = new GoogleGenAI({ apiKey });

  let uploadedAudio: GenAiFile;
  try {
    console.log("[transcribe-and-summarize] downloading audio blob and uploading to Gemini", {
      fileName: audioBlobRef.fileName,
    });
    uploadedAudio = await downloadAndUploadToGemini(
      apiKey,
      audioBlobRef.url,
      audioBlobRef.fileName,
      audioBlobRef.mimeType || "audio/webm",
    );
    uploadedAudio = await waitForFileActive(ai, uploadedAudio);
  } catch (error) {
    console.error("[transcribe-and-summarize] audio processing failed", { error });
    throw new Error(`오디오 처리 실패: ${describeGeminiError(error)}`);
  }

  let uploadedReferences: GenAiFile[];
  try {
    uploadedReferences = await uploadReferenceFiles(ai, apiKey, referenceBlobRefs);
  } catch (error) {
    await deleteUploadedFile(ai, uploadedAudio);
    throw error;
  }

  const bookmarkLines = bookmarks
    .map((bookmark) => `- [${formatTimestamp(bookmark.atMs)}] ${bookmark.label}`)
    .join("\n");

  // Two independent Gemini calls in parallel — see callSttWorker/
  // callAnalysisWorker above for why this replaced the old single combined
  // call. Both reference the same already-uploaded audio file (no re-upload).
  //
  // STAGE 1/STAGE 2 checkpointing: sttPromise's own .then() below writes the
  // STT checkpoint the instant transcription finishes, completely
  // independent of whether analysisPromise (STAGE 2) is still running or
  // later fails/times out — Promise.all rejecting on analysisPromise can
  // never "undo" a checkpoint write that already happened on sttPromise's
  // own chain. This keeps the STT and LLM calls genuinely concurrent (same
  // wall-clock time as before this feature existed) while still guaranteeing
  // the checkpoint lands the moment STT is done, not only after both finish.
  let sttResult: RawSttResponse;
  let analysisResult: RawAnalysisResponse;
  try {
    const sttPromise = callSttWorker(ai, uploadedAudio).then(async (result) => {
      const hasSpeech = result.hasSpeech === true && Array.isArray(result.script) && result.script.length > 0;
      if (hasSpeech) {
        const segments = normalizeSttSegments(result.script);
        await writeSttCheckpoint(sessionId, {
          createdAt: Date.now(),
          transcriptText: segmentsToTranscriptText(segments),
          segments,
          hasSpeech: true,
        });
      }
      return result;
    });
    const analysisPromise = callAnalysisWorker(
      ai,
      { kind: "file", file: uploadedAudio },
      uploadedReferences,
      slideThumbnails,
      keywords,
      bookmarkLines,
    );
    [sttResult, analysisResult] = await Promise.all([sttPromise, analysisPromise]);
  } catch (error) {
    console.error("[transcribe-and-summarize] Gemini call failed", {
      model: MODEL,
      status: error instanceof ApiError ? error.status : undefined,
      error,
    });
    throw new Error(describeGeminiError(error));
  } finally {
    // Best-effort cleanup — Files API entries auto-expire after 48h anyway,
    // so a failed delete here isn't worth surfacing to the user.
    await deleteUploadedFile(ai, uploadedAudio);
    await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
  }

  return buildAnalysisResult(sttResult.script, sttResult.hasSpeech === true, analysisResult);
}

// The chunked path for anything over CHUNK_THRESHOLD_MS — see the file-level
// architecture comment for why this exists at all: one Gemini call against
// 90 minutes of audio risks both this Function's own 300s budget and
// whatever practical limits Gemini's own audio understanding has, so this
// downloads the source once, cuts it into CHUNK_DURATION_MS pieces on disk
// with ffmpeg, transcribes each piece as its own small, independent STT
// call (in parallel — wall-clock time is what's actually budget-constrained
// here, not aggregate work), and only then runs the analysis worker once
// against the merged, already-accurate transcript text — not the raw audio
// again, which would just re-expose that same worker to the same risk this
// whole path exists to avoid.
async function runChunkedAnalysisJob(
  apiKey: string,
  jobId: string,
  sessionId: string,
  audioBlobRef: BlobRef,
  referenceBlobRefs: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  slideThumbnails: IncomingSlideThumbnail[],
  durationMs: number,
): Promise<AnalysisResult> {
  const ai = new GoogleGenAI({ apiKey });
  const workDir = await mkdtemp(join(tmpdir(), "lecture-chunks-"));
  const uploadedChunkFiles: GenAiFile[] = [];
  let uploadedReferences: GenAiFile[] = [];

  try {
    await reportStage(jobId, "긴 오디오 분할 중...");
    const inputPath = join(workDir, "source-input");
    const extension = guessAudioExtension(audioBlobRef.fileName, audioBlobRef.mimeType);
    const properInputPath = `${inputPath}.${extension}`;

    console.log("[transcribe-and-summarize] downloading audio blob for chunked splitting", {
      fileName: audioBlobRef.fileName,
      durationMs,
    });
    try {
      await downloadBlobToFile(audioBlobRef.url, properInputPath);
    } finally {
      await del(audioBlobRef.url).catch(() => {});
    }

    let chunks: AudioChunk[];
    try {
      chunks = await splitAudioFile(properInputPath, durationMs, workDir, extension);
    } catch (error) {
      throw new Error(`오디오 분할 실패: ${error instanceof Error ? error.message : String(error)}`);
    }

    uploadedReferences = await uploadReferenceFiles(ai, apiKey, referenceBlobRefs);

    // Each chunk gets its own small STT call, run in parallel — this is
    // what actually keeps the whole job inside the 300s function budget for
    // a very long recording; splitting the work up without also
    // parallelizing it would just replace one long call with several
    // sequential ones adding up to roughly the same wall-clock time.
    await reportStage(jobId, `청크 0/${chunks.length} 처리 중...`);
    let completedChunks = 0;
    const chunkResults = await Promise.all(
      chunks.map(async (chunk, index) => {
        const chunkFile = await uploadLocalFileToGemini(
          apiKey,
          chunk.path,
          `chunk-${index}`,
          audioBlobRef.mimeType || "audio/webm",
        );
        const activeFile = await waitForFileActive(ai, chunkFile);
        uploadedChunkFiles.push(activeFile);
        const result = await callSttWorker(ai, activeFile);
        completedChunks += 1;
        await reportStage(jobId, `청크 ${completedChunks}/${chunks.length} 처리 중...`);
        return { chunk, result };
      }),
    );

    const hasSpeech = chunkResults.some(({ result }) => result.hasSpeech === true);
    const mergedSegments: CheckpointSegment[] = [];
    let segmentIndex = 0;
    // chunkResults preserves chunks' original chronological order (Promise.all
    // resolves in input order regardless of which chunk actually finished
    // first), so this merge doesn't need to re-sort anything.
    for (const { chunk, result } of chunkResults) {
      const offsetSeconds = chunk.startMs / 1000;
      for (const segment of normalizeSttSegments(result.script)) {
        mergedSegments.push({
          startSeconds: segment.startSeconds + offsetSeconds,
          endSeconds: segment.endSeconds + offsetSeconds,
          text: segment.text,
        });
        segmentIndex++;
      }
    }
    console.log("[transcribe-and-summarize] merged chunked transcript", {
      chunkCount: chunks.length,
      mergedSegmentCount: segmentIndex,
      hasSpeech,
    });

    if (!hasSpeech) {
      return buildAnalysisResult([], false, {});
    }

    // STAGE 1 (STT, chunked) complete — checkpoint immediately, before
    // STAGE 2 (LLM analysis) below ever runs, so a stage-2 timeout/failure
    // never forces every chunk to be re-split, re-uploaded, and
    // re-transcribed on retry (see runAnalysisOnlyFromCheckpoint).
    const transcriptText = segmentsToTranscriptText(mergedSegments);
    await writeSttCheckpoint(sessionId, {
      createdAt: Date.now(),
      transcriptText,
      segments: mergedSegments,
      hasSpeech: true,
    });

    await reportStage(jobId, "AI 요약 생성 중...");

    const bookmarkLines = bookmarks
      .map((bookmark) => `- [${formatTimestamp(bookmark.atMs)}] ${bookmark.label}`)
      .join("\n");

    let analysisResult: RawAnalysisResponse;
    try {
      analysisResult = await callAnalysisWorker(
        ai,
        { kind: "transcript", text: transcriptText },
        uploadedReferences,
        slideThumbnails,
        keywords,
        bookmarkLines,
      );
    } catch (error) {
      console.error("[transcribe-and-summarize] chunked analysis worker failed", {
        model: MODEL,
        status: error instanceof ApiError ? error.status : undefined,
        error,
      });
      throw new Error(describeGeminiError(error));
    }

    return buildAnalysisResult(mergedSegments, hasSpeech, analysisResult);
  } finally {
    await Promise.all(uploadedChunkFiles.map((file) => deleteUploadedFile(ai, file)));
    await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// STAGE 2 only — resumes from a previously-checkpointed STT result (see
// SttCheckpoint), skipping audio download/upload/chunking/transcription
// entirely regardless of whether the original attempt was direct or
// chunked (both converge on the same {transcriptText, segments, hasSpeech}
// shape by the time a checkpoint exists). This is what actually avoids
// burning STT credits again on a retry after a stage-2-only failure — and
// since it never touches the original audio at all, it works even if the
// client no longer has it (e.g. the IndexedDB audio cache was lost too).
async function runAnalysisOnlyFromCheckpoint(
  apiKey: string,
  jobId: string,
  checkpoint: SttCheckpoint,
  referenceBlobRefs: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  slideThumbnails: IncomingSlideThumbnail[],
): Promise<AnalysisResult> {
  const ai = new GoogleGenAI({ apiKey });
  let uploadedReferences: GenAiFile[] = [];

  try {
    await reportStage(jobId, "AI 요약 생성 중... (STT 결과 재사용)");
    uploadedReferences = await uploadReferenceFiles(ai, apiKey, referenceBlobRefs);

    const bookmarkLines = bookmarks
      .map((bookmark) => `- [${formatTimestamp(bookmark.atMs)}] ${bookmark.label}`)
      .join("\n");

    const analysisResult = await callAnalysisWorker(
      ai,
      { kind: "transcript", text: checkpoint.transcriptText },
      uploadedReferences,
      slideThumbnails,
      keywords,
      bookmarkLines,
    );
    return buildAnalysisResult(checkpoint.segments, checkpoint.hasSpeech, analysisResult);
  } catch (error) {
    console.error("[transcribe-and-summarize] checkpoint-resumed analysis worker failed", {
      model: MODEL,
      status: error instanceof ApiError ? error.status : undefined,
      error,
    });
    throw new Error(describeGeminiError(error));
  } finally {
    await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
  }
}

// Dispatches to: a checkpoint resume (STAGE 2 only, if a prior attempt for
// this session already completed STT — see SttCheckpoint), or else the
// chunked/direct STAGE 1+2 path based on the client-reported duration (see
// CHUNK_THRESHOLD_MS). The checkpoint check always comes first — it's what
// makes a retry after a stage-2 failure skip STT regardless of how long the
// recording is.
async function runAnalysisJob(
  apiKey: string,
  jobId: string,
  sessionId: string,
  audioBlobRef: BlobRef | null,
  referenceBlobRefs: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  slideThumbnails: IncomingSlideThumbnail[],
  durationMs: number,
): Promise<AnalysisResult> {
  const checkpoint = await readSttCheckpoint(sessionId);
  if (checkpoint) {
    return runAnalysisOnlyFromCheckpoint(apiKey, jobId, checkpoint, referenceBlobRefs, bookmarks, keywords, slideThumbnails);
  }
  if (!audioBlobRef) {
    throw new Error("오디오 파일 업로드 정보가 없어 분석을 시작할 수 없습니다. 파일을 다시 첨부해주세요.");
  }
  if (durationMs > CHUNK_THRESHOLD_MS) {
    return runChunkedAnalysisJob(apiKey, jobId, sessionId, audioBlobRef, referenceBlobRefs, bookmarks, keywords, slideThumbnails, durationMs);
  }
  return runDirectAnalysisJob(apiKey, sessionId, audioBlobRef, referenceBlobRefs, bookmarks, keywords, slideThumbnails);
}

// Kicks off a job and returns its id immediately — see the file-level
// architecture comment above.
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

  // The audio must already be uploaded to Vercel Blob by the client
  // (lib/blobUpload.ts) before this route is ever called. Only its blob
  // reference arrives here. Absent is only valid when a STAGE 1 checkpoint
  // already exists for this session (see runAnalysisJob) — the client
  // knows this in advance via checkSttCheckpoint and skips the upload, so
  // this is re-checked here rather than trusted from the client alone.
  const audioBlobRef = body.audioBlob ? parseBlobRef(body.audioBlob) : null;
  if (!audioBlobRef && !(await readSttCheckpoint(sessionId))) {
    return NextResponse.json(
      { error: "오디오 파일 업로드 정보가 전달되지 않았습니다. 파일을 다시 첨부해주세요." },
      { status: 400 },
    );
  }

  const referenceRawList = Array.isArray(body.referenceBlobs) ? body.referenceBlobs : [];
  if (referenceRawList.length > MAX_REFERENCE_FILES) {
    return NextResponse.json(
      { error: `참고자료는 최대 ${MAX_REFERENCE_FILES}개까지만 첨부할 수 있습니다.` },
      { status: 400 },
    );
  }
  const referenceBlobRefs = referenceRawList
    .map(parseBlobRef)
    .filter((ref): ref is NonNullable<ReturnType<typeof parseBlobRef>> => ref !== null);

  const bookmarks: IncomingBookmark[] = Array.isArray(body.bookmarks) ? body.bookmarks : [];
  const keywords: string[] = Array.isArray(body.keywords)
    ? body.keywords.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const slideThumbnails: IncomingSlideThumbnail[] = Array.isArray(body.slideThumbnails)
    ? body.slideThumbnails.filter(
        (item): item is IncomingSlideThumbnail =>
          item && typeof item.page === "number" && typeof item.dataUrl === "string",
      )
    : [];
  const durationMs = typeof body.durationMs === "number" && Number.isFinite(body.durationMs) ? body.durationMs : 0;

  const jobId = crypto.randomUUID();
  await writeJobRecord(jobId, { status: "processing", createdAt: Date.now() });

  after(async () => {
    try {
      const result = await runAnalysisJob(
        apiKey,
        jobId,
        sessionId,
        audioBlobRef,
        referenceBlobRefs,
        bookmarks,
        keywords,
        slideThumbnails,
        durationMs,
      );
      await writeJobRecord(jobId, { status: "completed", createdAt: Date.now(), result });
      // The checkpoint's only job was protecting against a STAGE 2 failure
      // on THIS attempt — now that the whole job has succeeded, it's dead
      // weight (and could otherwise cause a much later, unrelated re-analyze
      // of this same session to wrongly skip STT against a stale script).
      await deleteSttCheckpoint(sessionId);
    } catch (error) {
      // Covers every error this route's own code can throw and catch —
      // Gemini failures, ffmpeg failures, upload failures, all already
      // surface here via the try/catches inside runAnalysisJob's two paths.
      // What this can NEVER catch is the Function process itself being
      // killed outright (a hard maxDuration cutoff or an OOM kill) — there's
      // no JS handler for that, the process is just gone mid-flight. That's
      // exactly why the client's own poll loop (lib/analysisJob.ts) enforces
      // its own independent timeout instead of waiting on this write forever.
      console.error("[transcribe-and-summarize] job failed", { jobId, error });
      await writeJobRecord(jobId, {
        status: "error",
        createdAt: Date.now(),
        error: error instanceof Error ? error.message : "AI 분석에 실패했습니다.",
      });
    }
  });

  return NextResponse.json({ jobId });
}

// Polling endpoint — see lib/analysisJob.ts on the client side.
export async function GET(request: Request) {
  if (!isRedisConfigured()) {
    return NextResponse.json(
      { error: "Redis 스토리지가 연결되어 있지 않습니다. Vercel 프로젝트에 Redis 통합을 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);

  // Lets the client know, before it even starts uploading anything, whether
  // a STAGE 1 checkpoint already exists for this session — drives both the
  // "이어서 분석 재개하기" button label and skipping the (possibly large)
  // audio re-upload entirely on retry (see components/RecordingDetailView.tsx).
  const checkpointFor = url.searchParams.get("checkpointFor");
  if (checkpointFor) {
    const checkpoint = await readSttCheckpoint(checkpointFor);
    return NextResponse.json({ hasCheckpoint: checkpoint !== null });
  }

  const jobId = url.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId가 전달되지 않았습니다." }, { status: 400 });
  }

  const record = await readJobRecord(jobId);
  if (!record) {
    return NextResponse.json(
      { error: "작업을 찾을 수 없습니다. 만료되었거나 존재하지 않는 작업입니다." },
      { status: 404 },
    );
  }

  return NextResponse.json(record);
}

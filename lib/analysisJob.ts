"use client";

import type { ChecklistItem, TranscriptSegment } from "@/lib/types";

export type AnalysisJobResult = {
  transcript: TranscriptSegment[];
  fullText: string;
  summary: string;
  lectureNote: string;
  checklist: ChecklistItem[];
};

export type BlobRefPayload = {
  url: string;
  fileName: string;
  mimeType: string;
};

export type AnalyzeRequestPayload = {
  // Identifies the recording across separate job attempts, independent of
  // jobId (fresh every attempt) — lets the server find a prior attempt's
  // STT checkpoint on retry (see route.ts's SttCheckpoint).
  sessionId: string;
  // Null when resuming from a checkpoint (see checkSttCheckpoint) — the
  // server never touches the original audio on a checkpoint resume, so
  // RecordingDetailView skips the (possibly large) upload entirely rather
  // than uploading it just to have the server ignore it.
  audioBlob: BlobRefPayload | null;
  referenceBlobs: BlobRefPayload[];
  bookmarks: unknown[];
  keywords: string[];
  slideThumbnails: unknown[];
  // Drives the server's chunking decision (CHUNK_THRESHOLD_MS in route.ts)
  // — see RecordingDetailView.tsx, which already tracks this for display.
  durationMs: number;
};

// createdAt is on every variant (route.ts's JobRecord always writes it) —
// pollJobUntilDone uses it as the poll timeout's origin point (see
// MAX_POLL_MS) so the 15-minute budget is anchored to when the job actually
// started, not to whenever this particular tab happened to begin/resume
// polling it.
type JobStatusResponse =
  | { status: "processing"; createdAt: number; stage?: string }
  | { status: "completed"; createdAt: number; result: AnalysisJobResult }
  | { status: "error"; createdAt: number; error: string };

const ACTIVE_JOB_KEY_PREFIX = "lecture-recorder:activeJob:";
// Matched to the server's own job TTL (see JOB_TTL_SECONDS in route.ts) —
// polling every 4s is frequent enough to feel responsive without hammering
// Redis on a job that can run for minutes.
const POLL_INTERVAL_MS = 4000;

// A hard ceiling on how long the client will keep waiting on a job before
// giving up and surfacing an error — even a very long, chunked recording
// (see route.ts's runChunkedAnalysisJob) should comfortably finish well
// inside this, so exceeding it means something's actually gone wrong
// server-side without ever managing to write a "error" job record (e.g. the
// Function process got hard-killed by a maxDuration cutoff or OOM before its
// own catch block could run — nothing server-side can guarantee catching
// that, so the client has to independently stop waiting on its own).
const MAX_POLL_MS = 15 * 60 * 1000;
export const POLL_TIMEOUT_MESSAGE = "대용량 파일 처리 중 에러가 발생했습니다. 다시 시도해 주세요.";

// A backgrounded mobile tab doesn't just stop making progress on its own —
// browsers throttle (Chrome) or fully suspend (iOS Safari/PWA) a hidden
// page's timers, so the poll loop's next `setTimeout` can land anywhere
// from late to "whenever the OS gets around to it" instead of every 4s.
// The job itself is unaffected either way (it's a server-side after()
// continuation with no live connection to this tab at all — see
// app/api/transcribe-and-summarize/route.ts) — the only thing actually
// stale is this tab's next check-in. Rather than have every caller wire up
// its own visibilitychange listener, pollJobUntilDone's own wait races
// against this single shared "the page just became visible" signal, so
// coming back to the tab triggers an immediate re-check instead of waiting
// out however much of the throttled interval is left.
const visibilityWakeTarget = typeof window !== "undefined" ? new EventTarget() : null;
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      visibilityWakeTarget?.dispatchEvent(new Event("wake"));
    }
  });
}

function delayOrWake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      visibilityWakeTarget?.removeEventListener("wake", onWake);
      resolve();
    }, ms);
    function onWake() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
    visibilityWakeTarget?.addEventListener("wake", onWake);
  });
}

// Keyed by session, not globally — this app only ever runs one analysis per
// session at a time (mirrors the isAnalyzing gate in RecordingDetailView),
// so recovering "the" active job for a session is unambiguous.
export function getStoredJobId(sessionId: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_JOB_KEY_PREFIX + sessionId);
}

export function setStoredJobId(sessionId: string, jobId: string): void {
  window.localStorage.setItem(ACTIVE_JOB_KEY_PREFIX + sessionId, jobId);
}

export function clearStoredJobId(sessionId: string): void {
  window.localStorage.removeItem(ACTIVE_JOB_KEY_PREFIX + sessionId);
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

// Kicks off analysis and returns immediately with just a job id — the
// actual work happens server-side, decoupled from this request's own
// connection (see app/api/transcribe-and-summarize/route.ts). Persisting
// the returned id (setStoredJobId) is the caller's job, not this function's,
// since a fresh start and a resumed poll both want to control that timing.
export async function startAnalysisJob(payload: AnalyzeRequestPayload): Promise<string> {
  const response = await fetch("/api/transcribe-and-summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "분석 요청에 실패했습니다."));
  }
  const data = (await response.json()) as { jobId?: string };
  if (!data.jobId) {
    throw new Error("작업 ID를 받지 못했습니다.");
  }
  return data.jobId;
}

// Checked before analysis even starts (RecordingDetailView's mount effect
// and its post-failure recheck) — drives the "이어서 분석 재개하기" button
// label and lets handleAnalyze skip re-uploading the audio file entirely
// when a prior attempt for this session already completed STAGE 1 (STT).
// Best-effort: a network hiccup here just means the button stays on its
// default label rather than blocking anything.
export async function checkSttCheckpoint(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/transcribe-and-summarize?checkpointFor=${encodeURIComponent(sessionId)}`);
    if (!response.ok) return false;
    const data = (await response.json()) as { hasCheckpoint?: unknown };
    return data.hasCheckpoint === true;
  } catch {
    return false;
  }
}

async function fetchJobStatus(jobId: string): Promise<JobStatusResponse> {
  const response = await fetch(`/api/transcribe-and-summarize?jobId=${encodeURIComponent(jobId)}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "작업 상태를 확인하지 못했습니다."));
  }
  return response.json();
}

// Polls until the job reaches a terminal state, calling onTick on every
// check so the caller can drive a "still working" UI. Safe to call after a
// page reload/reopen — this only ever reads current status from Redis, so
// picking it back up mid-job (or after it already finished while nobody was
// watching) behaves the same as watching it the whole time. Throws
// POLL_TIMEOUT_MESSAGE if the job is still "processing" MAX_POLL_MS after
// its own createdAt — see that constant for why this exists at all.
export async function pollJobUntilDone(
  jobId: string,
  onTick?: (status: JobStatusResponse) => void,
): Promise<AnalysisJobResult> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await fetchJobStatus(jobId);
    onTick?.(status);
    if (status.status === "completed") return status.result;
    if (status.status === "error") throw new Error(status.error);
    if (Date.now() - status.createdAt > MAX_POLL_MS) throw new Error(POLL_TIMEOUT_MESSAGE);
    await delayOrWake(POLL_INTERVAL_MS);
  }
}

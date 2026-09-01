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
  audioBlob: BlobRefPayload;
  referenceBlobs: BlobRefPayload[];
  bookmarks: unknown[];
  keywords: string[];
  slideThumbnails: unknown[];
};

type JobStatusResponse =
  | { status: "processing" }
  | { status: "completed"; result: AnalysisJobResult }
  | { status: "error"; error: string };

const ACTIVE_JOB_KEY_PREFIX = "lecture-recorder:activeJob:";
// Matched to the server's own job TTL (see JOB_TTL_SECONDS in route.ts) —
// polling every 4s is frequent enough to feel responsive without hammering
// Redis on a job that can run for minutes.
const POLL_INTERVAL_MS = 4000;

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
// watching) behaves the same as watching it the whole time.
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
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

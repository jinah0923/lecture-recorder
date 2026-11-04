// How much of the current background job's time budget is left.
//
// Analysis jobs run inside after() and are killed outright at the route's
// maxDuration (300s on Vercel Hobby). Steps that are optional — continuing
// a cut-off lecture note (lib/noteCompletion.ts) — check this first so they
// never turn a finished-but-truncated note into a killed job with nothing
// saved. The deadline rides on AsyncLocalStorage rather than being threaded
// through every function signature down to the model call.

import { AsyncLocalStorage } from "node:async_hooks";

const jobDeadline = new AsyncLocalStorage<number>();

export function runWithJobDeadline<T>(maxDurationSeconds: number, job: () => Promise<T>): Promise<T> {
  return jobDeadline.run(Date.now() + maxDurationSeconds * 1000, job);
}

// Infinity outside a job (e.g. a script or test) — no deadline to respect.
export function getJobTimeRemainingMs(): number {
  const deadline = jobDeadline.getStore();
  return deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
}

// How long before the platform's hard kill an AI call is stopped by us —
// ~288s of a 300s budget — leaving time to salvage the partial output,
// append the cut-off notice and save the job as completed (Vercel kills the
// process outright at maxDuration, and nothing written after that lands).
export const HARD_STOP_MARGIN_MS = 12_000;

// An AbortSignal that fires HARD_STOP_MARGIN_MS before the job's deadline;
// undefined outside a job.
export function hardStopSignal(): AbortSignal | undefined {
  const remaining = getJobTimeRemainingMs();
  if (!Number.isFinite(remaining)) return undefined;
  return AbortSignal.timeout(Math.max(0, remaining - HARD_STOP_MARGIN_MS));
}

// What a step that can't keep partial output (speech-to-text) reports when
// stopped by hardStopSignal — instead of the job simply vanishing.
export const TIME_LIMIT_MESSAGE =
  "서버 실행 시간 제한(300초)에 도달해 작업을 중단했습니다. 녹음이 길면 다시 시도할 때 이미 끝난 음성 인식 결과를 이어서 " +
  "사용합니다. 계속 실패하면 녹음을 나눠서 분석해 주세요.";

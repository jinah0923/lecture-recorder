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

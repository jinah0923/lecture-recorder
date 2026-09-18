import { NextResponse } from "next/server";

export const runtime = "nodejs";
// Never cached — the whole point is to answer with whatever THIS running
// deployment's version actually is, not a stale snapshot.
export const dynamic = "force-dynamic";

// A version marker independent of the service worker's own byte-diff update
// lifecycle (see public/sw.js) — most deploys change the app's code without
// ever touching sw.js's own file content, so the browser's native "is sw.js
// different" check alone would miss the vast majority of real releases.
// VERCEL_GIT_COMMIT_SHA changes on every deploy regardless, and is a real
// runtime env var on Vercel (not just build-time), so this always reflects
// whichever deployment is actually serving the request. Falls back to a
// per-process-start timestamp for local dev, where that var isn't set —
// still correctly flips on every `next dev` restart.
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA ?? String(Date.now());

export async function GET() {
  return NextResponse.json({ buildId: BUILD_ID });
}

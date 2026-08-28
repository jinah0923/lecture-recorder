"use client";

import { loadAllSessions, saveSession } from "@/lib/db";
import type { LectureSession } from "@/lib/types";

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

// No identifier is sent here — /api/sync derives who's asking from the
// signed-in NextAuth session cookie (sent automatically, same-origin), never
// from anything this client passes. See app/api/sync/route.ts.
async function fetchCloudSessions(): Promise<LectureSession[]> {
  const response = await fetch("/api/sync");
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "클라우드 데이터를 불러오지 못했습니다."));
  }
  const data = await response.json();
  return Array.isArray(data.sessions) ? data.sessions : [];
}

async function pushCloudSessions(sessions: LectureSession[]): Promise<void> {
  const response = await fetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "클라우드에 업로드하지 못했습니다."));
  }
}

// Union merge keyed by session id: never drops a session either side has
// that the other doesn't, and on an id both sides have, the newer
// `updatedAt` wins — this is what makes signing into an existing Google
// account on a second device safe even when that device already has its
// own local notes.
function mergeSessionLists(local: LectureSession[], cloud: LectureSession[]): LectureSession[] {
  const byId = new Map<string, LectureSession>();
  for (const session of local) byId.set(session.id, session);
  for (const session of cloud) {
    const existing = byId.get(session.id);
    if (!existing || session.updatedAt > existing.updatedAt) {
      byId.set(session.id, session);
    }
  }
  return Array.from(byId.values());
}

// Called both right after sign-in and from the manual "지금 동기화" action:
// pulls the cloud's current state, merges in whatever only exists locally
// (a session made while offline, or before this device was ever signed in),
// writes the merged result back to this device, then pushes it back to the
// cloud so both sides end up identical. Caller must already know the user is
// signed in (e.g. useSession()'s status === "authenticated") — this makes no
// such check itself.
export async function mergeAndSync(): Promise<LectureSession[]> {
  const [local, cloud] = await Promise.all([loadAllSessions(), fetchCloudSessions()]);
  const merged = mergeSessionLists(local, cloud);
  await Promise.all(merged.map((session) => saveSession(session)));
  await pushCloudSessions(merged);
  return merged;
}

// Lightweight one-way push used after a local edit — the edit just made is
// already the newest version of that session, so there's nothing to merge;
// re-fetching the cloud first would only add a redundant round trip.
export async function pushLocalSessions(): Promise<void> {
  const local = await loadAllSessions();
  await pushCloudSessions(local);
}

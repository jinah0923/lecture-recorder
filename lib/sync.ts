"use client";

import { loadAllSessions, saveSession } from "@/lib/db";
import type { LectureSession } from "@/lib/types";

const SYNC_KEY_STORAGE_KEY = "lecture-recorder:syncKey";

export function getSyncKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SYNC_KEY_STORAGE_KEY);
}

function setSyncKeyLocal(key: string): void {
  window.localStorage.setItem(SYNC_KEY_STORAGE_KEY, key);
}

export function clearSyncKeyLocal(): void {
  window.localStorage.removeItem(SYNC_KEY_STORAGE_KEY);
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

async function fetchCloudSessions(syncKey: string): Promise<LectureSession[]> {
  const response = await fetch(`/api/sync?key=${encodeURIComponent(syncKey)}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "클라우드 데이터를 불러오지 못했습니다."));
  }
  const data = await response.json();
  return Array.isArray(data.sessions) ? data.sessions : [];
}

async function pushCloudSessions(syncKey: string, sessions: LectureSession[]): Promise<void> {
  const response = await fetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ syncKey, sessions }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "클라우드에 업로드하지 못했습니다."));
  }
}

// Union merge keyed by session id: never drops a session either side has
// that the other doesn't, and on an id both sides have, the newer
// `updatedAt` wins — this is what makes turning on sync on a second device
// safe even when that device already has its own local notes.
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

// Shared by first-time key activation and the manual "지금 동기화" action:
// pulls the cloud's current state, merges in whatever only exists locally
// (a session made while offline, or before sync was ever turned on), writes
// the merged result back to this device, then pushes it back to the cloud
// so both sides end up identical.
export async function mergeAndSync(syncKey: string): Promise<LectureSession[]> {
  const [local, cloud] = await Promise.all([loadAllSessions(), fetchCloudSessions(syncKey)]);
  const merged = mergeSessionLists(local, cloud);
  await Promise.all(merged.map((session) => saveSession(session)));
  await pushCloudSessions(syncKey, merged);
  return merged;
}

export async function activateSyncKey(syncKey: string): Promise<LectureSession[]> {
  const merged = await mergeAndSync(syncKey);
  setSyncKeyLocal(syncKey);
  return merged;
}

// Lightweight one-way push used after a local edit — the edit just made is
// already the newest version of that session, so there's nothing to merge;
// re-fetching the cloud first would only add a redundant round trip.
export async function pushLocalSessions(syncKey: string): Promise<void> {
  const local = await loadAllSessions();
  await pushCloudSessions(syncKey, local);
}

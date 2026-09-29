"use client";

import { isTrashExpired, loadAllSessions, permanentlyDeleteSession, saveSession } from "@/lib/db";
import type { LectureSession } from "@/lib/types";

// Client side of per-session sync (server: app/api/sync, lib/syncStore.ts).
// Instead of moving the whole library in one request, each sync fetches a
// small manifest of {id, updatedAt, bytes}, then pulls only sessions that are
// newer in the cloud and pushes only sessions that are newer here — in
// batches kept under Vercel's 4.5MB request/response body cap.

type ManifestEntry = { id: string; updatedAt: number; bytes: number };

// Headroom under the 4.5MB platform cap for JSON wrapping and headers.
const BATCH_BYTE_BUDGET = 3 * 1024 * 1024;
// Keeps a GET ?ids=... URL comfortably short (UUIDs are 36 chars).
const MAX_IDS_PER_REQUEST = 100;

export class SyncError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SyncError";
    this.status = status;
  }
}

const PULL_FAILED = "클라우드에서 노트를 불러오지 못했습니다";
const PUSH_FAILED = "클라우드에 노트를 업로드하지 못했습니다";

function describeHttpFailure(failure: string, status: number, serverMessage: string | null): string {
  let reason: string;
  if (status === 401) reason = "로그인이 만료되었거나 로그아웃된 상태입니다. 다시 로그인해주세요";
  else if (status === 403) reason = "이 계정으로는 클라우드에 접근할 권한이 없습니다";
  else if (status === 413) reason = "한 번에 보내는 데이터가 서버 한도(4.5MB)를 넘었습니다";
  else if (status === 429) reason = "요청이 너무 많습니다. 잠시 후 다시 시도해주세요";
  else if (status === 503) reason = serverMessage ?? "클라우드 저장소를 사용할 수 없습니다";
  else if (status >= 500) reason = `서버 오류${serverMessage ? ` — ${serverMessage}` : ""}. 잠시 후 다시 시도해주세요`;
  else reason = serverMessage ?? "알 수 없는 오류";
  return `${failure}: ${reason} (HTTP ${status})`;
}

// Vercel's own platform rejections (413 FUNCTION_PAYLOAD_TOO_LARGE, 504
// timeouts) aren't JSON — the old client fell back to one generic sentence for
// all of them, which is why the real cause was invisible. The status code is
// what identifies them, so it's always included.
async function syncFetch<T>(url: string, init: RequestInit | undefined, failure: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new SyncError(`${failure}: 네트워크에 연결할 수 없습니다. 인터넷 연결을 확인해주세요`);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const serverMessage = body && typeof body.error === "string" ? body.error : null;
    throw new SyncError(describeHttpFailure(failure, response.status, serverMessage), response.status);
  }
  return response.json() as Promise<T>;
}

const encoder = new TextEncoder();
function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function batchBy<T>(items: T[], sizeOf: (item: T) => number, maxCount = Infinity): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && (currentSize + size > BATCH_BYTE_BUDGET || current.length >= maxCount)) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// No identifier is sent — /api/sync derives who's asking from the signed-in
// NextAuth session cookie, never from anything this client passes.
async function fetchManifest(): Promise<ManifestEntry[]> {
  const data = await syncFetch<{ manifest?: ManifestEntry[] }>("/api/sync?manifest=1", undefined, PULL_FAILED);
  return Array.isArray(data.manifest) ? data.manifest : [];
}

async function pullSessions(entries: ManifestEntry[]): Promise<LectureSession[]> {
  const sessions: LectureSession[] = [];
  for (const batch of batchBy(entries, (entry) => entry.bytes, MAX_IDS_PER_REQUEST)) {
    const ids = batch.map((entry) => encodeURIComponent(entry.id)).join(",");
    const data = await syncFetch<{ sessions?: LectureSession[] }>(`/api/sync?ids=${ids}`, undefined, PULL_FAILED);
    if (Array.isArray(data.sessions)) sessions.push(...data.sessions);
  }
  return sessions;
}

async function pushSessions(sessions: LectureSession[]): Promise<void> {
  for (const batch of batchBy(sessions, jsonBytes)) {
    try {
      await syncFetch(
        "/api/sync",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessions: batch }) },
        PUSH_FAILED,
      );
    } catch (error) {
      // A batch is only ever over the cap when it's a single session that
      // alone exceeds it — name it so the user knows which note is the
      // problem rather than seeing the whole sync fail anonymously.
      if (error instanceof SyncError && error.status === 413 && batch.length === 1) {
        const mb = (jsonBytes(batch[0]) / 1024 / 1024).toFixed(1);
        throw new SyncError(`'${batch[0].title}' 노트 하나가 ${mb}MB로 서버 한도(4.5MB)보다 커서 업로드할 수 없습니다 (HTTP 413)`, 413);
      }
      throw error;
    }
  }
}

export async function deleteCloudSessions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await syncFetch(
    "/api/sync",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deleteIds: ids }) },
    "클라우드에서 노트를 삭제하지 못했습니다",
  );
}

// Background pushes (after every edit) are fire-and-forget at their call
// sites, so failures are broadcast here for components/LectureStudio.tsx to
// show as a toast — otherwise they'd be swallowed and the user would never
// learn sync had stopped working.
const syncFailureTarget = typeof window !== "undefined" ? new EventTarget() : null;

export function onSyncFailure(listener: (message: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail);
  syncFailureTarget?.addEventListener("failure", handler);
  return () => syncFailureTarget?.removeEventListener("failure", handler);
}

export function reportSyncFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "동기화 중 알 수 없는 오류가 발생했습니다.";
  syncFailureTarget?.dispatchEvent(new CustomEvent("failure", { detail: message }));
}

// Called right after sign-in and from the manual "지금 동기화" action. Per id,
// the newer updatedAt wins — a session only one side has is kept, which is
// what makes signing into an existing account on a second device safe.
// Caller must already know the user is signed in.
export async function mergeAndSync(): Promise<LectureSession[]> {
  const [local, manifest] = await Promise.all([loadAllSessions(), fetchManifest()]);
  const merged = new Map(local.map((session) => [session.id, session]));
  const cloudUpdatedAt = new Map(manifest.map((entry) => [entry.id, entry.updatedAt]));

  const newerInCloud = manifest.filter((entry) => {
    const localCopy = merged.get(entry.id);
    return !localCopy || entry.updatedAt > localCopy.updatedAt;
  });
  const pulled = await pullSessions(newerInCloud);
  const pulledWinners = pulled.filter((session) => {
    const localCopy = merged.get(session.id);
    return !localCopy || session.updatedAt > localCopy.updatedAt;
  });
  for (const session of pulledWinners) merged.set(session.id, session);

  // A trashed session past its 30-day retention has to be re-checked here,
  // not just at load time — otherwise a stale "still within retention" cloud
  // copy of something this device already purged would come right back.
  const all = Array.from(merged.values());
  const expired = all.filter(isTrashExpired);
  const kept = all.filter((session) => !isTrashExpired(session));

  await Promise.all(pulledWinners.filter((session) => !isTrashExpired(session)).map((session) => saveSession(session)));
  await Promise.all(expired.map((session) => permanentlyDeleteSession(session.id)));
  await deleteCloudSessions(expired.filter((session) => cloudUpdatedAt.has(session.id)).map((session) => session.id));

  const newerHere = kept.filter((session) => {
    const cloud = cloudUpdatedAt.get(session.id);
    return cloud === undefined || session.updatedAt > cloud;
  });
  await pushSessions(newerHere);
  return kept;
}

// Lightweight push after a local edit — only sessions that are newer here
// than in the cloud (usually just the one that was edited). Unlike the old
// whole-array replace, this never removes anything from the cloud; permanent
// deletions go through deleteCloudSessions explicitly.
export async function pushLocalSessions(): Promise<void> {
  try {
    const [local, manifest] = await Promise.all([loadAllSessions(), fetchManifest()]);
    const cloudUpdatedAt = new Map(manifest.map((entry) => [entry.id, entry.updatedAt]));
    const changed = local.filter((session) => {
      const cloud = cloudUpdatedAt.get(session.id);
      return cloud === undefined || session.updatedAt > cloud;
    });
    await pushSessions(changed);
  } catch (error) {
    reportSyncFailure(error);
    throw error;
  }
}

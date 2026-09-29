// Server-side cloud storage for synced sessions (used by app/api/sync).
//
// One Redis hash per user — field = session id, value = that session's JSON
// — instead of the original single JSON array under `notes_{email}`. The array
// forced every sync to move the whole library in one HTTP body, and Vercel
// rejects Function request/response bodies over 4.5MB before the route even
// runs; with lossless lecture notes (~400KB per 90-minute lecture) that cap
// was reached around the 11th long lecture, after which every sync failed.
// Per-session storage lets the client pull/push only what changed, in
// size-bounded batches (see lib/sync.ts).

import type Redis from "ioredis";
import type { LectureSession } from "@/lib/types";

export type ManifestEntry = { id: string; updatedAt: number; bytes: number };

function hashKey(email: string): string {
  return `notes:${email}`;
}

function legacyKey(email: string): string {
  return `notes_${email}`;
}

// Only the text fields sync — the source audio never lives on LectureSession
// (audioFileName is just a filename to re-attach locally), and slide images
// have their own IndexedDB store that isn't synced (base64 image data large
// enough to blow through Redis's free-tier storage cap). Also drops any field
// a client might send that isn't part of the type.
export function stripToSyncableFields(session: LectureSession): LectureSession {
  const { id, title, category, createdAt, updatedAt, durationMs, audioFileName, audioMimeType, bookmarks, keywords, referenceFileNames, aiResult, deletedAt, sortOrder } = session;
  return {
    id,
    title,
    category,
    createdAt,
    updatedAt,
    durationMs,
    audioFileName,
    audioMimeType,
    bookmarks,
    keywords,
    referenceFileNames,
    aiResult,
    deletedAt: deletedAt ?? null,
    // Same fallback as lib/db.ts's effectiveSortOrder.
    sortOrder: sortOrder ?? updatedAt,
  };
}

function isSessionLike(value: unknown): value is LectureSession {
  const s = value as Partial<LectureSession> | null;
  return !!s && typeof s.id === "string" && s.id.length > 0 && typeof s.updatedAt === "number";
}

function parseUpdatedAt(json: string | null): number | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { updatedAt?: unknown };
    return typeof parsed.updatedAt === "number" ? parsed.updatedAt : null;
  } catch {
    return null;
  }
}

// One-time move of a user's data from the old single-array key into the
// hash. HSETNX per field so a migration racing a real upsert (two devices
// hitting the new server at once) can never overwrite a newer copy with the
// array's older one.
async function migrateLegacy(redis: Redis, email: string): Promise<void> {
  const raw = await redis.get(legacyKey(email));
  if (!raw) return;
  let sessions: unknown[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) sessions = parsed;
  } catch {
    // Unreadable legacy value — nothing salvageable to migrate.
  }
  for (const session of sessions) {
    if (!isSessionLike(session)) continue;
    await redis.hsetnx(hashKey(email), session.id, JSON.stringify(stripToSyncableFields(session)));
  }
  await redis.del(legacyKey(email));
}

export async function getManifest(redis: Redis, email: string): Promise<ManifestEntry[]> {
  await migrateLegacy(redis, email);
  const all = await redis.hgetall(hashKey(email));
  return Object.entries(all).map(([id, json]) => ({
    id,
    updatedAt: parseUpdatedAt(json) ?? 0,
    bytes: Buffer.byteLength(json),
  }));
}

export async function getSessions(redis: Redis, email: string, ids: string[]): Promise<LectureSession[]> {
  await migrateLegacy(redis, email);
  if (ids.length === 0) return [];
  const values = await redis.hmget(hashKey(email), ...ids);
  const sessions: LectureSession[] = [];
  for (const json of values) {
    if (!json) continue;
    try {
      sessions.push(JSON.parse(json) as LectureSession);
    } catch {
      // Skip a corrupt entry rather than failing the whole batch.
    }
  }
  return sessions;
}

// Kept for clients still running the pre-hash code (a PWA tab that hasn't
// reloaded since this deploy), which expect the whole library in one GET.
export async function getAllSessions(redis: Redis, email: string): Promise<LectureSession[]> {
  await migrateLegacy(redis, email);
  const all = await redis.hgetall(hashKey(email));
  return Object.values(all).flatMap((json) => {
    try {
      return [JSON.parse(json) as LectureSession];
    } catch {
      return [];
    }
  });
}

// Writes each incoming session only if it's at least as new as what's
// stored — a stale tab pushing an old copy can't clobber a newer edit made on
// another device. (Not atomic across the read and write; the only race is
// the same user editing the same session on two devices within milliseconds.)
export async function upsertSessions(
  redis: Redis,
  email: string,
  incoming: unknown[],
): Promise<{ written: number; skippedStale: number; skippedInvalid: number }> {
  await migrateLegacy(redis, email);
  const valid = incoming.filter(isSessionLike).map(stripToSyncableFields);
  const skippedInvalid = incoming.length - valid.length;
  if (valid.length === 0) return { written: 0, skippedStale: 0, skippedInvalid };

  const existing = await redis.hmget(hashKey(email), ...valid.map((s) => s.id));
  const toWrite: Record<string, string> = {};
  let skippedStale = 0;
  valid.forEach((session, index) => {
    const storedUpdatedAt = parseUpdatedAt(existing[index]);
    if (storedUpdatedAt !== null && storedUpdatedAt > session.updatedAt) {
      skippedStale++;
      return;
    }
    toWrite[session.id] = JSON.stringify(session);
  });
  if (Object.keys(toWrite).length > 0) await redis.hset(hashKey(email), toWrite);
  return { written: Object.keys(toWrite).length, skippedStale, skippedInvalid };
}

export async function deleteSessions(redis: Redis, email: string, ids: string[]): Promise<number> {
  await migrateLegacy(redis, email);
  const clean = ids.filter((id) => typeof id === "string" && id.length > 0);
  if (clean.length === 0) return 0;
  return redis.hdel(hashKey(email), ...clean);
}

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRedisClient, isRedisConfigured } from "@/lib/redis";
import { deleteSessions, getAllSessions, getManifest, getSessions, upsertSessions } from "@/lib/syncStore";

export const runtime = "nodejs";
export const maxDuration = 30;

// Per-session sync — see lib/syncStore.ts for why the library is no longer
// moved as one JSON array, and lib/sync.ts for the client side:
//   GET  ?manifest=1   -> { manifest: [{ id, updatedAt, bytes }] }  (small)
//   GET  ?ids=a,b,c    -> { sessions: [...] }   (client batches under 4.5MB)
//   POST { sessions?, deleteIds? } -> upsert (newer-or-equal wins) + delete
//   GET  (no params)   -> { sessions: all }    (only for pre-update clients)

// Identity comes from the signed-in NextAuth session (validated server-side
// from the request's session cookie), never from anything the client sends.
async function requireUserEmail(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.email ?? null;
}

// A function, not a shared constant — a Response body can only be sent once.
const redisMissing = () =>
  NextResponse.json(
    { error: "Redis 스토리지가 연결되어 있지 않습니다. Vercel 프로젝트에 Redis 통합을 연결한 뒤 다시 시도해주세요." },
    { status: 503 },
  );

function storageError(error: unknown, fallback: string) {
  return NextResponse.json({ error: error instanceof Error ? `${fallback} (${error.message})` : fallback }, { status: 502 });
}

export async function GET(request: Request) {
  if (!isRedisConfigured()) return redisMissing();
  const email = await requireUserEmail();
  if (!email) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const redis = getRedisClient();
  if (!redis) return redisMissing();

  const url = new URL(request.url);
  try {
    if (url.searchParams.get("manifest") === "1") {
      return NextResponse.json({ manifest: await getManifest(redis, email) });
    }
    const idsParam = url.searchParams.get("ids");
    if (idsParam !== null) {
      const ids = idsParam.split(",").filter(Boolean);
      return NextResponse.json({ sessions: await getSessions(redis, email, ids) });
    }
    return NextResponse.json({ sessions: await getAllSessions(redis, email) });
  } catch (error) {
    return storageError(error, "클라우드 데이터를 불러오지 못했습니다");
  }
}

export async function POST(request: Request) {
  if (!isRedisConfigured()) return redisMissing();
  const email = await requireUserEmail();
  if (!email) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const redis = getRedisClient();
  if (!redis) return redisMissing();

  let body: { sessions?: unknown; deleteIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  const deleteIds = Array.isArray(body.deleteIds) ? body.deleteIds.filter((id): id is string => typeof id === "string") : [];
  if (!Array.isArray(body.sessions) && !Array.isArray(body.deleteIds)) {
    return NextResponse.json({ error: "동기화할 노트 데이터가 올바르지 않습니다." }, { status: 400 });
  }

  try {
    const upserted = await upsertSessions(redis, email, sessions);
    const deleted = await deleteSessions(redis, email, deleteIds);
    return NextResponse.json({ success: true, ...upserted, deleted });
  } catch (error) {
    return storageError(error, "클라우드에 저장하지 못했습니다");
  }
}

import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import type { LectureSession } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const SYNC_KEY_MIN_LENGTH = 1;
const SYNC_KEY_MAX_LENGTH = 64;

// Vercel KV's env vars (KV_REST_API_URL / KV_REST_API_TOKEN) only exist once
// a KV store is linked to the project — without them `kv.get`/`kv.set` throw
// an opaque connection error, so this is checked up front for a clear
// Korean message instead of a 500 with a stack trace.
function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function sanitizeSyncKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < SYNC_KEY_MIN_LENGTH || trimmed.length > SYNC_KEY_MAX_LENGTH) return null;
  return trimmed;
}

function kvKeyFor(syncKey: string): string {
  return `notes_${syncKey}`;
}

// Only the text fields sync — see LectureSession's own shape (lib/types.ts):
// the source audio never lives on this type in the first place (audioFileName
// is just a filename to re-attach locally), and slide images are kept out
// deliberately here too since they're base64 image data large enough to blow
// through Vercel KV's free-tier storage cap, same reasoning as audio.
function stripToSyncableFields(session: LectureSession): LectureSession {
  const { id, title, category, createdAt, updatedAt, durationMs, audioFileName, audioMimeType, bookmarks, keywords, referenceFileName, aiResult } = session;
  return { id, title, category, createdAt, updatedAt, durationMs, audioFileName, audioMimeType, bookmarks, keywords, referenceFileName, aiResult };
}

export async function GET(request: Request) {
  if (!isKvConfigured()) {
    return NextResponse.json(
      { error: "Vercel KV가 연결되어 있지 않습니다. 프로젝트에 KV 스토리지를 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const syncKey = sanitizeSyncKey(url.searchParams.get("key"));
  if (!syncKey) {
    return NextResponse.json({ error: "유효한 동기화 키를 입력해주세요." }, { status: 400 });
  }

  try {
    const sessions = await kv.get<LectureSession[]>(kvKeyFor(syncKey));
    return NextResponse.json({ sessions: sessions ?? [] });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "클라우드 데이터를 불러오지 못했습니다." },
      { status: 502 },
    );
  }
}

type SyncRequestBody = {
  syncKey?: unknown;
  sessions?: unknown;
};

export async function POST(request: Request) {
  if (!isKvConfigured()) {
    return NextResponse.json(
      { error: "Vercel KV가 연결되어 있지 않습니다. 프로젝트에 KV 스토리지를 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }

  let body: SyncRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const syncKey = sanitizeSyncKey(body.syncKey);
  if (!syncKey) {
    return NextResponse.json({ error: "유효한 동기화 키를 입력해주세요." }, { status: 400 });
  }
  if (!Array.isArray(body.sessions)) {
    return NextResponse.json({ error: "동기화할 노트 데이터가 올바르지 않습니다." }, { status: 400 });
  }

  const sessions = (body.sessions as LectureSession[]).map(stripToSyncableFields);

  try {
    await kv.set(kvKeyFor(syncKey), sessions);
    return NextResponse.json({ success: true, count: sessions.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "클라우드에 업로드하지 못했습니다." },
      { status: 502 },
    );
  }
}

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { kv } from "@vercel/kv";
import { authOptions } from "@/lib/auth";
import type { LectureSession } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

// Vercel KV's env vars (KV_REST_API_URL / KV_REST_API_TOKEN) only exist once
// a KV store is linked to the project — without them `kv.get`/`kv.set` throw
// an opaque connection error, so this is checked up front for a clear
// Korean message instead of a 500 with a stack trace.
function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function kvKeyFor(email: string): string {
  return `notes_${email}`;
}

// Identity now comes from the signed-in NextAuth session (validated
// server-side from the request's session cookie), never from anything the
// client sends — unlike the old syncKey model, this makes it impossible for
// one user to read or overwrite another user's notes by guessing a string.
async function requireUserEmail(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.email ?? null;
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

export async function GET() {
  if (!isKvConfigured()) {
    return NextResponse.json(
      { error: "Vercel KV가 연결되어 있지 않습니다. 프로젝트에 KV 스토리지를 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }

  const email = await requireUserEmail();
  if (!email) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const sessions = await kv.get<LectureSession[]>(kvKeyFor(email));
    return NextResponse.json({ sessions: sessions ?? [] });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "클라우드 데이터를 불러오지 못했습니다." },
      { status: 502 },
    );
  }
}

type SyncRequestBody = {
  sessions?: unknown;
};

export async function POST(request: Request) {
  if (!isKvConfigured()) {
    return NextResponse.json(
      { error: "Vercel KV가 연결되어 있지 않습니다. 프로젝트에 KV 스토리지를 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }

  const email = await requireUserEmail();
  if (!email) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  let body: SyncRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  if (!Array.isArray(body.sessions)) {
    return NextResponse.json({ error: "동기화할 노트 데이터가 올바르지 않습니다." }, { status: 400 });
  }

  const sessions = (body.sessions as LectureSession[]).map(stripToSyncableFields);

  try {
    await kv.set(kvKeyFor(email), sessions);
    return NextResponse.json({ success: true, count: sessions.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "클라우드에 업로드하지 못했습니다." },
      { status: 502 },
    );
  }
}

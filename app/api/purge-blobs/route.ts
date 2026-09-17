import { NextResponse } from "next/server";
import { del } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 30;

// Matches the proxy URL shape lib/blobUpload.ts's buildDeepDiveImageProxyUrl
// generates and app/api/deep-dive-image/route.ts serves — a markdown image
// embedded in a lecture note (![...](url)) points here, with the actual
// private Blob URL carried in the `url` query param.
const PROXY_URL_PATTERN = /\/api\/deep-dive-image\?url=([^)\s"']+)/g;

// Same hostname check as app/api/deep-dive-image/route.ts — only ever
// deletes a blob that was already reachable through our own proxy (and
// therefore already embedded in a note the caller had legitimate access
// to), never an arbitrary attacker-supplied URL.
function isOwnPrivateBlobUrl(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl);
    return protocol === "https:" && hostname.endsWith(".private.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

function extractBlobUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(PROXY_URL_PATTERN)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (isOwnPrivateBlobUrl(decoded)) urls.push(decoded);
  }
  return urls;
}

// Called when a session is permanently removed (individual "영구 삭제",
// "휴지통 비우기", or the 30-day auto-purge — see components/LectureStudio.tsx)
// to clean up any "AI 심화 탐구" image blobs that only that session's
// lectureNote/summary text ever referenced. Nothing else in the app tracks
// these blobs once the session row itself is gone, so this is the only
// point they'd ever get cleaned up — otherwise they'd sit in Blob storage
// forever as orphaned cost with no session left to show them.
export async function POST(request: Request) {
  let body: { texts?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const texts = Array.isArray(body.texts) ? body.texts.filter((item): item is string => typeof item === "string") : [];
  const urls = Array.from(new Set(texts.flatMap(extractBlobUrls)));

  await Promise.all(
    urls.map((url) =>
      del(url).catch((error) => {
        console.error("[purge-blobs] failed to delete blob", { url, error });
      }),
    ),
  );

  return NextResponse.json({ deleted: urls.length });
}

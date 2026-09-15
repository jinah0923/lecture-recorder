import { NextResponse } from "next/server";
import { get } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This project's Vercel Blob store is private-only (rejects access:"public"
// uploads outright — confirmed directly against the real store). "AI 심화
// 탐구" image attachments (see components/ReviewPanel.tsx) still need a URL
// that stays resolvable forever with no auth — the viewer's browser and
// Notion's server both need to load it, and neither can authenticate to
// Vercel Blob. This route is that public face: it holds the
// BLOB_READ_WRITE_TOKEN server-side, does the authenticated fetch on the
// caller's behalf, and streams the bytes back to anyone. The private blob
// URL itself never needs to be secret for this to be safe — a bare
// unauthenticated fetch of a private blob's own URL already 403s, so
// exposing that URL in this route's `?url=` query param (and, from there, in
// the note's markdown) grants no access beyond what this route chooses to
// serve.
function isAllowedBlobUrl(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl);
    return protocol === "https:" && hostname.endsWith(".private.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const blobUrl = new URL(request.url).searchParams.get("url");
  if (!blobUrl || !isAllowedBlobUrl(blobUrl)) {
    return NextResponse.json({ error: "유효하지 않은 이미지 URL입니다." }, { status: 400 });
  }

  try {
    const result = await get(blobUrl, { access: "private" });
    if (!result || !result.stream) {
      return NextResponse.json({ error: "이미지를 찾을 수 없습니다." }, { status: 404 });
    }
    return new NextResponse(result.stream, {
      headers: {
        "Content-Type": result.blob.contentType || "application/octet-stream",
        // Content at a given blob pathname never changes (uploads always get
        // a random suffix — see lib/blobUpload.ts) — safe to cache forever,
        // both in the browser and by Notion's own image-fetching proxy.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("[deep-dive-image] failed to read blob", { error });
    return NextResponse.json({ error: "이미지를 불러오지 못했습니다." }, { status: 502 });
  }
}

import { NextResponse } from "next/server";
import { handleUpload } from "@vercel/blob/client";
import type { HandleUploadBody } from "@vercel/blob/client";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Issues short-lived client tokens for direct browser -> Vercel Blob
// uploads (see lib/blobUpload.ts). Google's Gemini Files API doesn't
// support this — a direct browser upload to it was tried first and Google's
// endpoint rejects the cross-origin request outright (no CORS headers at
// all; confirmed directly, not assumed) — so Vercel Blob is the actual
// bridge for a 50+ minute lecture recording: audio lands here first, then
// app/api/transcribe-and-summarize/route.ts downloads it server-side (a
// server-to-server fetch, which is subject to neither browser CORS nor
// Vercel's 4.5MB request-body cap) and forwards it on to Gemini.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB — generous ceiling for a multi-hour lecture

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["audio/*", "application/pdf", "text/plain", "image/*"],
        addRandomSuffix: true,
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
      }),
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "업로드 토큰 발급에 실패했습니다." },
      { status: 400 },
    );
  }
}

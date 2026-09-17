"use client";

import { upload } from "@vercel/blob/client";

export type UploadedBlobRef = {
  url: string;
  fileName: string;
  mimeType: string;
};

// Uploads a file directly from the browser to Vercel Blob storage — never
// through our own backend — which is what actually avoids Vercel's 4.5MB
// request-body cap and Function duration budget for a 50+ minute lecture
// recording. This is Vercel's own documented pattern for exactly this
// problem; Gemini's own Files API upload endpoint doesn't support direct
// browser uploads at all (no CORS support — confirmed directly), so the
// file lands here first and app/api/transcribe-and-summarize/route.ts
// downloads it server-side and forwards it on to Gemini from there instead.
export async function uploadFileToBlob(
  file: Blob,
  fileName: string,
  mimeType: string,
  onProgress?: (fraction: number) => void,
): Promise<UploadedBlobRef> {
  const result = await upload(fileName, file, {
    access: "private",
    handleUploadUrl: "/api/blob-upload",
    contentType: mimeType,
    onUploadProgress: ({ percentage }) => onProgress?.(percentage / 100),
  });
  return { url: result.url, fileName, mimeType: result.contentType || mimeType };
}

// "AI 심화 탐구" image attachments (see components/ReviewPanel.tsx) reuse
// uploadFileToBlob above (private access — this project's Blob store was
// provisioned private-only and rejects access:"public" uploads outright).
// Unlike the audio/reference uploads, though, this URL needs to stay
// resolvable forever afterward — the AI embeds it as a markdown image in the
// note, later rendered by the viewer's own browser and by Notion's server
// when exporting, and neither can authenticate to fetch a private blob
// directly. This wraps the raw private URL in our own public proxy route
// (app/api/deep-dive-image/route.ts), which holds the BLOB_READ_WRITE_TOKEN
// server-side and streams the bytes out to anyone — the private URL itself
// stays opaque to the outside world either way (a bare fetch of it 403s).
export function buildDeepDiveImageProxyUrl(blobUrl: string): string {
  return `${window.location.origin}/api/deep-dive-image?url=${encodeURIComponent(blobUrl)}`;
}

// Called when a session is permanently removed (see components/LectureStudio.tsx —
// individual "영구 삭제", "휴지통 비우기", or the 30-day auto-purge) to clean
// up any deep-dive image blobs only that session ever referenced. Best-effort
// — the session row itself is already gone either way by the time this runs,
// so a failed cleanup just means a small amount of orphaned Blob storage
// rather than anything the user would notice.
export async function purgeSessionBlobs(texts: string[]): Promise<void> {
  if (texts.length === 0) return;
  try {
    await fetch("/api/purge-blobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
    });
  } catch {
    // non-critical — see comment above
  }
}

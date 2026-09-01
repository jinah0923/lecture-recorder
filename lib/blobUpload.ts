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

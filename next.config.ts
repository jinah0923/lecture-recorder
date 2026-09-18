import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static resolves its bundled binary's path via `path.join(__dirname,
  // "ffmpeg")` (see node_modules/ffmpeg-static/index.js) — if webpack bundles
  // that file into a .next/server/vendor-chunks/ chunk, __dirname resolves to
  // the CHUNK's location instead of the real node_modules/ffmpeg-static/
  // directory, so the binary is never found (ENOENT) despite existing on
  // disk. Keeping it external (unbundled, required at its real path at
  // runtime) is the standard fix and matches how @vercel/blob-style native
  // binaries are meant to be consumed under Next.js's file tracing.
  serverExternalPackages: ["ffmpeg-static"],
  // Route Handlers (app/api/**/route.ts) have no Next.js-level body size cap
  // at all — the old Pages Router `export const config = { api: { bodyParser:
  // { sizeLimit } } }` knob doesn't exist for App Router route handlers, so
  // there's nothing to raise there.
  //
  // Separately — and this genuinely isn't configurable from application code
  // at all — Vercel caps every Function's request/response body at 4.5MB
  // platform-wide (see https://vercel.com/docs/functions/limitations,
  // checked 2026-08); exceeding it returns 413 FUNCTION_PAYLOAD_TOO_LARGE
  // before the route's own code ever runs. A 50+ minute lecture recording
  // sails past that easily, so audio/reference files no longer travel
  // through any Vercel Function's request body at all: the browser uploads
  // them directly to Vercel Blob storage instead (lib/blobUpload.ts +
  // app/api/blob-upload/route.ts hand the client a short-lived signed
  // upload token — a direct browser upload to Gemini's own Files API was
  // tried first and rejected outright by Google's endpoint, no CORS support
  // at all), and app/api/transcribe-and-summarize/route.ts downloads each
  // blob server-side and forwards it on to Gemini from there.
  //
  // This next block raises the one body-size knob Next.js does expose
  // (Server Actions, 1MB by default) in case a Server Action ever needs to
  // accept a large upload directly.
  experimental: {
    serverActions: {
      bodySizeLimit: "150mb",
    },
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Route Handlers (app/api/**/route.ts) have no Next.js-level body size cap
  // at all — the old Pages Router `export const config = { api: { bodyParser:
  // { sizeLimit } } }` knob doesn't exist for App Router route handlers, so
  // there's nothing to raise there. The app-level ceiling for large lecture
  // uploads is instead enforced in the route itself (MAX_AUDIO_BYTES/
  // MAX_REFERENCE_BYTES in app/api/transcribe-and-summarize/route.ts) plus
  // whatever Gemini's Files API accepts.
  //
  // Separately — and this genuinely isn't configurable from application code
  // at all — Vercel caps every Function's request/response body at 4.5MB
  // platform-wide (see https://vercel.com/docs/functions/limitations,
  // checked 2026-08); exceeding it returns 413 FUNCTION_PAYLOAD_TOO_LARGE
  // before the route's own code ever runs. Vercel's own guidance is that a
  // Function using streaming (which this route's Edge runtime + SSE response
  // already does) is exempt, but the only way to be certain regardless of
  // file size is to never route the raw bytes through a Function at all —
  // e.g. a direct client → storage upload — which this app doesn't do today.
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

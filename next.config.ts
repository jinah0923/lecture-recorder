import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Route Handlers (app/api/**/route.ts) have no Next.js-level body size cap
  // in the Node runtime — the actual ceiling for large lecture uploads is
  // enforced in the route itself (MAX_AUDIO_BYTES/MAX_REFERENCE_BYTES in
  // app/api/transcribe-and-summarize/route.ts) plus the Gemini Files API.
  // This raises the one body-size knob Next.js does expose (Server Actions,
  // 1MB by default) in case a Server Action ever needs to accept a large
  // upload directly.
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;

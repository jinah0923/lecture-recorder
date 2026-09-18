"use client";

import { useEffect, useRef, useState } from "react";

// A long-lived open tab has no other way to learn that a newer deployment
// exists — its JS keeps running in memory indefinitely regardless of any
// service worker activity, which only ever affects what a future
// reload/navigation fetches, not what's already loaded. Checked again
// whenever the tab regains focus (same visibilitychange pattern as
// lib/analysisJob.ts's poll-wake) rather than waiting out the full
// interval, plus a periodic fallback for a tab nobody ever backgrounds.
const BUILD_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Registers /public/sw.js and watches for a newer deployment, surfacing a
 * "새로고침" prompt instead of silently leaving the tab on stale JS.
 * Production-only — see the two effects below for why. */
export function ServiceWorkerRegister() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const knownBuildIdRef = useRef<string | null>(null);

  // Mechanism 1: genuine service-worker-lifecycle detection. Only fires when
  // sw.js's own file bytes actually changed (the browser diffs it on
  // registration/navigation) — correct and real, but most deploys never
  // touch that file, so this alone would miss the vast majority of
  // releases. Kept as a real signal anyway since it's the standard,
  // explicitly-requested mechanism and costs nothing to also listen for.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // A controller already existing means this is a genuine update
            // replacing a previously-active worker, not the very first
            // install on a fresh visit (which has nothing to "update" from).
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              setUpdateAvailable(true);
            }
          });
        });
      })
      .catch(() => {});
  }, []);

  // Mechanism 2: the actual reliable signal — app/api/build-info/route.ts
  // answers with whichever deployment is currently serving requests
  // (VERCEL_GIT_COMMIT_SHA), so this catches every real release, not just
  // the rare ones that happen to also change sw.js's own bytes.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;

    let cancelled = false;

    async function checkBuildVersion() {
      try {
        const response = await fetch("/api/build-info", { cache: "no-store" });
        const data = (await response.json()) as { buildId?: unknown };
        if (cancelled || typeof data.buildId !== "string") return;
        if (knownBuildIdRef.current === null) {
          knownBuildIdRef.current = data.buildId;
          return;
        }
        if (data.buildId !== knownBuildIdRef.current) setUpdateAvailable(true);
      } catch {
        // Network hiccup — the next interval tick or visibility check retries.
      }
    }

    checkBuildVersion();
    const interval = window.setInterval(checkBuildVersion, BUILD_CHECK_INTERVAL_MS);
    function handleVisibility() {
      if (document.visibilityState === "visible") checkBuildVersion();
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  if (!updateAvailable) return null;

  return (
    <div className="safe-pb fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-full bg-zinc-900/95 px-4 py-3 text-sm text-white shadow-lg dark:bg-zinc-800/95">
        <span>새로운 업데이트가 있습니다.</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="shrink-0 rounded-full bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-400"
        >
          🔄 새로고침
        </button>
      </div>
    </div>
  );
}

"use client";

import { useEffect } from "react";

/** Registers /public/sw.js. Production-only — registering it in dev would
 * have it start intercepting fetches for a cache that Fast Refresh's own
 * hashed chunks make stale almost immediately, fighting the dev workflow
 * for no benefit (nothing dev needs is served from cache anyway). */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  return null;
}

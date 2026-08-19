"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

/** Fixed top-right on every screen (the app is a single client-rendered
 * SPA under LectureStudio, so a layout-level placement is the only way to
 * guarantee it survives every screen without threading a prop through). */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The persisted theme lives in localStorage, invisible to the server —
  // rendering the real icon before mount would flip between light/dark on
  // hydration. A neutral placeholder of the same size avoids that flash
  // and any layout shift once the real icon appears.
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div
        aria-hidden="true"
        className="fixed right-4 top-4 z-50 h-9 w-9 rounded-full border border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      />
    );
  }

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      title={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      className="fixed right-4 top-4 z-50 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-base shadow-sm transition-colors hover:bg-slate-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
    >
      {isDark ? "☀️" : "🌙"}
    </button>
  );
}

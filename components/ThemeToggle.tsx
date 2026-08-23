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
        className="fixed right-4 top-[max(1rem,env(safe-area-inset-top))] z-50 h-9 w-9 rounded-full border border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      />
    );
  }

  const isDark = resolvedTheme === "dark";

  function toggleTheme() {
    const nextTheme = isDark ? "light" : "dark";
    // next-themes applies its class itself via its own effect, but that runs
    // a tick after this click handler — on slower devices the background/
    // text (driven purely by that class through Tailwind's `dark:` variant)
    // can visibly lag behind the icon, which reads `resolvedTheme` straight
    // from React state. Apply it here too, synchronously, mirroring exactly
    // what next-themes' own effect does (attribute="class" mode sets the
    // *theme name itself* as the class, not just a "dark" boolean, so both
    // "light" and "dark" must be removed first) — next-themes' effect then
    // lands moments later as a no-op on top of this.
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(nextTheme);
    setTheme(nextTheme);
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      title={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      className="fixed right-4 top-[max(1rem,env(safe-area-inset-top))] z-50 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-base shadow-sm transition-colors hover:bg-slate-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
    >
      {isDark ? "☀️" : "🌙"}
    </button>
  );
}

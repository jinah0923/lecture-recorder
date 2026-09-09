"use client";

import { useEffect, useState } from "react";

type MarkdownImageProps = {
  alt: string;
  src: string;
};

/** Renders a general `![alt](https://...)` markdown image — e.g. an AI-cited
 * external reference image for the "AI 심화 탐구" feature (see the
 * [content는 마크다운 형식] prompt rule in app/api/expand-note/route.ts).
 * Unlike SlideImage's locally-cached data: URLs, this is a live network
 * fetch of a URL the AI wrote, so it has to tolerate the request failing
 * (dead link, hotlink-blocked, taken down) with a clear fallback instead of
 * a broken-image icon. */
export function MarkdownImage({ alt, src }: MarkdownImageProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  if (failed) {
    return (
      <div className="my-1 rounded-xl border border-dashed border-slate-200 bg-zinc-50 px-3 py-4 text-center text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-800/40 dark:text-zinc-500">
        🖼️ {alt || "이미지"}를 불러올 수 없습니다.
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="group my-1 block w-full overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition hover:border-indigo-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external URL, not an app-local asset Next/Image can optimize */}
        <img src={src} alt={alt} className="w-full object-contain" onError={() => setFailed(true)} />
        {alt && (
          <p className="border-t border-slate-100 px-3 py-1.5 text-[11px] font-medium text-zinc-500 transition group-hover:text-indigo-600 dark:border-zinc-800 dark:text-zinc-400 dark:group-hover:text-indigo-400">
            🖼️ {alt} · 클릭해서 크게 보기
          </p>
        )}
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setIsOpen(false)}
          role="presentation"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external URL, not an app-local asset Next/Image can optimize */}
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="닫기"
            className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

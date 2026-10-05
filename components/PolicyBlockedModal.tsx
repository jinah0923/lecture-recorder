"use client";

import type { ReactNode } from "react";
import { PROHIBITED_CONTENT_MESSAGE } from "@/lib/geminiMessages";

// Shown instead of the generic failure toast when Gemini rejects a request as
// PROHIBITED_CONTENT (see lib/geminiMessages.ts). A modal rather than a toast:
// retrying unchanged will fail the same way, so the user has to read it.
// children: optional follow-up action (RecordingDetailView's OpenAI retry button).
export function PolicyBlockedModal({
  detail,
  onClose,
  children,
}: {
  detail: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-2xl bg-slate-50 p-5 shadow-xl dark:bg-zinc-900"
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="policy-blocked-title"
        aria-describedby="policy-blocked-message"
      >
        <h2 id="policy-blocked-title" className="text-base font-semibold text-red-600 dark:text-red-400">
          🛡️ AI 분석이 차단되었습니다
        </h2>
        <p id="policy-blocked-message" className="mt-3 break-words text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          {PROHIBITED_CONTENT_MESSAGE}
        </p>
        {detail && (
          <p className="mt-3 break-words rounded-lg bg-slate-100 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {detail}
          </p>
        )}
        {children}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500"
          >
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

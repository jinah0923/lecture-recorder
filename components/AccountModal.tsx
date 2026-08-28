"use client";

import { useEffect, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { mergeAndSync } from "@/lib/sync";

type AccountModalProps = {
  onClose: () => void;
  /** Called after a sync writes freshly merged data into IndexedDB, so the
   * screen above can re-read it. */
  onSynced: () => void;
};

type Status = "idle" | "loading" | "error";

export function AccountModal({ onClose, onSynced }: AccountModalProps) {
  const { data: session, status: sessionStatus } = useSession();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncedCount, setSyncedCount] = useState<number | null>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleSyncNow() {
    setStatus("loading");
    setErrorMessage(null);
    try {
      const merged = await mergeAndSync();
      setSyncedCount(merged.length);
      onSynced();
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "동기화 중 오류가 발생했습니다.");
    }
  }

  const isAuthenticated = sessionStatus === "authenticated" && Boolean(session?.user);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:px-4 sm:py-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-2xl bg-slate-50 shadow-2xl dark:bg-zinc-900 sm:max-h-[85vh] sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-modal-title"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2 id="account-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            ☁️ 계정 및 동기화
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {sessionStatus === "loading" ? (
            <div className="flex items-center justify-center py-8">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-500 dark:border-zinc-700" />
            </div>
          ) : isAuthenticated ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-800">
                {session?.user?.image ? (
                  // Google's avatar CDN — a plain <img> avoids Next/Image's
                  // remote-domain allowlist config for a single small icon.
                  <img
                    src={session.user.image}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-9 w-9 shrink-0 rounded-full"
                  />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
                    {(session?.user?.email ?? "?").charAt(0).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0">
                  {session?.user?.name && (
                    <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {session.user.name}
                    </p>
                  )}
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{session?.user?.email}</p>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                이 Google 계정으로 강의노트가 동기화됩니다. 같은 계정으로 로그인한 다른 기기와 노트가
                자동으로 합쳐집니다.
              </p>
              {syncedCount !== null && (
                <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                  ✅ {syncedCount}개의 노트가 동기화되었습니다.
                </p>
              )}
              <button
                type="button"
                onClick={() => signOut()}
                className="self-start text-[11px] text-zinc-400 underline decoration-dotted transition hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                로그아웃
              </button>
              {status === "error" && errorMessage && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600 dark:bg-red-950/40 dark:text-red-400">
                  {errorMessage}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                Google 계정으로 로그인하면 PC와 모바일 등 여러 기기에서 강의노트가 자동으로
                동기화됩니다.
              </p>
              <div className="rounded-lg bg-zinc-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
                💡 요약·강의노트·스크립트·체크리스트 같은 텍스트만 클라우드에 동기화됩니다. 녹음 원본
                오디오 파일은 용량 문제로 동기화되지 않고 각 기기에만 저장돼요.
              </div>
            </div>
          )}
        </div>

        <div className="safe-pb flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-4 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            닫기
          </button>
          {isAuthenticated ? (
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={status === "loading"}
              className="flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
            >
              {status === "loading" && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              )}
              {status === "loading" ? "동기화 중..." : "지금 동기화"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => signIn("google")}
              disabled={sessionStatus === "loading"}
              className="flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
            >
              Google 계정으로 로그인
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

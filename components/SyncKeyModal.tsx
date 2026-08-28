"use client";

import { useEffect, useState } from "react";
import { activateSyncKey, clearSyncKeyLocal, getSyncKey, mergeAndSync } from "@/lib/sync";

type SyncKeyModalProps = {
  onClose: () => void;
  /** Called after a merge (activation or manual re-sync) writes fresh data
   * into IndexedDB, so the screen above can re-read it. */
  onSynced: () => void;
};

type Status = "idle" | "loading" | "error";

export function SyncKeyModal({ onClose, onSynced }: SyncKeyModalProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncedCount, setSyncedCount] = useState<number | null>(null);

  useEffect(() => {
    setActiveKey(getSyncKey());
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleActivate() {
    const key = input.trim();
    if (!key) {
      setStatus("error");
      setErrorMessage("동기화 키를 입력해주세요.");
      return;
    }
    setStatus("loading");
    setErrorMessage(null);
    try {
      const merged = await activateSyncKey(key);
      setActiveKey(key);
      setSyncedCount(merged.length);
      onSynced();
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "동기화 중 오류가 발생했습니다.");
    }
  }

  async function handleSyncNow() {
    if (!activeKey) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const merged = await mergeAndSync(activeKey);
      setSyncedCount(merged.length);
      onSynced();
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "동기화 중 오류가 발생했습니다.");
    }
  }

  function handleDeactivate() {
    clearSyncKeyLocal();
    setActiveKey(null);
    setInput("");
    setSyncedCount(null);
    setStatus("idle");
    setErrorMessage(null);
  }

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
        aria-labelledby="sync-key-modal-title"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2 id="sync-key-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            ☁️ 기기 간 동기화
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
          {activeKey ? (
            <div className="flex flex-col gap-4">
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                이 기기는 아래 동기화 키로 연결되어 있어요. 같은 키를 입력한 다른 기기와 노트가 함께
                합쳐집니다.
              </p>
              <div className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
                {activeKey}
              </div>
              {syncedCount !== null && (
                <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                  ✅ {syncedCount}개의 노트가 동기화되었습니다.
                </p>
              )}
              <button
                type="button"
                onClick={handleDeactivate}
                className="self-start text-[11px] text-zinc-400 underline decoration-dotted transition hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                이 기기에서 동기화 해제 (클라우드 데이터는 유지됩니다)
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
                PC와 모바일 등 여러 기기에서 강의노트를 함께 보려면 나만의 동기화 키를 만들어주세요. 같은
                키를 입력한 기기끼리 노트가 자동으로 합쳐집니다.
              </p>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  동기화 키
                </label>
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="예: minji1234 (4자리 비밀번호나 닉네임 등 자유롭게)"
                  className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                  이 키를 다른 기기에도 똑같이 입력하면 두 기기의 노트가 합쳐집니다. 잊어버리지 않게
                  기억해두세요.
                </p>
              </div>
              <div className="rounded-lg bg-zinc-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
                💡 요약·강의노트·스크립트·체크리스트 같은 텍스트만 클라우드에 동기화됩니다. 녹음 원본
                오디오 파일은 용량 문제로 동기화되지 않고 각 기기에만 저장돼요.
              </div>
              {status === "error" && errorMessage && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600 dark:bg-red-950/40 dark:text-red-400">
                  {errorMessage}
                </p>
              )}
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
          <button
            type="button"
            onClick={activeKey ? handleSyncNow : handleActivate}
            disabled={status === "loading"}
            className="flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {status === "loading" && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {status === "loading" ? "동기화 중..." : activeKey ? "지금 동기화" : "동기화 시작"}
          </button>
        </div>
      </div>
    </div>
  );
}

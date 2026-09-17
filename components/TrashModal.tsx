"use client";

import { useEffect } from "react";
import { formatDateTime } from "@/lib/format";
import type { LectureSessionSummary } from "@/lib/types";

const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type TrashModalProps = {
  items: LectureSessionSummary[];
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onEmptyTrash: () => void;
  onClose: () => void;
};

function remainingDaysLabel(deletedAt: number | null): string {
  if (!deletedAt) return "";
  const elapsedDays = (Date.now() - deletedAt) / DAY_MS;
  const remaining = Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - elapsedDays));
  return remaining <= 0 ? "오늘 자동 삭제 예정" : `${remaining}일 후 자동 삭제`;
}

export function TrashModal({ items, onRestore, onPermanentDelete, onEmptyTrash, onClose }: TrashModalProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:px-4 sm:py-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl bg-slate-50 shadow-2xl dark:bg-zinc-900 sm:max-h-[80vh] sm:max-w-lg sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trash-modal-title"
      >
        <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2 id="trash-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            🗑️ 휴지통
          </h2>
          <div className="flex items-center gap-1.5">
            {items.length > 0 && (
              <button
                type="button"
                onClick={onEmptyTrash}
                className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                휴지통 비우기
              </button>
            )}
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
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">휴지통이 비어있어요</p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">삭제한 녹음은 30일간 여기 보관됩니다</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                      <span>{item.category}</span>
                      <span>·</span>
                      <span>{item.deletedAt ? `${formatDateTime(item.deletedAt)} 삭제됨` : ""}</span>
                    </p>
                    <p className="mt-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                      ⏳ {remainingDaysLabel(item.deletedAt)}
                    </p>
                  </div>
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => onRestore(item.id)}
                      className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      ↩ 복원
                    </button>
                    <button
                      type="button"
                      onClick={() => onPermanentDelete(item.id)}
                      className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
                    >
                      영구 삭제
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

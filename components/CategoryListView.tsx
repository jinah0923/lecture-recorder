"use client";

import { formatDateTime, formatDuration } from "@/lib/format";
import type { LectureSessionSummary } from "@/lib/types";

type CategoryListViewProps = {
  category: string;
  sessions: LectureSessionSummary[];
  onSelectSession: (session: LectureSessionSummary) => void;
  onDeleteSession: (id: string) => void;
  onNewRecording: () => void;
};

export function CategoryListView({
  category,
  sessions,
  onSelectSession,
  onDeleteSession,
  onNewRecording,
}: CategoryListViewProps) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onNewRecording}
          className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          + &apos;{category}&apos;에 새 녹음
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-16 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">아직 녹음이 없어요</p>
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">이 카테고리에 첫 녹음을 추가해보세요</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 shadow-sm transition hover:border-indigo-200 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-900"
            >
              <button
                type="button"
                onClick={() => onSelectSession(session)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{session.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{formatDateTime(session.updatedAt)}</span>
                  <span>·</span>
                  <span className="font-mono">{formatDuration(session.durationMs)}</span>
                  {session.hasAiResult && (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                      요약 완료
                    </span>
                  )}
                </p>
              </button>
              <button
                type="button"
                onClick={() => onDeleteSession(session.id)}
                aria-label="녹음 삭제"
                className="shrink-0 rounded-full p-1.5 text-zinc-400 transition hover:bg-red-50 hover:text-red-500 dark:text-zinc-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path
                    d="M6 7h12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

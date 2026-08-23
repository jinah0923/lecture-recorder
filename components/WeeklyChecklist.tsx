"use client";

import { useState } from "react";
import type { ChecklistFeedItem } from "@/lib/types";

type WeeklyChecklistProps = {
  items: ChecklistFeedItem[];
  onToggle: (sessionId: string, itemId: string) => void;
  onNavigateToSession: (sessionId: string) => void;
};

export function WeeklyChecklist({ items, onToggle, onNavigateToSession }: WeeklyChecklistProps) {
  const [filter, setFilter] = useState<"all" | "pending">("all");

  const total = items.length;
  const doneCount = items.filter((item) => item.done).length;
  const visibleItems = filter === "pending" ? items.filter((item) => !item.done) : items;
  const progressPercent = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">이번 주 해야 할 일</h2>
          {total > 0 && (
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {doneCount} / {total} 완료
            </p>
          )}
        </div>
        {total > 0 && (
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                filter === "all"
                  ? "bg-indigo-600 text-white"
                  : "border border-slate-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              전체 보기
            </button>
            <button
              type="button"
              onClick={() => setFilter("pending")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                filter === "pending"
                  ? "bg-indigo-600 text-white"
                  : "border border-slate-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              미완료만 보기
            </button>
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className="h-full rounded-full bg-indigo-600 transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      {total === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          녹음 분석을 완료하면 이곳에 이번 주 할 일이 자동으로 모입니다.
        </p>
      ) : visibleItems.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          미완료 항목이 없어요. 모두 완료했어요!
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleItems.map((item) => (
            <li
              key={`${item.sessionId}-${item.id}`}
              className="flex items-start gap-3 rounded-xl bg-zinc-50 px-3 py-2.5 dark:bg-zinc-800/60"
            >
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => onToggle(item.sessionId, item.id)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-600 dark:bg-zinc-900"
              />
              <div className="min-w-0 flex-1">
                <p className={item.done ? "text-sm text-zinc-400 line-through dark:text-zinc-600" : "text-sm text-zinc-700 dark:text-zinc-300"}>
                  {item.text}
                </p>
                <button
                  type="button"
                  onClick={() => onNavigateToSession(item.sessionId)}
                  className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-zinc-500 transition hover:border-indigo-200 hover:text-indigo-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-indigo-800 dark:hover:text-indigo-400"
                >
                  <span className="shrink-0 font-medium">{item.category}</span>
                  <span className="shrink-0">·</span>
                  <span className="truncate">{item.sessionTitle}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

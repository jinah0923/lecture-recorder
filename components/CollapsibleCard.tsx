"use client";

import { useState, type ReactNode } from "react";

type CollapsibleCardProps = {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
};

export function CollapsibleCard({ title, subtitle, defaultOpen = false, badge, children }: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{title}</p>
          {subtitle && <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {badge}
          <svg
            viewBox="0 0 24 24"
            className={`h-4 w-4 text-zinc-400 transition-transform dark:text-zinc-500 ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>
      {open && <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">{children}</div>}
    </div>
  );
}

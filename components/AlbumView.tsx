"use client";

import { formatDateTime } from "@/lib/format";

type CategorySummary = {
  name: string;
  count: number;
  updatedAt: number;
};

type AlbumViewProps = {
  categories: CategorySummary[];
  onSelectCategory: (name: string) => void;
  onAddCategory: () => void;
};

export function AlbumView({ categories, onSelectCategory, onAddCategory }: AlbumViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">내 카테고리 앨범</h2>
        <button
          type="button"
          onClick={onAddCategory}
          className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          + 카테고리 추가
        </button>
      </div>

      {categories.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-16 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">아직 카테고리가 없어요</p>
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            &apos;+ 카테고리 추가&apos; 버튼으로 첫 카테고리를 만들어보세요
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {categories.map((category) => (
            <button
              key={category.name}
              type="button"
              onClick={() => onSelectCategory(category.name)}
              className="flex flex-col items-start gap-3 rounded-2xl border border-zinc-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-900"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path
                    d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div className="min-w-0 w-full">
                <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{category.name}</p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {category.count > 0 ? `${category.count}개의 녹음` : "비어있음"}
                </p>
                {category.updatedAt > 0 && (
                  <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">{formatDateTime(category.updatedAt)}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

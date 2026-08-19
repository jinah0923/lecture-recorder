"use client";

type PaginationProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onTop: () => void;
};

type PageToken = number | "ellipsis";

// Full run for short lists; first/last + a window around the current page
// (with "…" gaps) once there are enough pages that showing every number
// would just be noise.
function buildPageTokens(current: number, total: number): PageToken[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const keep = new Set<number>([1, total, current - 1, current, current + 1]);
  const sorted = Array.from(keep)
    .filter((page) => page >= 1 && page <= total)
    .sort((a, b) => a - b);

  const tokens: PageToken[] = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) tokens.push("ellipsis");
    tokens.push(page);
    previous = page;
  }
  return tokens;
}

/** UI-only pagination bar — view concern exclusively; callers are
 * responsible for keeping exports/storage on the full, unpaginated data. */
export function Pagination({ page, totalPages, onPageChange, onTop }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-1">
        {buildPageTokens(page, totalPages).map((token, index) =>
          token === "ellipsis" ? (
            <span key={`ellipsis-${index}`} className="px-1 text-xs text-zinc-400 dark:text-zinc-500">
              …
            </span>
          ) : (
            <button
              key={token}
              type="button"
              onClick={() => onPageChange(token)}
              aria-current={token === page ? "page" : undefined}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-medium transition ${
                token === page
                  ? "border border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/50 dark:text-indigo-300"
                  : "border border-transparent text-zinc-500 hover:border-zinc-200 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {token}
            </button>
          ),
        )}
      </div>
      <button
        type="button"
        onClick={onTop}
        className="flex shrink-0 items-center gap-1 rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/40 dark:hover:text-indigo-300"
      >
        ▲ TOP
      </button>
    </div>
  );
}

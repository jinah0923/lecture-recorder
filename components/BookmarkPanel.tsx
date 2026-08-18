"use client";

import { formatDuration } from "@/lib/format";
import type { Bookmark } from "@/lib/types";

type BookmarkPanelProps = {
  bookmarks: Bookmark[];
  elapsedMs: number;
  isRecording: boolean;
  onBookmarksChange: (bookmarks: Bookmark[]) => void;
  onSeek: (ms: number) => void;
  allowAdd?: boolean;
  variant?: "list" | "cards";
  emptyText?: string;
};

export function BookmarkPanel({
  bookmarks,
  elapsedMs,
  isRecording,
  onBookmarksChange,
  onSeek,
  allowAdd = true,
  variant = "list",
  emptyText = "녹음 중 북마크를 추가해보세요",
}: BookmarkPanelProps) {
  function addBookmark() {
    const next: Bookmark = {
      id: crypto.randomUUID(),
      label: `북마크 ${bookmarks.length + 1}`,
      atMs: elapsedMs,
    };
    onBookmarksChange([...bookmarks, next]);
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">북마크</p>
        {allowAdd && (
          <button
            type="button"
            onClick={addBookmark}
            disabled={!isRecording}
            className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            + 추가
          </button>
        )}
      </div>

      {bookmarks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-400">
          {emptyText}
        </p>
      ) : variant === "cards" ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {bookmarks.map((bookmark) => (
            <button
              key={bookmark.id}
              type="button"
              onClick={() => onSeek(bookmark.atMs)}
              className="flex flex-col items-start gap-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
            >
              <span className="truncate text-sm font-medium text-zinc-700">{bookmark.label}</span>
              <span className="font-mono text-xs text-zinc-500">{formatDuration(bookmark.atMs)}</span>
            </button>
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {bookmarks.map((bookmark) => (
            <li key={bookmark.id}>
              <button
                type="button"
                onClick={() => onSeek(bookmark.atMs)}
                className="flex w-full items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-sm transition hover:bg-indigo-50"
              >
                <span className="text-zinc-700">{bookmark.label}</span>
                <span className="font-mono text-xs text-zinc-500">
                  {formatDuration(bookmark.atMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

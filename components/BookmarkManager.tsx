"use client";

import { useState, type FormEvent } from "react";
import { formatDuration, parseTimestamp } from "@/lib/format";
import type { Bookmark } from "@/lib/types";

type BookmarkManagerProps = {
  bookmarks: Bookmark[];
  // Persisted by the caller with the rest of the session (IndexedDB autosave,
  // then cloud sync when signed in — see RecordingDetailView).
  onBookmarksChange: (bookmarks: Bookmark[]) => void;
  // Seeks the audio player to `ms` and starts playback.
  onSeek: (ms: number) => void;
  // The player's current position, or null when no audio is loaded.
  getCurrentTimeMs: () => number | null;
  canPlay: boolean;
  // Recording length, to catch a typed time past the end. 0 = unknown.
  durationMs: number;
};

// The saved-session counterpart of BookmarkPanel (which only adds bookmarks
// live while recording): type or capture a time, add a memo, jump to it,
// delete it.
export function BookmarkManager({
  bookmarks,
  onBookmarksChange,
  onSeek,
  getCurrentTimeMs,
  canPlay,
  durationMs,
}: BookmarkManagerProps) {
  const [timeInput, setTimeInput] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);

  function captureCurrentTime() {
    const ms = getCurrentTimeMs();
    if (ms === null) return;
    setTimeInput(formatDuration(ms));
    setError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const atMs = parseTimestamp(timeInput);
    if (atMs === null) {
      setError("시간을 MM:SS 형식으로 입력해주세요 (예: 12:30).");
      return;
    }
    if (durationMs > 0 && atMs > durationMs) {
      setError(`녹음 길이(${formatDuration(durationMs)})보다 뒤의 시간입니다.`);
      return;
    }
    const next: Bookmark = {
      id: crypto.randomUUID(),
      label: memo.trim() || `북마크 ${bookmarks.length + 1}`,
      atMs,
    };
    // Kept in time order so the list reads like the lecture's timeline.
    onBookmarksChange([...bookmarks, next].sort((a, b) => a.atMs - b.atMs));
    setTimeInput("");
    setMemo("");
    setError(null);
  }

  function removeBookmark(id: string) {
    onBookmarksChange(bookmarks.filter((bookmark) => bookmark.id !== id));
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          북마크{bookmarks.length > 0 ? ` ${bookmarks.length}` : ""}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mb-3 flex flex-wrap items-center gap-1.5">
        <input
          value={timeInput}
          onChange={(event) => {
            setTimeInput(event.target.value);
            setError(null);
          }}
          placeholder="MM:SS"
          inputMode="numeric"
          aria-label="북마크 시간 (MM:SS)"
          className="w-20 shrink-0 rounded-lg border border-slate-200 bg-slate-100 px-2.5 py-1.5 font-mono text-sm text-slate-900 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <button
          type="button"
          onClick={captureCurrentTime}
          disabled={!canPlay}
          aria-label="현재 재생 시간 캡처"
          title={canPlay ? "재생 중인 위치를 시간 칸에 넣습니다" : "오디오를 불러오면 사용할 수 있어요"}
          className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          ⏱️ 현재 재생 시간 캡처
        </button>
        <input
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
          placeholder="메모 (예: 시험 범위 공지)"
          aria-label="북마크 메모"
          maxLength={200}
          className="min-w-0 flex-1 basis-40 rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          추가
        </button>
      </form>
      {error && <p className="-mt-1.5 mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {bookmarks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          저장된 북마크 없음
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {bookmarks.map((bookmark) => (
            <li
              key={bookmark.id}
              className="flex items-center gap-2 rounded-lg bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/60"
            >
              <button
                type="button"
                onClick={() => onSeek(bookmark.atMs)}
                disabled={!canPlay}
                aria-label={`${formatDuration(bookmark.atMs)} 위치로 이동해 재생`}
                title={canPlay ? "이 시간으로 이동해 재생" : "오디오를 불러오면 이 시간으로 이동할 수 있어요"}
                className="shrink-0 rounded-md bg-indigo-50 px-2 py-1 font-mono text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-950/50 dark:text-indigo-300 dark:hover:bg-indigo-900/60"
              >
                ▶ {formatDuration(bookmark.atMs)}
              </button>
              <span className="min-w-0 flex-1 break-words text-sm text-zinc-700 dark:text-zinc-300">{bookmark.label}</span>
              <button
                type="button"
                onClick={() => removeBookmark(bookmark.id)}
                aria-label={`'${bookmark.label}' 북마크 삭제`}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-red-50 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

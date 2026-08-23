"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Pagination } from "@/components/Pagination";
import { formatDuration } from "@/lib/format";
import type { TranscriptSegment } from "@/lib/types";

type TranscriptPanelProps = {
  transcript: TranscriptSegment[];
  onSeek: (ms: number) => void;
  onTranscriptChange: (nextTranscript: TranscriptSegment[]) => void;
  /** Fired once per genuine text change, with the text right before and
   * after this edit — lets the parent run global-term-sync against it. */
  onSegmentCommitted?: (oldText: string, newText: string) => void;
};

const AUTOSAVE_DEBOUNCE_MS = 300;
// UI-only pagination — onTranscriptChange/onSegmentCommitted above always
// receive/operate on the full `transcript` array regardless of which page
// is currently shown, so search/edit/export/autosave never see a slice.
// Character-count based (not a fixed segment count), counting spaces.
const CHARS_PER_PAGE = 1000;

// Accumulates whole segments onto a page until the next one would push the
// page past CHARS_PER_PAGE, then starts a new page — mirrors LectureNote's
// section-based pagination so a page holds a consistent amount of reading.
function paginateSegments(segments: TranscriptSegment[]): TranscriptSegment[][] {
  if (segments.length === 0) return [[]];

  const pages: TranscriptSegment[][] = [];
  let currentSegments: TranscriptSegment[] = [];
  let currentLength = 0;

  for (const segment of segments) {
    if (currentSegments.length > 0 && currentLength + segment.text.length > CHARS_PER_PAGE) {
      pages.push(currentSegments);
      currentSegments = [];
      currentLength = 0;
    }
    currentSegments.push(segment);
    currentLength += segment.text.length;
  }
  if (currentSegments.length > 0) pages.push(currentSegments);

  return pages;
}

function highlightText(text: string, query: string): ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, index) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={index} className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-500/40 dark:text-yellow-100">
        {part}
      </mark>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

export function TranscriptPanel({
  transcript,
  onSeek,
  onTranscriptChange,
  onSegmentCommitted,
}: TranscriptPanelProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  // isSaving reflects only "is a debounce timer currently pending" — it is
  // always cleared (via try/finally in commit()) once that timer fires or a
  // blur/Enter flushes it, so the "수정 중..." indicator can never get stuck.
  const [isSaving, setIsSaving] = useState(false);
  const [hasSavedOnce, setHasSavedOnce] = useState(false);

  const debounceRef = useRef<number | null>(null);
  const segmentRefs = useRef(new Map<string, HTMLDivElement>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  // Tracks the last text WE committed for the segment being edited — used
  // instead of re-reading the `transcript` prop, which can still reflect a
  // stale value for a moment after onTranscriptChange schedules a parent
  // re-render (would otherwise risk double-firing onSegmentCommitted).
  const committedTextRef = useRef<string>("");
  // Mirrors whatever's currently scheduled, so an unmount mid-debounce (e.g.
  // the whole review screen closing) flushes instead of silently dropping it.
  const pendingRef = useRef<{ id: string; text: string } | null>(null);
  // useEffect(..., []) below only ever sees its first render's closure —
  // mirror the latest `commit` into a ref so the unmount flush isn't stuck
  // acting on a stale `transcript`/callback snapshot from mount time.
  const commitRef = useRef<(id: string, text: string) => void>(() => {});

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (pendingRef.current) commitRef.current(pendingRef.current.id, pendingRef.current.text);
    };
  }, []);

  useEffect(() => {
    if (!editingId || !textareaRef.current) return;
    const el = textareaRef.current;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editingId]);

  // Recomputing pagination the instant a debounced autosave commits (while
  // the user is still mid-edit, textarea focused) could shift the edited
  // segment onto a different page and unmount its textarea out from under
  // them. So pagination is frozen to its pre-edit snapshot for the duration
  // of an edit, and only re-synced once editing stops (see effect below).
  const lastStableTranscriptRef = useRef<TranscriptSegment[]>(transcript);
  useEffect(() => {
    if (!editingId) lastStableTranscriptRef.current = transcript;
  }, [transcript, editingId]);

  const segmentPages = useMemo(
    () => paginateSegments(editingId ? lastStableTranscriptRef.current : transcript),
    [editingId, transcript],
  );
  const totalPages = segmentPages.length;
  const currentPage = Math.min(page, totalPages);
  const visibleSegments = segmentPages[currentPage - 1] ?? [];

  // A fresh transcript (new analysis) should land back on page 1 rather
  // than an out-of-range page left over from the previous one.
  useEffect(() => {
    setPage(1);
  }, [transcript.length]);

  const firstMatchId = useMemo(() => {
    if (!query.trim()) return null;
    const lowered = query.toLowerCase();
    return transcript.find((segment) => segment.text.toLowerCase().includes(lowered))?.id ?? null;
  }, [transcript, query]);

  // Search jumps to whichever page holds the match, then scrolls to it once
  // that page has actually rendered (hence splitting into two effects).
  useEffect(() => {
    if (!firstMatchId) return;
    const pageIndex = segmentPages.findIndex((pageSegments) => pageSegments.some((segment) => segment.id === firstMatchId));
    if (pageIndex === -1) return;
    setPage(pageIndex + 1);
  }, [firstMatchId, segmentPages]);

  useEffect(() => {
    if (!firstMatchId) return;
    segmentRefs.current.get(firstMatchId)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [firstMatchId, page]);

  function scrollToTop() {
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function goToPage(next: number) {
    setPage(next);
    scrollToTop();
  }

  // Pure local state update — no network/AI call. try/finally guarantees
  // isSaving always resolves to false, even on the no-op path (text unchanged
  // since the last commit) or if a listener throws, so the "수정 중..."
  // indicator can never hang past this call.
  function commit(id: string, text: string) {
    try {
      if (text === committedTextRef.current) return;
      const oldText = committedTextRef.current;
      committedTextRef.current = text;
      onTranscriptChange(transcript.map((segment) => (segment.id === id ? { ...segment, text } : segment)));
      onSegmentCommitted?.(oldText, text);
      setHasSavedOnce(true);
    } finally {
      pendingRef.current = null;
      setIsSaving(false);
    }
  }
  commitRef.current = commit;

  function scheduleSave(id: string, text: string) {
    setIsSaving(true);
    pendingRef.current = { id, text };
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      commit(id, text);
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function startEditing(segment: TranscriptSegment) {
    setEditingId(segment.id);
    setDraftText(segment.text);
    committedTextRef.current = segment.text;
  }

  function handleDraftChange(value: string) {
    setDraftText(value);
    if (editingId) scheduleSave(editingId, value);
  }

  function flushAndStopEditing() {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (editingId) {
      commit(editingId, draftText);
    } else {
      setIsSaving(false);
    }
    setEditingId(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      flushAndStopEditing();
      return;
    }
    if (event.key !== "Escape") return;
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    pendingRef.current = null;
    setIsSaving(false);
    setEditingId(null);
  }

  return (
    <section ref={cardRef} className="flex min-h-0 flex-col rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">변환된 스크립트</h2>
        {(isSaving || hasSavedOnce) && (
          <span className={`text-[11px] font-medium ${isSaving ? "text-zinc-400 dark:text-zinc-500" : "text-emerald-600 dark:text-emerald-400"}`}>
            {isSaving ? "수정 중..." : "저장됨 ✓"}
          </span>
        )}
      </div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="스크립트에서 검색..."
        className="mb-2 w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      {query.trim() && !firstMatchId && (
        <p className="mb-2 text-xs text-zinc-400 dark:text-zinc-500">일치하는 내용이 없습니다.</p>
      )}
      <p className="mb-2 text-[11px] text-zinc-400 dark:text-zinc-500">💡 텍스트를 클릭하면 오타를 직접 수정할 수 있어요.</p>
      <div className="max-h-72 overflow-y-auto rounded-xl border border-zinc-100 p-2 dark:border-zinc-800">
        {visibleSegments.map((segment) => (
          <div
            key={segment.id}
            ref={(el) => {
              if (el) segmentRefs.current.set(segment.id, el);
              else segmentRefs.current.delete(segment.id);
            }}
            className={`mb-1 flex items-start gap-2 rounded-lg px-1 py-1 ${
              segment.id === firstMatchId ? "bg-yellow-50 dark:bg-yellow-500/10" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => onSeek(segment.startMs)}
              title="이 지점으로 이동"
              className="mt-0.5 shrink-0 rounded px-1 py-0.5 font-mono text-xs text-zinc-400 transition hover:bg-indigo-100 hover:text-indigo-600 dark:text-zinc-500 dark:hover:bg-indigo-950/50 dark:hover:text-indigo-400"
            >
              {formatDuration(segment.startMs)}
            </button>
            {editingId === segment.id ? (
              <textarea
                ref={textareaRef}
                autoFocus
                rows={1}
                value={draftText}
                onChange={(event) => handleDraftChange(event.target.value)}
                onInput={(event) => {
                  const el = event.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                onBlur={flushAndStopEditing}
                onKeyDown={handleKeyDown}
                className="flex-1 resize-none overflow-hidden rounded-lg border border-indigo-300 bg-white px-2 py-1 text-sm text-zinc-700 outline-none dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            ) : (
              <p
                onClick={() => startEditing(segment)}
                title="클릭해서 수정"
                className="flex-1 cursor-text rounded-lg px-2 py-1 text-sm text-zinc-700 transition hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
              >
                {highlightText(segment.text, query)}
              </p>
            )}
          </div>
        ))}
      </div>
      <Pagination page={currentPage} totalPages={totalPages} onPageChange={goToPage} onTop={scrollToTop} />
    </section>
  );
}

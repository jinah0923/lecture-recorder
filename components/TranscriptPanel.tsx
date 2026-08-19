"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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

function highlightText(text: string, query: string): ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, index) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={index} className="rounded bg-yellow-200 px-0.5">
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

  const firstMatchId = (() => {
    if (!query.trim()) return null;
    const lowered = query.toLowerCase();
    return transcript.find((segment) => segment.text.toLowerCase().includes(lowered))?.id ?? null;
  })();

  function handleSearchChange(value: string) {
    setQuery(value);
    if (!value.trim()) return;
    const lowered = value.toLowerCase();
    const match = transcript.find((segment) => segment.text.toLowerCase().includes(lowered));
    if (match) {
      segmentRefs.current.get(match.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
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
    <section className="flex min-h-0 flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">변환된 스크립트</h2>
        {(isSaving || hasSavedOnce) && (
          <span className={`text-[11px] font-medium ${isSaving ? "text-zinc-400" : "text-emerald-600"}`}>
            {isSaving ? "수정 중..." : "저장됨 ✓"}
          </span>
        )}
      </div>
      <input
        type="search"
        value={query}
        onChange={(event) => handleSearchChange(event.target.value)}
        placeholder="스크립트에서 검색..."
        className="mb-2 w-full rounded-lg border border-zinc-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-300"
      />
      {query.trim() && !firstMatchId && (
        <p className="mb-2 text-xs text-zinc-400">일치하는 내용이 없습니다.</p>
      )}
      <p className="mb-2 text-[11px] text-zinc-400">💡 텍스트를 클릭하면 오타를 직접 수정할 수 있어요.</p>
      <div className="max-h-72 overflow-y-auto rounded-xl border border-zinc-100 p-2">
        {transcript.map((segment) => (
          <div
            key={segment.id}
            ref={(el) => {
              if (el) segmentRefs.current.set(segment.id, el);
              else segmentRefs.current.delete(segment.id);
            }}
            className={`mb-1 flex items-start gap-2 rounded-lg px-1 py-1 ${
              segment.id === firstMatchId ? "bg-yellow-50" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => onSeek(segment.startMs)}
              title="이 지점으로 이동"
              className="mt-0.5 shrink-0 rounded px-1 py-0.5 font-mono text-xs text-zinc-400 transition hover:bg-indigo-100 hover:text-indigo-600"
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
                className="flex-1 resize-none overflow-hidden rounded-lg border border-indigo-300 bg-white px-2 py-1 text-sm text-zinc-700 outline-none"
              />
            ) : (
              <p
                onClick={() => startEditing(segment)}
                title="클릭해서 수정"
                className="flex-1 cursor-text rounded-lg px-2 py-1 text-sm text-zinc-700 transition hover:bg-zinc-50"
              >
                {highlightText(segment.text, query)}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

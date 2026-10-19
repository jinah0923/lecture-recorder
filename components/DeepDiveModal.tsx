"use client";

import { useEffect, useRef, useState } from "react";
import { EXPAND_MODE_LABELS } from "@/lib/expandMode";
import { renderMarkdown } from "@/lib/markdown";
import type { DraftBlock } from "@/lib/types";

type DeepDiveModalProps = {
  lectureNote: string;
  draftBlocks: DraftBlock[];
  isExpanding: boolean;
  /** Result of the latest new request — shown here since the modal covers
   * the panel's own message area. */
  notice?: string | null;
  onConfirmBlock: (id: string) => void;
  onCancelBlock: (id: string) => void;
  /** Rewrites the block per the instruction; resolves to null on success or
   * the message to show on that block (e.g. nothing in the recording backs it). */
  onRefineBlock: (id: string, instruction: string) => Promise<string | null>;
  onSave: () => void;
  onClose: () => void;
};

// Shared by the three block action buttons. relative + z-10 keeps them above
// the rendered block content; 32px on touch screens, 24px from sm up.
const ACTION_BUTTON_CLASS =
  "relative z-10 flex h-8 w-8 cursor-pointer touch-manipulation items-center justify-center rounded-full text-sm font-bold " +
  "text-white transition disabled:cursor-not-allowed disabled:opacity-50 sm:h-6 sm:w-6 sm:text-xs";

export function DeepDiveModal({
  lectureNote,
  draftBlocks,
  isExpanding,
  notice,
  onConfirmBlock,
  onCancelBlock,
  onRefineBlock,
  onSave,
  onClose,
}: DeepDiveModalProps) {
  const [feedbackOpenId, setFeedbackOpenId] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [refiningId, setRefiningId] = useState<string | null>(null);
  const [blockNotices, setBlockNotices] = useState<Record<string, string>>({});
  const feedbackInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // The instruction box opens right under the block's header; bring it into
  // view and focus it so the click visibly does something even when the
  // block sits low in the scroll area.
  useEffect(() => {
    if (!feedbackOpenId) return;
    const input = feedbackInputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [feedbackOpenId]);

  const allConfirmed = draftBlocks.length > 0 && draftBlocks.every((block) => block.status === "confirmed");
  const confirmedCount = draftBlocks.filter((block) => block.status === "confirmed").length;

  function toggleFeedback(id: string) {
    setFeedbackOpenId((current) => (current === id ? null : id));
    setFeedbackText("");
  }

  async function submitFeedback(id: string) {
    const instruction = feedbackText.trim();
    if (!instruction || refiningId) return;
    setRefiningId(id);
    setBlockNotices((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      const failure = await onRefineBlock(id, instruction);
      if (failure) {
        // Keep the box open with the text so it can be reworded.
        setBlockNotices((current) => ({ ...current, [id]: failure }));
      } else {
        setFeedbackText("");
        setFeedbackOpenId(null);
      }
    } finally {
      setRefiningId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 sm:items-center sm:px-4 sm:py-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-2xl bg-slate-50 shadow-2xl dark:bg-zinc-900 sm:max-h-[85vh] sm:max-w-2xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="deep-dive-modal-title"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2 id="deep-dive-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            🔍 AI 심화 탐구 검수
          </h2>
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

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">기존 강의노트</p>
          <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">{renderMarkdown(lectureNote)}</div>

          <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            새로 제안된 블록
          </p>
          {notice && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">{notice}</p>
          )}
          <div className="flex flex-col gap-3">
            {draftBlocks.map((block) => {
              const isRefining = refiningId === block.id;
              const feedbackOpen = feedbackOpenId === block.id;
              return (
                <div
                  key={block.id}
                  className="relative rounded-xl border-2 border-violet-200 bg-violet-50 p-3 dark:border-violet-900/50 dark:bg-violet-950/30"
                >
                  <div className="relative z-10 mb-1.5 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-violet-900 dark:text-violet-300">💜 {block.title}</p>
                      {block.mode && (
                        <span
                          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            block.mode === "deepDive"
                              ? "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300"
                              : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                          }`}
                        >
                          {EXPAND_MODE_LABELS[block.mode]}
                        </span>
                      )}
                    </div>
                    {block.status === "confirmed" ? (
                      <span className="shrink-0 rounded-full bg-violet-600 px-2 py-0.5 text-[11px] font-medium text-white">
                        확정됨 ✓
                      </span>
                    ) : (
                      <div className="relative z-10 flex shrink-0 gap-1.5 sm:gap-1">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onConfirmBlock(block.id);
                          }}
                          disabled={isRefining}
                          aria-label="확정"
                          title="확정"
                          className={`${ACTION_BUTTON_CLASS} bg-emerald-500 hover:bg-emerald-600`}
                        >
                          v
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onCancelBlock(block.id);
                          }}
                          disabled={isRefining}
                          aria-label="취소"
                          title="취소"
                          className={`${ACTION_BUTTON_CLASS} bg-red-400 hover:bg-red-500`}
                        >
                          x
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleFeedback(block.id);
                          }}
                          disabled={isRefining}
                          aria-label="추가 수정 지시"
                          aria-expanded={feedbackOpen}
                          title="이 블록에 추가 수정 지시"
                          className={`${ACTION_BUTTON_CLASS} ${
                            feedbackOpen ? "bg-violet-600 hover:bg-violet-700" : "bg-zinc-400 hover:bg-zinc-500"
                          }`}
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>

                  {feedbackOpen && block.status !== "confirmed" && (
                    <div className="relative z-10 mb-2 rounded-lg border border-violet-200 bg-white p-2 dark:border-violet-900/50 dark:bg-zinc-900">
                      <label
                        htmlFor={`refine-${block.id}`}
                        className="mb-1 block text-[11px] font-medium text-violet-700 dark:text-violet-300"
                      >
                        이 블록을 어떻게 고칠까요?
                      </label>
                      <textarea
                        id={`refine-${block.id}`}
                        ref={feedbackInputRef}
                        value={feedbackText}
                        rows={2}
                        onChange={(event) => setFeedbackText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            void submitFeedback(block.id);
                          } else if (event.key === "Escape") {
                            // Closes just this box, not the whole modal.
                            event.stopPropagation();
                            setFeedbackOpenId(null);
                          }
                        }}
                        disabled={isRefining}
                        placeholder="예: 표로 정리해 줘 / 교수님 예시를 더 넣어 줘 / 이 개념을 더 자세히 알려줘(심화)"
                        className="w-full resize-none rounded-md border border-violet-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-violet-400 disabled:opacity-60 dark:border-violet-900/50 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                      <div className="mt-1.5 flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setFeedbackOpenId(null)}
                          disabled={isRefining}
                          className="rounded-md px-2.5 py-1 text-xs text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
                        >
                          닫기
                        </button>
                        <button
                          type="button"
                          onClick={() => void submitFeedback(block.id)}
                          disabled={isRefining || isExpanding || !feedbackText.trim()}
                          className="rounded-md bg-violet-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isRefining ? "수정 중..." : "이 지시로 다시 작성"}
                        </button>
                      </div>
                    </div>
                  )}

                  {blockNotices[block.id] && (
                    <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                      {blockNotices[block.id]}
                    </p>
                  )}

                  <div className={`mt-1 rounded-lg bg-white/60 p-2.5 dark:bg-zinc-900/40 ${isRefining ? "opacity-50" : ""}`}>
                    {renderMarkdown(block.content)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="safe-pb flex items-center justify-between border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            {draftBlocks.length === 0
              ? "확정된 항목이 없습니다"
              : `${confirmedCount} / ${draftBlocks.length} 확정됨`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-200 px-4 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              닫기
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!allConfirmed || refiningId !== null}
              className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
            >
              최종 완성본 저장
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

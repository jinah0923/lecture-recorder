"use client";

import { useEffect, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";
import type { DraftBlock } from "@/lib/types";

type DeepDiveModalProps = {
  lectureNote: string;
  draftBlocks: DraftBlock[];
  isExpanding: boolean;
  onConfirmBlock: (id: string) => void;
  onCancelBlock: (id: string) => void;
  onRefineBlock: (id: string, feedback: string) => void;
  onSave: () => void;
  onClose: () => void;
};

export function DeepDiveModal({
  lectureNote,
  draftBlocks,
  isExpanding,
  onConfirmBlock,
  onCancelBlock,
  onRefineBlock,
  onSave,
  onClose,
}: DeepDiveModalProps) {
  const [feedbackOpenId, setFeedbackOpenId] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const allConfirmed = draftBlocks.length > 0 && draftBlocks.every((block) => block.status === "confirmed");
  const confirmedCount = draftBlocks.filter((block) => block.status === "confirmed").length;

  function submitFeedback(id: string) {
    if (!feedbackText.trim()) return;
    onRefineBlock(id, feedbackText.trim());
    setFeedbackText("");
    setFeedbackOpenId(null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900"
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
            새로 제안된 심화 탐구 블록
          </p>
          <div className="flex flex-col gap-3">
            {draftBlocks.map((block) => (
              <div key={block.id} className="rounded-xl border-2 border-violet-200 bg-violet-50 p-3 dark:border-violet-900/50 dark:bg-violet-950/30">
                <div className="mb-1.5 flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-violet-900 dark:text-violet-300">💜 {block.title}</p>
                  {block.status === "confirmed" ? (
                    <span className="shrink-0 rounded-full bg-violet-600 px-2 py-0.5 text-[11px] font-medium text-white">
                      확정됨 ✓
                    </span>
                  ) : (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => onConfirmBlock(block.id)}
                        aria-label="확정"
                        title="확정"
                        className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-xs font-bold text-white transition hover:bg-emerald-600"
                      >
                        v
                      </button>
                      <button
                        type="button"
                        onClick={() => onCancelBlock(block.id)}
                        aria-label="취소"
                        title="취소"
                        className="flex h-6 w-6 items-center justify-center rounded-full bg-red-400 text-xs font-bold text-white transition hover:bg-red-500"
                      >
                        x
                      </button>
                      <button
                        type="button"
                        onClick={() => setFeedbackOpenId((current) => (current === block.id ? null : block.id))}
                        aria-label="추가 피드백"
                        title="추가 피드백"
                        className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-400 text-xs font-bold text-white transition hover:bg-zinc-500"
                      >
                        +
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-sm text-violet-900 dark:text-violet-200">
                  <strong>① 개념 정의</strong>: {block.definition}
                </p>
                <p className="mt-1 text-sm text-violet-900 dark:text-violet-200">
                  <strong>② 심층 설명</strong>: {block.deepDive}
                </p>
                <p className="mt-1 text-sm text-violet-900 dark:text-violet-200">
                  <strong>③ 실생활 예시</strong>: {block.example}
                </p>

                {feedbackOpenId === block.id && (
                  <div className="mt-2 flex gap-1.5">
                    <input
                      value={feedbackText}
                      onChange={(event) => setFeedbackText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitFeedback(block.id);
                      }}
                      placeholder="무엇을 더 알고 싶은가요? (예: 더 쉬운 예시 추가)"
                      className="flex-1 rounded-lg border border-violet-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-violet-400 dark:border-violet-900/50 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                    <button
                      type="button"
                      onClick={() => submitFeedback(block.id)}
                      disabled={isExpanding || !feedbackText.trim()}
                      className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      재질의
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            {draftBlocks.length === 0
              ? "확정된 항목이 없습니다"
              : `${confirmedCount} / ${draftBlocks.length} 확정됨`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-zinc-200 px-4 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              닫기
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!allConfirmed}
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

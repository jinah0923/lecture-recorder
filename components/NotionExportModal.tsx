"use client";

import { useEffect, useState } from "react";
import { extractNotionId } from "@/lib/notionUtils";
import type { ChecklistItem, TranscriptSegment } from "@/lib/types";

const TOKEN_STORAGE_KEY = "lecture-recorder:notion-token";

type NotionExportModalProps = {
  title: string;
  summary: string;
  lectureNote: string;
  checklist: ChecklistItem[];
  transcript: TranscriptSegment[];
  onClose: () => void;
};

type Status = "idle" | "loading" | "success" | "error";

export function NotionExportModal({
  title,
  summary,
  lectureNote,
  checklist,
  transcript,
  onClose,
}: NotionExportModalProps) {
  const [notionToken, setNotionToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [targetInput, setTargetInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (saved) setNotionToken(saved);
  }, []);

  // Persist as the user types (not gated on a successful send) so a typo
  // followed by a retry doesn't force retyping the whole token.
  useEffect(() => {
    if (notionToken) window.localStorage.setItem(TOKEN_STORAGE_KEY, notionToken);
  }, [notionToken]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleSubmit() {
    const token = notionToken.trim();
    const target = targetInput.trim();

    if (!token) {
      setStatus("error");
      setErrorMessage("Notion 통합 토큰을 입력해주세요.");
      return;
    }
    if (!target || !extractNotionId(target)) {
      setStatus("error");
      setErrorMessage(
        "노션 페이지 링크 또는 ID를 인식하지 못했습니다. 노션에서 페이지를 열고 주소창의 링크를 그대로 붙여넣어 주세요.",
      );
      return;
    }

    setStatus("loading");
    setErrorMessage(null);

    try {
      const response = await fetch("/api/export-to-notion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notionToken: token,
          targetId: target,
          title,
          summary,
          lectureNote,
          checklist,
          transcript,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? "노션으로 내보내기에 실패했습니다.");
      }
      setResultUrl(typeof data.url === "string" ? data.url : null);
      setStatus("success");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "노션으로 내보내기 중 오류가 발생했습니다.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:px-4 sm:py-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl dark:bg-zinc-900 sm:max-h-[85vh] sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notion-export-modal-title"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2 id="notion-export-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            🗂️ 노션으로 내보내기
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
          {status === "success" ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-2xl">🎉</p>
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">노션 페이지에 강의노트를 추가했어요!</p>
              {resultUrl && (
                <a
                  href={resultUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
                >
                  노션에서 열기 ↗
                </a>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                강의노트를 넣고 싶은 노션 페이지나 팝업 창의 URL을 붙여넣으세요. 해당 페이지 본문 맨 아래에
                내용이 그대로 추가됩니다.
              </p>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Notion API 토큰</label>
                <div className="flex gap-1.5">
                  <input
                    type={showToken ? "text" : "password"}
                    value={notionToken}
                    onChange={(event) => setNotionToken(event.target.value)}
                    placeholder="ntn_..."
                    className="flex-1 rounded-lg border border-zinc-200 bg-slate-100 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((current) => !current)}
                    className="shrink-0 rounded-lg border border-zinc-200 px-3 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    {showToken ? "숨기기" : "보기"}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                  입력한 토큰은 이 브라우저에만 저장되어 다음번에 자동으로 채워집니다.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">대상 노션 페이지 URL</label>
                <input
                  value={targetInput}
                  onChange={(event) => setTargetInput(event.target.value)}
                  placeholder="https://www.notion.so/... 또는 https://app.notion.com/p/...?p=..."
                  className="w-full rounded-lg border border-zinc-200 bg-slate-100 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                  일반 페이지 링크와 팝업(Center Peek) 창 URL 모두 그대로 붙여넣으면 됩니다.
                </p>
              </div>

              <div className="rounded-lg bg-zinc-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
                💡 처음이라면: 노션 <strong>설정 → 연결 → 내 통합(Integrations)</strong>에서 새 통합을 만들어 토큰을
                발급받고, 대상 페이지 우측 상단 <strong>'⋯' 메뉴 → 연결 추가</strong>에서 해당 통합을 연결해주세요.
              </div>

              {status === "error" && errorMessage && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600 dark:bg-red-950/40 dark:text-red-400">{errorMessage}</p>
              )}
            </div>
          )}
        </div>

        {status !== "success" && (
          <div className="safe-pb flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-zinc-200 px-4 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              취소
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={status === "loading"}
              className="flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
            >
              {status === "loading" && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              )}
              {status === "loading" ? "전송 중..." : "노션으로 전송"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

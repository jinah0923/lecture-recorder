"use client";

import { useEffect, useState } from "react";
import { exportSectionsToPdf, type PdfSectionId } from "@/lib/pdfExport";
import type { ChecklistItem, TranscriptSegment } from "@/lib/types";

type PdfExportModalProps = {
  title: string;
  summary: string;
  lectureNote: string;
  transcript: TranscriptSegment[];
  checklist: ChecklistItem[];
  /** Page number -> cached slide image, for `![슬라이드 N](slide_N)` placeholders inside lectureNote. */
  slideImages?: Map<number, string>;
  onClose: () => void;
};

const SECTION_OPTIONS: { id: PdfSectionId; label: string }[] = [
  { id: "summary", label: "AI 요약본" },
  { id: "lectureNote", label: "상세 강의노트" },
  { id: "transcript", label: "변환된 스크립트" },
  { id: "checklist", label: "체크리스트" },
];

// Matches this app's other exports' data-preservation principle: whichever
// sections are picked, each is exported from its full, untouched source
// (aiResult fields passed down as props) — never a paginated on-screen slice.
export function PdfExportModal({
  title,
  summary,
  lectureNote,
  transcript,
  checklist,
  slideImages,
  onClose,
}: PdfExportModalProps) {
  const [selected, setSelected] = useState<Set<PdfSectionId>>(() => new Set(["lectureNote"]));
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function toggleSection(id: PdfSectionId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleExport() {
    if (selected.size === 0 || isExporting) return;
    setIsExporting(true);
    setError(null);
    try {
      const orderedSections = SECTION_OPTIONS.filter((option) => selected.has(option.id)).map((option) => option.id);
      await exportSectionsToPdf(orderedSections, {
        title,
        summary,
        lectureNote,
        transcript,
        checklist,
        slideImages,
      });
      onClose();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : "PDF 생성 중 오류가 발생했습니다.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:px-4 sm:py-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-2xl bg-slate-50 shadow-2xl dark:bg-zinc-900 sm:max-h-[85vh] sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-export-modal-title"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2 id="pdf-export-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            📄 PDF로 내보내기
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
          <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            PDF에 포함할 항목을 선택하세요. 선택한 순서대로 각 항목이 새 페이지에서 시작합니다.
          </p>
          <div className="flex flex-col gap-1.5">
            {SECTION_OPTIONS.map((option) => (
              <label
                key={option.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <input
                  type="checkbox"
                  checked={selected.has(option.id)}
                  onChange={() => toggleSection(option.id)}
                  className="h-4 w-4 shrink-0 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-600 dark:bg-zinc-900"
                />
                <span className="text-zinc-700 dark:text-zinc-300">{option.label}</span>
              </label>
            ))}
          </div>
          {selected.size === 0 && (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">최소 한 항목은 선택해주세요.</p>
          )}
          {error && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        <div className="safe-pb flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-4 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={selected.size === 0 || isExporting}
            className="flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {isExporting && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {isExporting ? "PDF 생성 중..." : "선택한 항목 PDF 다운로드"}
          </button>
        </div>
      </div>
    </div>
  );
}

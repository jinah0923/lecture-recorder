"use client";

import { useState } from "react";
import { ChecklistPanel } from "@/components/ChecklistPanel";
import { DeepDiveModal } from "@/components/DeepDiveModal";
import { LectureNote } from "@/components/LectureNote";
import { NotionExportModal } from "@/components/NotionExportModal";
import { PdfExportModal } from "@/components/PdfExportModal";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { copyToClipboard, downloadTextFile } from "@/lib/export";
import { renderMarkdown } from "@/lib/markdown";
import type { AiResult, ChecklistItem, DraftBlock, TranscriptSegment } from "@/lib/types";

type ReviewPanelProps = {
  title: string;
  aiResult: AiResult;
  onSeek: (ms: number) => void;
  onUpdateChecklist: (nextChecklist: ChecklistItem[]) => void;
  onUpdateLectureNote: (nextLectureNote: string) => void;
  onUpdateTranscript: (nextTranscript: TranscriptSegment[]) => void;
  onSegmentCommitted?: (oldText: string, newText: string) => void;
  /** Page number -> cached slide image, for `![슬라이드 N](slide_N)` placeholders. */
  slideImages?: Map<number, string>;
};

function buildSummaryExportContent(aiResult: AiResult) {
  return ["# 강의 요약", "", aiResult.summary || "요약 내용이 없습니다."].join("\n");
}

function buildLectureNoteExportContent(aiResult: AiResult) {
  return ["# 상세 강의노트", "", aiResult.lectureNote || "상세 강의노트가 없습니다."].join("\n");
}

function buildDraftBlockMarkdown(block: DraftBlock): string {
  return [
    `💜 **[AI 심화 탐구] ${block.title}**`,
    `① 개념 정의: ${block.definition}`,
    `② 심층 설명: ${block.deepDive}`,
    `③ 실생활 예시: ${block.example}`,
  ].join("\n");
}

function mergeConfirmedBlocks(lectureNote: string, blocks: DraftBlock[]): string {
  let result = lectureNote;
  for (const block of blocks) {
    if (block.status !== "confirmed") continue;
    const markdown = buildDraftBlockMarkdown(block);
    const anchorIndex = block.anchorText ? result.indexOf(block.anchorText) : -1;
    if (anchorIndex === -1) {
      result = `${result}\n\n${markdown}`;
      continue;
    }
    const lineEnd = result.indexOf("\n", anchorIndex);
    const insertAt = lineEnd === -1 ? result.length : lineEnd;
    result = `${result.slice(0, insertAt)}\n\n${markdown}${result.slice(insertAt)}`;
  }
  return result;
}

export function ReviewPanel({
  title,
  aiResult,
  onSeek,
  onUpdateChecklist,
  onUpdateLectureNote,
  onUpdateTranscript,
  onSegmentCommitted,
  slideImages,
}: ReviewPanelProps) {
  const [summaryCopyLabel, setSummaryCopyLabel] = useState("클립보드 복사");
  const [noteCopyLabel, setNoteCopyLabel] = useState("클립보드 복사");

  const [expandQuestion, setExpandQuestion] = useState("");
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showNotionModal, setShowNotionModal] = useState(false);
  const [showPdfModal, setShowPdfModal] = useState(false);

  async function handleCopySummary() {
    const ok = await copyToClipboard(buildSummaryExportContent(aiResult));
    setSummaryCopyLabel(ok ? "복사됨!" : "복사 실패");
    window.setTimeout(() => setSummaryCopyLabel("클립보드 복사"), 1500);
  }

  function handleDownloadSummary(extension: "txt" | "md") {
    const mime = extension === "md" ? "text/markdown" : "text/plain";
    downloadTextFile(`lecture-summary.${extension}`, buildSummaryExportContent(aiResult), mime);
  }

  async function handleCopyNote() {
    const ok = await copyToClipboard(buildLectureNoteExportContent(aiResult));
    setNoteCopyLabel(ok ? "복사됨!" : "복사 실패");
    window.setTimeout(() => setNoteCopyLabel("클립보드 복사"), 1500);
  }

  function handleDownloadNote(extension: "txt" | "md") {
    const mime = extension === "md" ? "text/markdown" : "text/plain";
    downloadTextFile(`lecture-note.${extension}`, buildLectureNoteExportContent(aiResult), mime);
  }

  async function requestExpansion(question: string, replaceBlockId?: string) {
    if (!question.trim()) return;
    setIsExpanding(true);
    setExpandError(null);
    try {
      const response = await fetch("/api/expand-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lectureNote: aiResult.lectureNote, question }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? "심화 탐구에 실패했습니다.");
      }
      const newBlock: DraftBlock = {
        id: replaceBlockId ?? crypto.randomUUID(),
        sourceQuestion: question,
        anchorText: typeof data.anchorText === "string" ? data.anchorText : "",
        title: typeof data.title === "string" ? data.title : question,
        definition: typeof data.definition === "string" ? data.definition : "",
        deepDive: typeof data.deepDive === "string" ? data.deepDive : "",
        example: typeof data.example === "string" ? data.example : "",
        status: "pending",
      };
      setDraftBlocks((prev) =>
        replaceBlockId
          ? prev.map((block) => (block.id === replaceBlockId ? newBlock : block))
          : [...prev, newBlock],
      );
      setShowModal(true);
    } catch (error) {
      setExpandError(error instanceof Error ? error.message : "심화 탐구 중 오류가 발생했습니다.");
    } finally {
      setIsExpanding(false);
    }
  }

  function handleRequestExpansion() {
    const question = expandQuestion.trim();
    if (!question) return;
    void requestExpansion(question);
    setExpandQuestion("");
  }

  function handleConfirmBlock(id: string) {
    setDraftBlocks((prev) =>
      prev.map((block) => (block.id === id ? { ...block, status: "confirmed" as const } : block)),
    );
  }

  function handleCancelBlock(id: string) {
    setDraftBlocks((prev) => prev.filter((block) => block.id !== id));
  }

  function handleRefineBlock(id: string, feedback: string) {
    const block = draftBlocks.find((b) => b.id === id);
    if (!block) return;
    const combinedQuestion = `${block.sourceQuestion}\n\n[추가 요청] ${feedback}`;
    void requestExpansion(combinedQuestion, id);
  }

  function handleSaveDraftBlocks() {
    const merged = mergeConfirmedBlocks(aiResult.lectureNote, draftBlocks);
    onUpdateLectureNote(merged);
    setDraftBlocks([]);
    setShowModal(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">AI 요약본</h2>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={handleCopySummary}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {summaryCopyLabel}
            </button>
            <button
              type="button"
              onClick={() => handleDownloadSummary("txt")}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              .txt 다운로드
            </button>
            <button
              type="button"
              onClick={() => handleDownloadSummary("md")}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              .md 다운로드
            </button>
          </div>
        </div>
        <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
          {aiResult.summary ? renderMarkdown(aiResult.summary) : (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">요약 내용이 없습니다.</p>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">📖 상세 강의노트</h2>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={handleCopyNote}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {noteCopyLabel}
            </button>
            <button
              type="button"
              onClick={() => handleDownloadNote("txt")}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              .txt 다운로드
            </button>
            <button
              type="button"
              onClick={() => handleDownloadNote("md")}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              .md 다운로드
            </button>
            <button
              type="button"
              onClick={() => setShowPdfModal(true)}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              .pdf 다운로드
            </button>
            <button
              type="button"
              onClick={() => setShowNotionModal(true)}
              className="rounded-full border border-slate-200 bg-zinc-900 px-3 py-1 text-xs font-medium text-white transition hover:bg-zinc-700 dark:border-zinc-700"
            >
              🗂️ 노션으로 내보내기
            </button>
          </div>
        </div>
        <LectureNote markdown={aiResult.lectureNote} slideImages={slideImages} />

        <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">🔍 더 알고 싶은 심화정보 / 추가 질문</p>
          <div className="flex gap-1.5">
            <input
              value={expandQuestion}
              onChange={(event) => {
                setExpandQuestion(event.target.value);
                if (expandError) setExpandError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleRequestExpansion();
              }}
              placeholder="[개념 정의 / 확장 설명 / 쉬운 예시] 예: 루비스코 효소의 작용 원리와 쉬운 비유"
              disabled={!aiResult.lectureNote}
              className="flex-1 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <button
              type="button"
              onClick={handleRequestExpansion}
              disabled={isExpanding || !expandQuestion.trim() || !aiResult.lectureNote}
              className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isExpanding ? "탐구 중..." : "AI 심화 탐구 요청"}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
            💡 강의 내용 중 보강하고 싶은 학술 개념, 심층 원리, 실생활 예시를 입력하면 강의노트의 적절한 위치에 제안 블록을 생성합니다.
          </p>
          {expandError && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{expandError}</p>}
          {draftBlocks.length > 0 && !showModal && (
            <button
              type="button"
              onClick={() => setShowModal(true)}
              className="mt-1.5 text-xs font-medium text-indigo-600 underline"
            >
              검수 대기 중인 심화 탐구 {draftBlocks.length}건 보기
            </button>
          )}
        </div>
      </section>

      <TranscriptPanel
        transcript={aiResult.transcript}
        onSeek={onSeek}
        onTranscriptChange={onUpdateTranscript}
        onSegmentCommitted={onSegmentCommitted}
      />

      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">체크리스트</h2>
        <ChecklistPanel checklist={aiResult.checklist} onChange={onUpdateChecklist} />
      </section>

      {showModal && (
        <DeepDiveModal
          lectureNote={aiResult.lectureNote}
          draftBlocks={draftBlocks}
          isExpanding={isExpanding}
          onConfirmBlock={handleConfirmBlock}
          onCancelBlock={handleCancelBlock}
          onRefineBlock={handleRefineBlock}
          onSave={handleSaveDraftBlocks}
          onClose={() => setShowModal(false)}
        />
      )}

      {showNotionModal && (
        <NotionExportModal
          title={title}
          summary={aiResult.summary}
          lectureNote={aiResult.lectureNote}
          checklist={aiResult.checklist}
          transcript={aiResult.transcript}
          onClose={() => setShowNotionModal(false)}
        />
      )}

      {showPdfModal && (
        <PdfExportModal
          title={title}
          summary={aiResult.summary}
          lectureNote={aiResult.lectureNote}
          transcript={aiResult.transcript}
          checklist={aiResult.checklist}
          slideImages={slideImages}
          onClose={() => setShowPdfModal(false)}
        />
      )}
    </div>
  );
}

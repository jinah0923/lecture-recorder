"use client";

import { useState } from "react";
import { DeepDiveModal } from "@/components/DeepDiveModal";
import { NotionExportModal } from "@/components/NotionExportModal";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { copyToClipboard, downloadTextFile } from "@/lib/export";
import { renderMarkdown } from "@/lib/markdown";
import type { AiResult, DraftBlock, TranscriptSegment } from "@/lib/types";

type ReviewPanelProps = {
  title: string;
  aiResult: AiResult;
  onSeek: (ms: number) => void;
  onToggleChecklistItem: (id: string) => void;
  onUpdateLectureNote: (nextLectureNote: string) => void;
  onUpdateTranscript: (nextTranscript: TranscriptSegment[]) => void;
  onSegmentCommitted?: (oldText: string, newText: string) => void;
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
  onToggleChecklistItem,
  onUpdateLectureNote,
  onUpdateTranscript,
  onSegmentCommitted,
}: ReviewPanelProps) {
  const [summaryCopyLabel, setSummaryCopyLabel] = useState("클립보드 복사");
  const [noteCopyLabel, setNoteCopyLabel] = useState("클립보드 복사");

  const [expandQuestion, setExpandQuestion] = useState("");
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showNotionModal, setShowNotionModal] = useState(false);

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
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900">AI 요약본</h2>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={handleCopySummary}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              {summaryCopyLabel}
            </button>
            <button
              type="button"
              onClick={() => handleDownloadSummary("txt")}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              .txt 다운로드
            </button>
            <button
              type="button"
              onClick={() => handleDownloadSummary("md")}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              .md 다운로드
            </button>
          </div>
        </div>
        <div className="rounded-xl bg-zinc-50 p-3">
          {aiResult.summary ? renderMarkdown(aiResult.summary) : (
            <p className="text-sm text-zinc-500">요약 내용이 없습니다.</p>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900">📖 상세 강의노트</h2>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={handleCopyNote}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              {noteCopyLabel}
            </button>
            <button
              type="button"
              onClick={() => handleDownloadNote("txt")}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              .txt 다운로드
            </button>
            <button
              type="button"
              onClick={() => handleDownloadNote("md")}
              className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              .md 다운로드
            </button>
            <button
              type="button"
              onClick={() => setShowNotionModal(true)}
              className="rounded-full border border-zinc-200 bg-zinc-900 px-3 py-1 text-xs font-medium text-white transition hover:bg-zinc-700"
            >
              🗂️ 노션으로 내보내기
            </button>
          </div>
        </div>
        <div className="max-h-[32rem] overflow-y-auto rounded-xl bg-zinc-50 p-3">
          {aiResult.lectureNote ? renderMarkdown(aiResult.lectureNote) : (
            <p className="text-sm text-zinc-500">상세 강의노트가 없습니다.</p>
          )}
        </div>

        <div className="mt-3 border-t border-zinc-100 pt-3">
          <p className="mb-1.5 text-xs font-medium text-zinc-500">🔍 더 알고 싶은 심화정보 / 추가 질문</p>
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
              className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
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
          <p className="mt-1.5 text-[11px] text-zinc-400">
            💡 강의 내용 중 보강하고 싶은 학술 개념, 심층 원리, 실생활 예시를 입력하면 강의노트의 적절한 위치에 제안 블록을 생성합니다.
          </p>
          {expandError && <p className="mt-1.5 text-xs text-red-600">{expandError}</p>}
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

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900">체크리스트</h2>
        {aiResult.checklist.length === 0 ? (
          <p className="text-xs text-zinc-400">생성된 체크리스트가 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {aiResult.checklist.map((item) => (
              <li key={item.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() => onToggleChecklistItem(item.id)}
                    className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className={item.done ? "text-zinc-400 line-through" : "text-zinc-700"}>
                    {item.text}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
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
    </div>
  );
}

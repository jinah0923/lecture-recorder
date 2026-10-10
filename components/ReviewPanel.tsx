"use client";

import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { ChecklistPanel } from "@/components/ChecklistPanel";
import { DeepDiveModal } from "@/components/DeepDiveModal";
import { LectureNote } from "@/components/LectureNote";
import { NotionExportModal } from "@/components/NotionExportModal";
import { PdfExportModal } from "@/components/PdfExportModal";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { buildDeepDiveImageProxyUrl, uploadFileToBlob } from "@/lib/blobUpload";
import { copyToClipboard, downloadTextFile } from "@/lib/export";
import { describeBlockedChunks } from "@/lib/geminiMessages";
import { stripMarkTags } from "@/lib/inlineMarkdown";
import { toNotionPasteMarkdown } from "@/lib/noteBlocks";
import { renderMarkdown } from "@/lib/markdown";
import { buildSlideThumbnails } from "@/lib/pdfSlides";
import type { AiResult, ChecklistItem, DraftBlock, TranscriptSegment } from "@/lib/types";

type AttachedImage = { file: File; previewUrl: string };

type ReviewPanelProps = {
  title: string;
  aiResult: AiResult;
  onSeek: (ms: number) => void;
  onUpdateChecklist: (nextChecklist: ChecklistItem[]) => void;
  onUpdateLectureNote: (nextLectureNote: string) => void;
  /** Explicit "저장" from manual-edit mode below — unlike onUpdateLectureNote
   * (an optimistic state update the caller's own debounced autosave catches
   * up to later), this persists immediately: a deliberate save action
   * deserves the same "don't wait on a debounce that might lose the edit to
   * a navigate-away" treatment RecordingDetailView already gives a finished
   * analysis job. */
  onSaveLectureNoteNow: (nextLectureNote: string) => Promise<void>;
  onUpdateTranscript: (nextTranscript: TranscriptSegment[]) => void;
  onSegmentCommitted?: (oldText: string, newText: string) => void;
  /** "📄 자료 추가해서 다시 분석": files the user picked, for the caller to confirm and merge. */
  onMergeMaterial?: (files: File[]) => void;
  /** Progress text while a merge re-analysis runs; null when idle. */
  mergeProgress?: string | null;
  /** Page number -> cached slide image, for `![슬라이드 N](slide_N)` placeholders. */
  slideImages?: Map<number, string>;
};

// The raw markdown, with list indentation normalized to 4 spaces per level —
// Notion (the usual paste target) flattens 2-space nested bullets, and
// doesn't treat the summary's "•" bullets as a list at all.
function buildSummaryExportContent(aiResult: AiResult) {
  return toNotionPasteMarkdown(["# 강의 요약", "", aiResult.summary || "요약 내용이 없습니다."].join("\n"));
}

function buildLectureNoteExportContent(aiResult: AiResult) {
  return toNotionPasteMarkdown(["# 상세 강의노트", "", aiResult.lectureNote || "상세 강의노트가 없습니다."].join("\n"));
}

// The deep-dive endpoint is strictly grounded in the recording and slides
// (app/api/expand-note/route.ts), so it needs the transcript itself, not
// just the note derived from it. Timestamped so the model can tell where in
// the lecture something was said.
function buildTranscriptText(transcript: TranscriptSegment[]): string {
  return transcript
    .map((segment) => {
      const totalSeconds = Math.max(0, Math.floor(segment.startMs / 1000));
      const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
      const ss = String(totalSeconds % 60).padStart(2, "0");
      return `[${mm}:${ss}] ${segment.text}`;
    })
    .join("\n");
}

// Vercel rejects Function request bodies over 4.5MB before the route runs.
// Text (note + transcript) is small in practice; slide thumbnails are the
// bulk, so they get a budget and later pages are dropped past it.
const SLIDE_PAYLOAD_BUDGET_CHARS = 3_000_000;

async function buildGroundingSlides(slideImages: Map<number, string> | undefined) {
  if (!slideImages || slideImages.size === 0) return [];
  const slides = Array.from(slideImages, ([page, dataUrl]) => ({ page, dataUrl })).sort((a, b) => a.page - b.page);
  const thumbnails = await buildSlideThumbnails(slides);
  const kept: typeof thumbnails = [];
  let used = 0;
  for (const thumbnail of thumbnails) {
    if (used + thumbnail.dataUrl.length > SLIDE_PAYLOAD_BUDGET_CHARS) {
      console.warn(`[deep-dive] slide payload budget reached — sending ${kept.length}/${thumbnails.length} slides`);
      break;
    }
    kept.push(thumbnail);
    used += thumbnail.dataUrl.length;
  }
  return kept;
}

function buildDraftBlockMarkdown(block: DraftBlock): string {
  // Blank line after the header ends the 💜 callout box (see the group-
  // consuming loop in lib/markdown.tsx) so block.content renders below it as
  // fully-parsed markdown — images/tables/headings included — rather than
  // being swallowed as plain text inside the callout.
  return [`💜 **[AI 심화 탐구] ${block.title}**`, "", block.content].join("\n");
}

function mergeConfirmedBlocks(lectureNote: string, blocks: DraftBlock[]): string {
  let result = lectureNote;
  for (const block of blocks) {
    if (block.status !== "confirmed") continue;
    const markdown = buildDraftBlockMarkdown(block);
    let anchorIndex = block.anchorText ? result.indexOf(block.anchorText) : -1;
    // The model often quotes a highlighted sentence without its <mark> tags,
    // which misses an exact match — fall back to the first line containing
    // the anchor once tags are ignored on both sides.
    if (anchorIndex === -1 && block.anchorText) {
      const bareAnchor = stripMarkTags(block.anchorText);
      let offset = 0;
      for (const line of result.split("\n")) {
        if (bareAnchor && stripMarkTags(line).includes(bareAnchor)) {
          anchorIndex = offset;
          break;
        }
        offset += line.length + 1;
      }
    }
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
  onSaveLectureNoteNow,
  onUpdateTranscript,
  onSegmentCommitted,
  onMergeMaterial,
  mergeProgress = null,
  slideImages,
}: ReviewPanelProps) {
  const [summaryCopyLabel, setSummaryCopyLabel] = useState("클립보드 복사");

  // Selecting rendered text and pressing Ctrl+C would otherwise copy each
  // formula as a jumble of KaTeX's visible HTML plus its hidden MathML
  // ("αα…"). KaTeX's copy-tex extension rewrites the copied plain text so each
  // formula comes out as its $...$ / $$...$$ source. Loaded here, in the
  // browser only: it registers a document listener as soon as it's imported,
  // which would break server rendering.
  useEffect(() => {
    void import("katex/contrib/copy-tex");
  }, []);
  const mergeInputRef = useRef<HTMLInputElement>(null);

  function handleMergeFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    // Cleared so picking the same file again still fires onChange.
    event.target.value = "";
    if (files.length > 0) onMergeMaterial?.(files);
  }
  const [noteCopyLabel, setNoteCopyLabel] = useState("클립보드 복사");

  // Manual-edit mode for the lecture note — operates on aiResult.lectureNote
  // (the full, untouched markdown), never on LectureNote's own paginated
  // slice, so saving can never truncate the note down to whatever page
  // happened to be on screen.
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [isSavingNote, setIsSavingNote] = useState(false);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);

  function autoResizeNoteTextarea() {
    const el = noteTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function startEditingNote() {
    setNoteDraft(aiResult.lectureNote);
    setIsEditingNote(true);
  }

  // Runs once the textarea actually mounts (its content, and therefore
  // scrollHeight, isn't there yet on the same tick as setIsEditingNote).
  useEffect(() => {
    if (isEditingNote) autoResizeNoteTextarea();
  }, [isEditingNote]);

  function cancelEditingNote() {
    setIsEditingNote(false);
    setNoteDraft("");
  }

  async function saveEditingNote() {
    setIsSavingNote(true);
    try {
      await onSaveLectureNoteNow(noteDraft);
      setIsEditingNote(false);
      setNoteDraft("");
    } finally {
      setIsSavingNote(false);
    }
  }

  const [expandQuestion, setExpandQuestion] = useState("");
  const [expandImage, setExpandImage] = useState<AttachedImage | null>(null);
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showNotionModal, setShowNotionModal] = useState(false);
  const [showPdfModal, setShowPdfModal] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Revokes the previous preview's object URL whenever it's replaced or the
  // component unmounts — doesn't affect the underlying File (still fully
  // readable for upload) since object URLs are display-only handles.
  useEffect(() => {
    return () => {
      if (expandImage) URL.revokeObjectURL(expandImage.previewUrl);
    };
  }, [expandImage]);

  async function handleCopySummary() {
    const ok = await copyToClipboard(buildSummaryExportContent(aiResult));
    setSummaryCopyLabel(ok ? "복사됨!" : "복사 실패");
    window.setTimeout(() => setSummaryCopyLabel("클립보드 복사"), 1500);
  }

  function handleDownloadSummary(extension: "txt" | "md") {
    const mime = extension === "md" ? "text/markdown" : "text/plain";
    // .txt has no formatting at all, so the 형광펜 tags would just be noise;
    // .md keeps them (markdown editors render <mark>).
    const content = buildSummaryExportContent(aiResult);
    downloadTextFile(`lecture-summary.${extension}`, extension === "txt" ? stripMarkTags(content) : content, mime);
  }

  async function handleCopyNote() {
    const ok = await copyToClipboard(buildLectureNoteExportContent(aiResult));
    setNoteCopyLabel(ok ? "복사됨!" : "복사 실패");
    window.setTimeout(() => setNoteCopyLabel("클립보드 복사"), 1500);
  }

  function handleDownloadNote(extension: "txt" | "md") {
    const mime = extension === "md" ? "text/markdown" : "text/plain";
    const content = buildLectureNoteExportContent(aiResult);
    downloadTextFile(`lecture-note.${extension}`, extension === "txt" ? stripMarkTags(content) : content, mime);
  }

  async function requestExpansion(question: string, replaceBlockId?: string, imageFile?: File) {
    if (!question.trim()) return;
    setIsExpanding(true);
    setExpandError(null);
    try {
      let imageUrl: string | undefined;
      if (imageFile) {
        // This project's Blob store is private-only, so the raw upload URL
        // 403s for anyone without our server's token — buildDeepDiveImageProxyUrl
        // wraps it in our own public proxy route (app/api/deep-dive-image)
        // instead, which is what actually needs to survive permanently in the
        // merged lecture note (rendered later by the viewer's browser and by
        // Notion's server, neither of which can authenticate to Blob directly).
        const uploaded = await uploadFileToBlob(
          imageFile,
          imageFile.name || `deep-dive-${Date.now()}.jpg`,
          imageFile.type || "image/jpeg",
        );
        imageUrl = buildDeepDiveImageProxyUrl(uploaded.url);
      }
      const response = await fetch("/api/expand-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lectureNote: aiResult.lectureNote,
          question,
          transcript: buildTranscriptText(aiResult.transcript),
          slideThumbnails: await buildGroundingSlides(slideImages),
          ...(imageUrl ? { imageUrl } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? "심화 탐구에 실패했습니다.");
      }
      // Nothing in the recording/slides backs this request — show the
      // server's message instead of creating (or replacing) a draft block.
      if (data?.notFound) {
        setExpandError(typeof data.message === "string" ? data.message : "제공된 강의 자료와 녹음본에서는 해당 내용을 찾을 수 없습니다.");
        return;
      }
      const newBlock: DraftBlock = {
        id: replaceBlockId ?? crypto.randomUUID(),
        sourceQuestion: question,
        anchorText: typeof data.anchorText === "string" ? data.anchorText : "",
        title: typeof data.title === "string" ? data.title : question,
        content: typeof data.content === "string" ? data.content : "",
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
    const imageFile = expandImage?.file;
    void requestExpansion(question, undefined, imageFile);
    setExpandQuestion("");
    setExpandImage(null);
  }

  function handleImageSelected(file: File) {
    setExpandImage({ file, previewUrl: URL.createObjectURL(file) });
    if (expandError) setExpandError(null);
  }

  function handleImageInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file next time
    if (file) handleImageSelected(file);
  }

  function handleQuestionPaste(event: ClipboardEvent<HTMLInputElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) {
        event.preventDefault();
        handleImageSelected(file);
      }
      break;
    }
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
          <div className="flex flex-wrap gap-1.5">
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
          <div className="flex flex-wrap gap-1.5">
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
            {!isEditingNote && (
              <button
                type="button"
                onClick={startEditingNote}
                disabled={!!mergeProgress}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                ✏️ 노트 직접 수정
              </button>
            )}
            {onMergeMaterial && (
              <>
                <button
                  type="button"
                  onClick={() => mergeInputRef.current?.click()}
                  disabled={!!mergeProgress || isEditingNote}
                  title="녹음은 다시 분석하지 않고, 기존 스크립트에 교안·교재를 합쳐 노트를 새로 만듭니다"
                  className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
                >
                  📄 자료 추가해서 다시 분석
                </button>
                <input
                  ref={mergeInputRef}
                  type="file"
                  accept=".pdf,application/pdf,image/*"
                  multiple
                  onChange={handleMergeFilesPicked}
                  className="hidden"
                  aria-hidden="true"
                  tabIndex={-1}
                />
              </>
            )}
          </div>
        </div>
        {mergeProgress && (
          <p
            role="status"
            className="mb-3 flex items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
          >
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-700 dark:border-indigo-800 dark:border-t-indigo-300" />
            {mergeProgress}
          </p>
        )}
        {isEditingNote ? (
          <div className="flex flex-col gap-2">
            <textarea
              ref={noteTextareaRef}
              value={noteDraft}
              onChange={(event) => {
                setNoteDraft(event.target.value);
                autoResizeNoteTextarea();
              }}
              className="w-full resize-none overflow-hidden rounded-xl border border-indigo-200 bg-white p-3 font-mono text-sm leading-relaxed text-zinc-900 outline-none focus:border-indigo-400 dark:border-indigo-900 dark:bg-zinc-900 dark:text-zinc-100"
              placeholder="상세 강의노트를 마크다운으로 직접 작성/수정하세요."
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={cancelEditingNote}
                disabled={isSavingNote}
                className="rounded-full border border-slate-200 px-4 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                취소
              </button>
              <button
                type="button"
                onClick={saveEditingNote}
                disabled={isSavingNote}
                className="rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingNote ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {aiResult.engine === "openai" && (
              <p className="mb-3 break-words rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
                {aiResult.userApprovedFallback === "policy"
                  ? "🤖 정책 차단으로 인해 사용자가 직접 대체 AI 엔진을 승인하여 분석을 완료했습니다."
                  : aiResult.userApprovedFallback === "error"
                    ? "🤖 Gemini 분석 실패로 인해 사용자가 직접 대체 AI 엔진을 승인하여 분석을 완료했습니다."
                    : "🤖 OpenAI 엔진(Whisper-1 음성 인식 · GPT 강의노트)으로 분석한 노트입니다."}
              </p>
            )}
            {aiResult.blockedChunks && aiResult.blockedChunks.length > 0 && (
              <p className="mb-3 break-words rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                ⚠️ {describeBlockedChunks(aiResult.blockedChunks)} 이 노트는 그 구간을 제외한 나머지 녹음으로 작성되었습니다.
              </p>
            )}
            <LectureNote markdown={aiResult.lectureNote} slideImages={slideImages} />
          </>
        )}

        <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">🔍 더 알고 싶은 심화정보 / 추가 질문</p>
          {expandImage && (
            <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-1.5 dark:border-zinc-700 dark:bg-zinc-800">
              {/* eslint-disable-next-line @next/next/no-img-element -- local blob: object URL, not an optimizable remote asset */}
              <img src={expandImage.previewUrl} alt="첨부 이미지 미리보기" className="h-12 w-12 shrink-0 rounded-md object-cover" />
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{expandImage.file.name}</span>
              <button
                type="button"
                onClick={() => setExpandImage(null)}
                aria-label="첨부 이미지 제거"
                title="첨부 이미지 제거"
                className="shrink-0 rounded-full p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageInputChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={!aiResult.lectureNote || isEditingNote}
              aria-label="이미지 첨부"
              title="이미지 첨부 (사진/구조식/도표)"
              className="shrink-0 rounded-lg border border-slate-200 px-2.5 text-base text-zinc-500 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              📎
            </button>
            <input
              value={expandQuestion}
              onChange={(event) => {
                setExpandQuestion(event.target.value);
                if (expandError) setExpandError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleRequestExpansion();
              }}
              onPaste={handleQuestionPaste}
              placeholder="[누락 내용 추가 / 심화 개념 / 구조식 요청] 예: 전사 과정 중 스플라이싱 내용이 빠졌어, 표 형태로 정리해서 추가해 줘."
              disabled={!aiResult.lectureNote || isEditingNote}
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <button
              type="button"
              onClick={handleRequestExpansion}
              disabled={isExpanding || !expandQuestion.trim() || !aiResult.lectureNote || isEditingNote}
              className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isExpanding ? "탐구 중..." : "AI 심화 탐구 요청"}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
            {isEditingNote
              ? "✏️ 노트를 직접 수정하는 중에는 사용할 수 없어요 — 저장하거나 취소한 뒤 이용해주세요."
              : "💡 강의 내용 중 보강하고 싶은 학술 개념, 심층 원리, 실생활 예시를 입력하거나 사진(구조식/도표)을 첨부하면 강의노트의 적절한 위치에 제안 블록을 생성합니다. 이미지는 붙여넣기(Ctrl+V)로도 첨부할 수 있습니다."}
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
          notice={expandError}
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

"use client";

import { useEffect, useRef, useState } from "react";
import { AudioPlayer } from "@/components/AudioPlayer";
import { BookmarkPanel } from "@/components/BookmarkPanel";
import { CategoryBadgeSelect } from "@/components/CategoryBadgeSelect";
import { CollapsibleCard } from "@/components/CollapsibleCard";
import { KeywordTagInput } from "@/components/KeywordTagInput";
import { ReattachAudioPrompt } from "@/components/ReattachAudioPrompt";
import { ReferenceDocDropzone } from "@/components/ReferenceDocDropzone";
import { ReviewPanel } from "@/components/ReviewPanel";
import { probeAudioDurationMs } from "@/lib/audio";
import { loadSessionById, saveSession } from "@/lib/db";
import { formatDateTime, formatFileSize } from "@/lib/format";
import type {
  AiResult,
  Bookmark,
  ChecklistItem,
  LectureSession,
  ReferenceDocument,
  SessionAudio,
} from "@/lib/types";

const PROGRESS_STAGES = ["오디오 업로드 중...", "음성 인식(STT) 진행 중...", "AI 요약 생성 중..."];

type RecordingDetailViewProps = {
  sessionId: string;
  categories: string[];
  onCategoryCreated: (name: string) => void;
  onBack: () => void;
  onSessionSaved: () => void;
  /** Hot handoff from NewRecordingView — audio still in memory, not yet re-downloaded from disk. */
  initialAudio?: SessionAudio;
};

export function RecordingDetailView({
  sessionId,
  categories,
  onCategoryCreated,
  onBack,
  onSessionSaved,
  initialAudio,
}: RecordingDetailViewProps) {
  const [hydrated, setHydrated] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [category, setCategory] = useState("일반");
  const [title, setTitle] = useState("");
  const [createdAt, setCreatedAt] = useState(() => Date.now());
  const [durationMs, setDurationMs] = useState(0);
  const [audioFileName, setAudioFileName] = useState("");
  const [audioMimeType, setAudioMimeType] = useState("");
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState("");
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [keywords, setKeywords] = useState<string[]>([]);
  const [referenceFileName, setReferenceFileName] = useState("");
  // The reference document's blob is never persisted — only its filename is,
  // same treatment as the audio blob.
  const [referenceDoc, setReferenceDoc] = useState<ReferenceDocument | null>(null);

  // The actual audio Blob is never persisted — it only exists here, either
  // handed off fresh from NewRecordingView or re-attached by the user from
  // their device for this viewing session.
  const [localAudio, setLocalAudio] = useState<SessionAudio | null>(initialAudio ?? null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSessionById(sessionId).then((session) => {
      if (cancelled) return;
      if (!session) {
        setNotFound(true);
        setHydrated(true);
        return;
      }
      setTitle(session.title);
      setCategory(session.category);
      setCreatedAt(session.createdAt);
      setDurationMs(session.durationMs);
      setAudioFileName(session.audioFileName);
      setAudioMimeType(session.audioMimeType);
      setBookmarks(session.bookmarks);
      setKeywords(session.keywords ?? []);
      setReferenceFileName(session.referenceFileName ?? "");
      setAiResult(session.aiResult);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Persist metadata edits — never the audio blob, preserving createdAt.
  // Debounced so rapid edits (e.g. typing in the title) don't trigger an
  // IndexedDB write on every keystroke; saves once input settles. On unmount
  // (e.g. navigating away before the debounce fires), flush immediately
  // instead of dropping the pending edit.
  const pendingSaveRef = useRef<LectureSession | null>(null);

  useEffect(() => {
    if (!hydrated || notFound) return;
    const session: LectureSession = {
      id: sessionId,
      createdAt,
      updatedAt: Date.now(),
      category,
      title: title || "제목 없는 강의",
      durationMs,
      audioFileName,
      audioMimeType,
      bookmarks,
      keywords,
      referenceFileName,
      aiResult,
    };
    pendingSaveRef.current = session;
    const timer = window.setTimeout(() => {
      pendingSaveRef.current = null;
      saveSession(session).then(onSessionSaved).catch(() => {});
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    hydrated,
    notFound,
    sessionId,
    createdAt,
    category,
    title,
    durationMs,
    audioFileName,
    audioMimeType,
    bookmarks,
    keywords,
    referenceFileName,
    aiResult,
    onSessionSaved,
  ]);

  useEffect(() => {
    return () => {
      if (pendingSaveRef.current) {
        saveSession(pendingSaveRef.current).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!localAudio?.blob) {
      setAudioUrl(null);
      return;
    }
    const url = URL.createObjectURL(localAudio.blob);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [localAudio?.blob]);

  function handleCreateAndSelectCategory(name: string) {
    onCategoryCreated(name);
    setCategory(name);
  }

  async function handleReattach(file: File) {
    const probedMs = await probeAudioDurationMs(file);
    setLocalAudio({
      kind: "upload",
      name: file.name,
      sizeLabel: formatFileSize(file.size),
      mimeType: file.type || "audio/webm",
      durationMs: probedMs || durationMs,
      blob: file,
    });
  }

  function seekTo(ms: number) {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = ms / 1000;
    void el.play();
  }

  async function handleAnalyze() {
    if (!localAudio?.blob || isAnalyzing) return;

    setIsAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeProgress(PROGRESS_STAGES[0]);

    const stageTimer = window.setInterval(() => {
      setAnalyzeProgress((current) => {
        const index = PROGRESS_STAGES.indexOf(current);
        const next = PROGRESS_STAGES[Math.min(index + 1, PROGRESS_STAGES.length - 1)];
        return next;
      });
    }, 4000);

    try {
      const formData = new FormData();
      formData.append("audio", localAudio.blob, localAudio.name || "audio");
      formData.append("bookmarks", JSON.stringify(bookmarks));
      if (keywords.length > 0) {
        formData.append("keywords", JSON.stringify(keywords));
      }
      if (referenceDoc) {
        formData.append("reference", referenceDoc.blob, referenceDoc.name);
        setReferenceFileName(referenceDoc.name);
      }

      const response = await fetch("/api/transcribe-and-summarize", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? "분석에 실패했습니다.");
      }

      const checklist: ChecklistItem[] = data.checklist ?? [];
      setAiResult({
        transcript: data.transcript ?? [],
        fullText: data.fullText ?? "",
        summary: data.summary ?? "",
        lectureNote: data.lectureNote ?? "",
        checklist,
      });
    } catch (error) {
      setAnalyzeError(error instanceof Error ? error.message : "분석 중 알 수 없는 오류가 발생했습니다.");
    } finally {
      window.clearInterval(stageTimer);
      setIsAnalyzing(false);
      setAnalyzeProgress("");
    }
  }

  function toggleChecklistItem(id: string) {
    setAiResult((current) => {
      if (!current) return current;
      return {
        ...current,
        checklist: current.checklist.map((item) =>
          item.id === id ? { ...item, done: !item.done } : item,
        ),
      };
    });
  }

  function updateLectureNote(nextLectureNote: string) {
    setAiResult((current) => (current ? { ...current, lectureNote: nextLectureNote } : current));
  }

  if (!hydrated) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">불러오는 중...</div>
    );
  }

  if (notFound) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-zinc-400">
        <p>녹음을 찾을 수 없습니다.</p>
        <button type="button" onClick={onBack} className="text-indigo-600 underline">
          목록으로 돌아가기
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-zinc-600 transition hover:text-zinc-900"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          목록으로 돌아가기
        </button>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="녹음 제목"
          className="w-full rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-xl font-semibold tracking-tight text-zinc-900 outline-none transition hover:border-zinc-200 focus:border-indigo-300 focus:bg-white"
        />
        <div className="mt-0.5 flex flex-wrap items-center gap-2 px-1">
          <p className="text-xs text-zinc-500">{formatDateTime(createdAt)}</p>
          <CategoryBadgeSelect
            category={category}
            categories={categories}
            onChange={setCategory}
            onCreateAndSelect={handleCreateAndSelectCategory}
          />
        </div>
        {(keywords.length > 0 || referenceFileName) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
            {keywords.map((word) => (
              <span
                key={word}
                className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600"
              >
                #{word}
              </span>
            ))}
            {referenceFileName && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                📎 {referenceFileName}
              </span>
            )}
          </div>
        )}
      </div>

      {audioUrl && localAudio ? (
        <AudioPlayer
          audioUrl={audioUrl}
          audioBlob={localAudio.blob}
          fileName={audioFileName || localAudio.name || "recording"}
          audioRef={audioRef}
        />
      ) : (
        <ReattachAudioPrompt audioFileName={audioFileName} onFileSelected={handleReattach} />
      )}

      {!aiResult && (
        <div className="flex flex-col gap-3">
          <CollapsibleCard
            title="주요 키워드 / 전문 용어 힌트"
            subtitle="STT 교정에 활용돼요"
            badge={
              keywords.length > 0 ? (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-600">
                  {keywords.length}
                </span>
              ) : undefined
            }
          >
            <KeywordTagInput keywords={keywords} onChange={setKeywords} />
          </CollapsibleCard>

          <CollapsibleCard
            title="강의안 / 참고자료 첨부"
            subtitle="PDF, TXT, 이미지 강의안"
            badge={
              referenceDoc ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                  첨부됨
                </span>
              ) : undefined
            }
          >
            <ReferenceDocDropzone
              document={referenceDoc}
              onDocumentChange={setReferenceDoc}
              onClear={() => setReferenceDoc(null)}
            />
          </CollapsibleCard>
        </div>
      )}

      {!aiResult && (
        <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={isAnalyzing || !localAudio}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {isAnalyzing ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                {analyzeProgress || "분석 중..."}
              </>
            ) : !localAudio ? (
              "오디오를 불러오면 분석할 수 있어요"
            ) : (
              "AI 분석 및 요약 시작"
            )}
          </button>
          {analyzeError && (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{analyzeError}</p>
          )}
        </div>
      )}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <BookmarkPanel
          bookmarks={bookmarks}
          elapsedMs={0}
          isRecording={false}
          onBookmarksChange={() => {}}
          onSeek={seekTo}
          allowAdd={false}
          variant="cards"
          emptyText="저장된 북마크 없음"
        />
      </section>

      {aiResult && (
        <ReviewPanel
          aiResult={aiResult}
          onSeek={seekTo}
          onToggleChecklistItem={toggleChecklistItem}
          onUpdateLectureNote={updateLectureNote}
        />
      )}
    </div>
  );
}

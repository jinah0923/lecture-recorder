"use client";

import { useEffect, useState } from "react";
import { AudioDropzone } from "@/components/AudioDropzone";
import { BookmarkPanel } from "@/components/BookmarkPanel";
import { RecorderControls } from "@/components/RecorderControls";
import { saveSession } from "@/lib/db";
import { buildRecordingFileName, downloadBlob } from "@/lib/export";
import type { Bookmark, LectureSession, SessionAudio } from "@/lib/types";

type NewRecordingViewProps = {
  sessionId: string;
  initialCategory: string;
  categories: string[];
  onCategoryCreated: (name: string) => void;
  onCreated: (category: string, audio: SessionAudio) => void;
};

export function NewRecordingView({
  sessionId,
  initialCategory,
  categories,
  onCategoryCreated,
  onCreated,
}: NewRecordingViewProps) {
  const [audio, setAudio] = useState<SessionAudio | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [category, setCategory] = useState(initialCategory);
  const [saving, setSaving] = useState(false);

  // The moment audio is captured (recording stopped or file dropped), the
  // session is created and we hand off to the review-only detail screen.
  // Only the metadata is persisted — the audio blob itself never touches
  // IndexedDB. For a live recording, it's downloaded to the device instead.
  useEffect(() => {
    if (!audio || saving) return;
    setSaving(true);

    const title = audio.name || "제목 없는 강의";
    const now = new Date();

    let audioFileName = audio.name;
    if (audio.kind === "recording") {
      audioFileName = buildRecordingFileName(category, title, now);
      downloadBlob(audioFileName, audio.blob);
    }

    const session: LectureSession = {
      id: sessionId,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
      category,
      title,
      durationMs: audio.durationMs,
      audioFileName,
      audioMimeType: audio.mimeType,
      bookmarks,
      keywords: [],
      referenceFileNames: [],
      aiResult: null,
    };

    saveSession(session).then(() => {
      if (category && !categories.includes(category)) {
        onCategoryCreated(category);
      }
      onCreated(category, audio);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <input
        list="category-options-new"
        value={category}
        onChange={(event) => setCategory(event.target.value)}
        placeholder="카테고리"
        className="w-40 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-zinc-600 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
      />
      <datalist id="category-options-new">
        {categories.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">녹음 / 업로드</h2>
          <RecorderControls
            elapsedMs={elapsedMs}
            isRecording={isRecording}
            onAudioChange={setAudio}
            onElapsedChange={setElapsedMs}
            onRecordingChange={setIsRecording}
          />
        </div>

        <div className="flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
          <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          또는
          <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>

        <AudioDropzone
          audio={audio}
          disabled={isRecording}
          onAudioChange={setAudio}
          onClear={() => setAudio(null)}
        />

        <BookmarkPanel
          bookmarks={bookmarks}
          elapsedMs={elapsedMs}
          isRecording={isRecording}
          onBookmarksChange={setBookmarks}
          onSeek={() => {}}
        />
      </section>
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { probeAudioDurationMs } from "@/lib/audio";
import { formatFileSize } from "@/lib/format";
import type { SessionAudio } from "@/lib/types";

const ACCEPTED = "audio/mpeg,audio/wav,audio/mp4,audio/webm,audio/x-m4a,.mp3,.wav,.m4a,.webm";

type AudioDropzoneProps = {
  audio: SessionAudio | null;
  disabled?: boolean;
  onAudioChange: (audio: SessionAudio) => void;
  onClear: () => void;
};

export function AudioDropzone({ audio, disabled, onAudioChange, onClear }: AudioDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  async function applyFile(file: File) {
    if (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|webm)$/i.test(file.name)) {
      return;
    }
    const durationMs = await probeAudioDurationMs(file);
    onAudioChange({
      kind: "upload",
      name: file.name,
      sizeLabel: formatFileSize(file.size),
      blob: file,
      mimeType: file.type || "audio/mpeg",
      durationMs,
    });
  }

  function openPicker() {
    if (disabled) return;
    inputRef.current?.click();
  }

  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Audio file
      </p>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") openPicker();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (disabled) return;
          const file = event.dataTransfer.files[0];
          if (file) void applyFile(file);
        }}
        className={`flex w-full cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-8 text-center transition ${
          isDragging
            ? "border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-950/30"
            : "border-slate-200 bg-zinc-50 hover:border-zinc-300 hover:bg-zinc-100/70 dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/70"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-white text-zinc-500 shadow-sm dark:bg-zinc-900 dark:text-zinc-400">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 16V4" strokeLinecap="round" />
            <path d="M8 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
          </svg>
        </span>
        {audio ? (
          <div className="flex w-full max-w-full items-start justify-center gap-2 px-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{audio.name}</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{audio.sizeLabel} · click or drop to replace</p>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onClear();
              }}
              disabled={disabled}
              aria-label="첨부 파일 제거"
              className="shrink-0 rounded-full p-1.5 text-zinc-400 transition hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Drop an audio file</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">MP3, WAV, M4A, or WebM</p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void applyFile(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}

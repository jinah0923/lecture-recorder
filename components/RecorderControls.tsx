"use client";

import { useEffect, useRef } from "react";
import { formatDuration, formatFileSize } from "@/lib/format";
import type { SessionAudio } from "@/lib/types";

type RecorderControlsProps = {
  elapsedMs: number;
  isRecording: boolean;
  onAudioChange: (audio: SessionAudio) => void;
  onElapsedChange: (ms: number) => void;
  onRecordingChange: (recording: boolean) => void;
};

export function RecorderControls({
  elapsedMs,
  isRecording,
  onAudioChange,
  onElapsedChange,
  onRecordingChange,
}: RecorderControlsProps) {
  const startedAtRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!isRecording) return;

    const id = window.setInterval(() => {
      if (startedAtRef.current) {
        onElapsedChange(Date.now() - startedAtRef.current);
      }
    }, 200);

    return () => window.clearInterval(id);
  }, [isRecording, onElapsedChange]);

  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    chunksRef.current = [];

    const preferredMimeType = "audio/webm;codecs=opus";
    const mimeType =
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(preferredMimeType)
        ? preferredMimeType
        : "audio/webm";

    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48_000 });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.start();

    startedAtRef.current = Date.now();
    onElapsedChange(0);
    onRecordingChange(true);
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder) {
      onRecordingChange(false);
      return;
    }

    recorder.onstop = () => {
      const mimeType = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mimeType });
      onAudioChange({
        kind: "recording",
        name: `Lecture ${new Date().toLocaleTimeString()}`,
        sizeLabel: formatFileSize(blob.size),
        blob,
        mimeType,
        durationMs: elapsedMs,
      });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };

    recorder.stop();
    onRecordingChange(false);
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Live recording</p>
        <span className="font-mono text-lg tabular-nums text-zinc-900">
          {formatDuration(elapsedMs)}
        </span>
      </div>

      <div className="mb-4 flex h-8 items-end justify-center gap-1">
        {Array.from({ length: 16 }).map((_, index) => (
          <span
            key={index}
            className={`wave-bar w-1 rounded-full ${isRecording ? "bg-indigo-500" : "bg-zinc-300"}`}
            style={{
              height: isRecording ? `${10 + ((index * 17) % 22)}px` : "8px",
              animationDelay: `${index * 0.05}s`,
              animationPlayState: isRecording ? "running" : "paused",
            }}
          />
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={startRecording}
          disabled={isRecording}
          className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-white" />
          Start
        </button>
        <button
          type="button"
          onClick={stopRecording}
          disabled={!isRecording}
          className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="h-2.5 w-2.5 rounded-sm bg-zinc-800" />
          Stop
        </button>
      </div>
    </div>
  );
}

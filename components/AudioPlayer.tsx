"use client";

import { useEffect, useState, type RefObject } from "react";
import { downloadBlob } from "@/lib/export";
import { formatDuration } from "@/lib/format";

const SPEEDS = [0.8, 1, 1.25, 1.5, 2];

type AudioPlayerProps = {
  audioUrl: string;
  audioBlob: Blob;
  fileName: string;
  audioRef: RefObject<HTMLAudioElement | null>;
};

export function AudioPlayer({ audioUrl, audioBlob, fileName, audioRef }: AudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const handleTimeUpdate = () => setCurrentMs(el.currentTime * 1000);
    const handleLoadedMetadata = () => setDurationMs(Number.isFinite(el.duration) ? el.duration * 1000 : 0);
    const handlePlay = () => setIsPlaying(true);
    const handlePauseOrEnd = () => setIsPlaying(false);

    el.addEventListener("timeupdate", handleTimeUpdate);
    el.addEventListener("loadedmetadata", handleLoadedMetadata);
    el.addEventListener("play", handlePlay);
    el.addEventListener("pause", handlePauseOrEnd);
    el.addEventListener("ended", handlePauseOrEnd);

    if (Number.isFinite(el.duration) && el.duration > 0) {
      setDurationMs(el.duration * 1000);
    }
    setSpeed(1);
    el.playbackRate = 1;

    return () => {
      el.removeEventListener("timeupdate", handleTimeUpdate);
      el.removeEventListener("loadedmetadata", handleLoadedMetadata);
      el.removeEventListener("play", handlePlay);
      el.removeEventListener("pause", handlePauseOrEnd);
      el.removeEventListener("ended", handlePauseOrEnd);
    };
  }, [audioRef, audioUrl]);

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  function handleSeekChange(value: number) {
    const el = audioRef.current;
    setCurrentMs(value);
    if (el) el.currentTime = value / 1000;
  }

  function handleSpeedChange(value: number) {
    setSpeed(value);
    const el = audioRef.current;
    if (el) el.playbackRate = value;
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={audioUrl} preload="metadata" className="hidden" />

      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">오디오 플레이어</p>
        <button
          type="button"
          onClick={() => downloadBlob(fileName, audioBlob)}
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          오디오 다운로드
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? "일시정지" : "재생"}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-500"
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="flex-1">
          <input
            type="range"
            min={0}
            max={durationMs || 0}
            value={Math.min(currentMs, durationMs || 0)}
            onChange={(event) => handleSeekChange(Number(event.target.value))}
            className="w-full accent-indigo-600"
          />
          <div className="mt-1 flex justify-between font-mono text-xs text-zinc-500 dark:text-zinc-400">
            <span>{formatDuration(currentMs)}</span>
            <span>{formatDuration(durationMs)}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1.5">
        <span className="mr-1 text-xs text-zinc-400 dark:text-zinc-500">배속</span>
        {SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => handleSpeedChange(value)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
              speed === value
                ? "bg-indigo-600 text-white"
                : "border border-slate-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {value}x
          </button>
        ))}
      </div>
    </div>
  );
}

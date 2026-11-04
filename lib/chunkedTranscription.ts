"use client";

// Speech-to-text for a long recording, one piece at a time from the browser.
// The recording is already split into ~10-minute pieces (lib/audioChunking.ts
// splitAudioInBrowser — re-encoded at real time boundaries; a plain
// File.slice() would cut a compressed file mid-frame and leave every piece
// after the first without its container header, undecodable). Each piece is
// uploaded and sent to /api/transcribe-chunk on its own, strictly one after
// another (parallel requests are what trips 429 rate limits), so each gets
// its own 300s server budget. The results are stitched in order and the
// whole transcript is stored server-side as the session's STT checkpoint
// (finalize), which the regular analysis job then picks up.
//
// Finished pieces are remembered in localStorage, so a reload or a failed
// piece doesn't redo the ones already transcribed.

import type { CheckpointSegment } from "@/lib/analysisPipeline";
import type { AudioChunkFile } from "@/lib/audioChunking";
import { uploadFileToBlob } from "@/lib/blobUpload";
import { friendlyHttpMessage, toFriendlyErrorMessage } from "@/lib/friendlyErrors";
import { PROHIBITED_CONTENT_MESSAGE } from "@/lib/geminiMessages";
import type { AnalysisEngine, BlockedChunkNotice } from "@/lib/types";

type PieceResult = { segments: CheckpointSegment[]; hasSpeech: boolean; blocked: boolean };
type StoredProgress = { fingerprint: string; results: Record<number, PieceResult> };

const PROGRESS_KEY_PREFIX = "lecture-recorder:sttPieces:";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

function progressKey(sessionId: string, engine: AnalysisEngine): string {
  return `${PROGRESS_KEY_PREFIX}${engine}:${sessionId}`;
}

function loadProgress(sessionId: string, engine: AnalysisEngine, fingerprint: string): Record<number, PieceResult> {
  try {
    const raw = window.localStorage.getItem(progressKey(sessionId, engine));
    const parsed = raw ? (JSON.parse(raw) as StoredProgress) : null;
    return parsed && parsed.fingerprint === fingerprint ? parsed.results : {};
  } catch {
    return {};
  }
}

function saveProgress(sessionId: string, engine: AnalysisEngine, fingerprint: string, results: Record<number, PieceResult>) {
  try {
    window.localStorage.setItem(progressKey(sessionId, engine), JSON.stringify({ fingerprint, results }));
  } catch {
    // Storage full or unavailable — the run still works, just can't resume.
  }
}

export function clearTranscriptionProgress(sessionId: string, engine: AnalysisEngine) {
  try {
    window.localStorage.removeItem(progressKey(sessionId, engine));
  } catch {
    // nothing to clear
  }
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (body && typeof body.error === "string") return toFriendlyErrorMessage(body.error);
  return friendlyHttpMessage(response.status) ?? `${fallback} (오류 코드 ${response.status})`;
}

// 429 / 5xx / a dropped connection are worth another try after a pause;
// anything else (bad request, missing key) won't change by retrying.
class RetryableError extends Error {}

async function transcribePiece(
  engine: AnalysisEngine,
  sessionId: string,
  piece: AudioChunkFile,
  endMs: number,
  index: number,
  total: number,
  keywords: string[],
  onUpload: (fraction: number) => void,
  upload: typeof uploadFileToBlob,
): Promise<PieceResult> {
  // Uploaded again on every attempt: the server deletes a piece's blob as
  // soon as it has read it.
  const uploaded = await upload(piece.blob, piece.fileName, piece.mimeType, onUpload);
  let response: Response;
  try {
    response = await fetch("/api/transcribe-chunk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine,
        sessionId,
        chunk: uploaded,
        startMs: piece.startMs,
        endMs,
        chunkIndex: index,
        chunkCount: total,
        keywords,
      }),
    });
  } catch (error) {
    throw new RetryableError(toFriendlyErrorMessage(error instanceof Error ? error.message : "네트워크 오류"));
  }
  if (!response.ok) {
    const message = await readError(response, `오디오 조각 ${index + 1}/${total} 음성 인식에 실패했습니다.`);
    if (response.status === 429 || response.status >= 500) throw new RetryableError(message);
    throw new Error(message);
  }
  const data = (await response.json()) as Partial<PieceResult>;
  return {
    segments: Array.isArray(data.segments) ? data.segments : [],
    hasSpeech: data.hasSpeech === true,
    blocked: data.blocked === true,
  };
}

export async function transcribeInPieces(options: {
  engine: AnalysisEngine;
  sessionId: string;
  pieces: AudioChunkFile[];
  durationMs: number;
  // Identifies the recording, so remembered pieces from a different file
  // are never reused.
  fingerprint: string;
  keywords: string[];
  onProgress: (message: string) => void;
  // Injectable for tests.
  upload?: typeof uploadFileToBlob;
}): Promise<{ segmentCount: number; blockedChunks: BlockedChunkNotice[] }> {
  const { engine, sessionId, pieces, durationMs, fingerprint, keywords, onProgress, upload = uploadFileToBlob } = options;
  const total = pieces.length;
  const results = loadProgress(sessionId, engine, fingerprint);
  const status = (done: number, detail = "") =>
    onProgress(`음성 인식 중... (${done}/${total} 조각 완료)${detail ? ` · ${detail}` : ""}`);

  for (let index = 0; index < total; index++) {
    const done = Object.keys(results).length;
    if (results[index]) continue;
    const piece = pieces[index];
    const endMs = pieces[index + 1]?.startMs ?? durationMs;
    for (let attempt = 1; ; attempt++) {
      try {
        status(done, `${index + 1}번째 조각 업로드 중`);
        results[index] = await transcribePiece(engine, sessionId, piece, endMs, index, total, keywords, (fraction) => {
          if (fraction < 1) status(done, `${index + 1}번째 조각 업로드 ${Math.round(fraction * 100)}%`);
          else status(done, `${index + 1}번째 조각 인식 중`);
        }, upload);
        break;
      } catch (error) {
        if (!(error instanceof RetryableError) || attempt >= MAX_ATTEMPTS) throw error;
        status(done, `${index + 1}번째 조각 재시도 대기 중 (${attempt}/${MAX_ATTEMPTS - 1})`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
    saveProgress(sessionId, engine, fingerprint, results);
    status(Object.keys(results).length);
  }

  // Stitched in recording order (pieces were already shifted onto the
  // recording's timeline by the server).
  const ordered = pieces.map((_piece, index) => results[index]);
  const segments = ordered.flatMap((result) => result.segments);
  const blockedChunks: BlockedChunkNotice[] = ordered.flatMap((result, index) =>
    result.blocked
      ? [{ chunkIndex: index + 1, chunkCount: total, startMs: pieces[index].startMs, endMs: pieces[index + 1]?.startMs ?? null }]
      : [],
  );
  if (!ordered.some((result) => result.hasSpeech)) {
    clearTranscriptionProgress(sessionId, engine);
    if (blockedChunks.length > 0) {
      throw new Error(
        `${PROHIBITED_CONTENT_MESSAGE} (차단 위치: 오디오 조각 ${blockedChunks.map((c) => `${c.chunkIndex}/${c.chunkCount}`).join(", ")})`,
      );
    }
    throw new Error("녹음에서 강의 음성을 찾지 못했습니다. 녹음 파일을 확인해 주세요.");
  }

  onProgress(`음성 인식 완료 (${total}/${total} 조각) · 전체 스크립트 저장 중...`);
  const response = await fetch("/api/transcribe-chunk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "finalize", engine, sessionId, segments, blockedChunks }),
  });
  if (!response.ok) throw new Error(await readError(response, "전체 스크립트를 저장하지 못했습니다."));
  clearTranscriptionProgress(sessionId, engine);
  return { segmentCount: segments.length, blockedChunks };
}

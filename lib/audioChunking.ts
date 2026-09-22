"use client";

// Type-only — erased at compile time, so this doesn't force-load the
// (large, dynamically-imported-at-runtime) ffmpeg.wasm module eagerly.
import type { FFmpeg } from "@ffmpeg/ffmpeg";

// Above this, the recording is split into CHUNK_DURATION_MS pieces in the
// browser before upload (see splitAudioInBrowser) — the server never sees the
// whole recording as one file. 30 minutes is comfortably inside what a single
// STT call can handle within the 300s function budget; conservative on
// purpose.
export const CHUNK_THRESHOLD_MS = 30 * 60 * 1000;
export const CHUNK_DURATION_MS = 20 * 60 * 1000;

export type AudioChunkFile = {
  blob: Blob;
  fileName: string;
  mimeType: string;
  // Offset of this piece into the original recording — the server shifts each
  // piece's transcript timestamps by this when merging.
  startMs: number;
};

// Pinned to the version matching the installed @ffmpeg/ffmpeg's expected
// core API. Loaded from a CDN at runtime (~30MB wasm, only fetched when a
// long recording actually needs splitting, then cached by the browser) rather
// than bundled, so it never weighs down the normal app load.
const FFMPEG_CORE_BASE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

// Used only to pick a plausible extension for the SOURCE file written into
// ffmpeg's virtual FS (ffmpeg's demuxer probing partly relies on the input
// filename's extension as a hint) — has no bearing on the output format,
// which is always re-encoded (see CHUNK_MIME_TYPE below) regardless of what
// the source container was.
const MIME_TO_EXTENSION: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

function guessExtension(fileName: string, mimeType: string): string {
  const match = fileName.match(/\.([a-zA-Z0-9]+)$/);
  if (match) return match[1].toLowerCase();
  return MIME_TO_EXTENSION[mimeType.split(";")[0]] ?? "webm";
}

export function shouldChunk(durationMs: number): boolean {
  return durationMs > CHUNK_THRESHOLD_MS;
}

// Every chunk is re-encoded to this format regardless of the source's own
// codec/container — see splitAudioInBrowser's file-level comment for why
// stream-copy (-c copy) was dropped in favor of always fully decoding and
// re-encoding. Opus/WebM specifically (not WAV/PCM) because a 20-minute
// lossless WAV chunk would run into the hundreds of MB; Opus keeps a
// 20-minute chunk to roughly 10-15MB at OPUS_BITRATE — small enough for a
// quick upload — and is this app's own recording format already
// (MediaRecorder produces audio/webm;codecs=opus), so the rest of the
// pipeline (Gemini upload, STT) already handles it as the default case.
const OPUS_BITRATE = "64k";
const CHUNK_MIME_TYPE = "audio/webm";
const CHUNK_EXTENSION = "webm";
// Fallback if the core build's libopus encoder is ever unavailable for some
// reason — PCM needs no external encoder at all (it's just interleaved
// samples), so this can never fail the same way an encoder could. Only used
// per-chunk, on retry, not as the default (see the file-size reasoning
// above for why it isn't the default).
const FALLBACK_MIME_TYPE = "audio/wav";
const FALLBACK_EXTENSION = "wav";

const CONVERSION_FAILURE_MESSAGE = "오디오 파일(.m4a 등)을 분석 가능한 형태로 변환하는 데 실패했습니다.";

// One encode attempt for [startMs, startMs + durationMs) of inputName into
// outputName. -ss before -i trades a little seek precision (ffmpeg decodes
// forward from the nearest preceding keyframe rather than sample-accurate
// seeking) for speed; a boundary landing a moment off is harmless since
// chunk transcripts are just concatenated afterward. -vn drops any embedded
// cover-art "video" stream some .m4a/.mp3 files carry, which an audio-only
// output container can't otherwise accept.
async function encodeSegment(
  ffmpeg: FFmpeg,
  inputName: string,
  outputName: string,
  startMs: number,
  durationMs: number,
  audioCodecArgs: string[],
): Promise<number> {
  return ffmpeg.exec([
    "-ss",
    String(startMs / 1000),
    "-i",
    inputName,
    "-t",
    String(durationMs / 1000),
    "-vn",
    ...audioCodecArgs,
    outputName,
  ]);
}

// Cuts a long recording into CHUNK_DURATION_MS pieces with ffmpeg.wasm. Each
// piece is fully decoded and re-encoded (never stream-copied) — this is what
// actually fixes .m4a (AAC/MP4) inputs: a plain -c copy re-mux of an MP4/M4A
// container at an arbitrary -ss offset is exactly the kind of operation that
// ffmpeg.wasm's single-threaded core has been unreliable at (moov-atom
// placement / edit-list handling that varies by encoder — e.g. iPhone Voice
// Memos exports), while a full decode+re-encode never attempts that
// container-level surgery at all: ffmpeg has to decode the whole stream to
// produce Opus either way, so the fragile path is simply never taken. This
// also means the output format no longer depends on the input's — every
// chunk comes out as Opus/WebM regardless of whether the source was
// mp3/m4a/wav/aac/ogg/flac/webm.
//
// onProgress(done, total) fires before each piece starts (done = pieces
// finished so far), so the UI can show "오디오 분할 중 (1/3)...".
export async function splitAudioInBrowser(
  file: Blob,
  fileName: string,
  mimeType: string,
  durationMs: number,
  onProgress?: (done: number, total: number) => void,
): Promise<AudioChunkFile[]> {
  const total = Math.max(1, Math.ceil(durationMs / CHUNK_DURATION_MS));
  const inputExtension = guessExtension(fileName, mimeType);
  const baseName = fileName.replace(/\.[^.]+$/, "") || "audio";

  let FFmpegCtor: typeof FFmpeg;
  let toBlobURL: (url: string, mimeType: string) => Promise<string>;
  try {
    ({ FFmpeg: FFmpegCtor } = await import("@ffmpeg/ffmpeg"));
    ({ toBlobURL } = await import("@ffmpeg/util"));
  } catch (error) {
    console.error("[audioChunking] failed to load @ffmpeg/ffmpeg module", error);
    throw new Error(CONVERSION_FAILURE_MESSAGE);
  }

  const ffmpeg = new FFmpegCtor();
  try {
    onProgress?.(0, total);
    try {
      await ffmpeg.load({
        // Static, unbundled copy (public/ffmpeg/) — when Next bundles the
        // package's own worker, webpack rewrites its dynamic import of the
        // core into a module lookup that can't resolve a runtime blob: URL.
        classWorkerURL: `${window.location.origin}/ffmpeg/worker.js`,
        coreURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
      });
    } catch (error) {
      console.error("[audioChunking] ffmpeg.wasm core failed to load", error);
      throw new Error(CONVERSION_FAILURE_MESSAGE);
    }

    const inputName = `input.${inputExtension}`;
    try {
      await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      console.error("[audioChunking] failed to load the source file into ffmpeg's virtual filesystem", {
        fileName,
        mimeType,
        error,
      });
      throw new Error(CONVERSION_FAILURE_MESSAGE);
    }

    const chunks: AudioChunkFile[] = [];
    for (let index = 0; index < total; index++) {
      onProgress?.(index, total);
      const startMs = index * CHUNK_DURATION_MS;

      let outputName = `chunk-${index}.${CHUNK_EXTENSION}`;
      let mimeType_ = CHUNK_MIME_TYPE;
      let exitCode: number;
      try {
        exitCode = await encodeSegment(ffmpeg, inputName, outputName, startMs, CHUNK_DURATION_MS, [
          "-c:a",
          "libopus",
          "-b:a",
          OPUS_BITRATE,
        ]);
      } catch (error) {
        console.error(`[audioChunking] ffmpeg.exec threw while encoding chunk ${index + 1}/${total} (opus)`, {
          fileName,
          mimeType,
          startMs,
          error,
        });
        exitCode = -1;
      }

      if (exitCode !== 0) {
        // Opus encoding failed for this chunk (e.g. the loaded core build
        // lacks libopus) — fall back to raw PCM once before giving up
        // entirely, since that path has no external encoder to fail.
        console.warn(
          `[audioChunking] opus encode failed for chunk ${index + 1}/${total} (exit ${exitCode}), retrying as wav`,
        );
        outputName = `chunk-${index}.${FALLBACK_EXTENSION}`;
        mimeType_ = FALLBACK_MIME_TYPE;
        try {
          exitCode = await encodeSegment(ffmpeg, inputName, outputName, startMs, CHUNK_DURATION_MS, [
            "-c:a",
            "pcm_s16le",
          ]);
        } catch (error) {
          console.error(`[audioChunking] ffmpeg.exec threw while encoding chunk ${index + 1}/${total} (wav fallback)`, {
            fileName,
            mimeType,
            startMs,
            error,
          });
          throw new Error(CONVERSION_FAILURE_MESSAGE);
        }
        if (exitCode !== 0) {
          console.error(`[audioChunking] wav fallback also failed for chunk ${index + 1}/${total}`, {
            fileName,
            mimeType,
            startMs,
            exitCode,
          });
          throw new Error(CONVERSION_FAILURE_MESSAGE);
        }
      }

      let data: Uint8Array;
      try {
        // readFile's return type also allows a string (its overload for
        // text-mode reads) — the requested outputs here are always binary
        // (webm/wav), so this should never actually happen, but keep TS
        // honest rather than casting it away.
        const raw = await ffmpeg.readFile(outputName);
        if (typeof raw === "string") {
          throw new Error("ffmpeg returned a text file for a binary chunk output — unexpected");
        }
        data = raw;
        await ffmpeg.deleteFile(outputName);
      } catch (error) {
        console.error(`[audioChunking] failed to read back encoded chunk ${index + 1}/${total}`, error);
        throw new Error(CONVERSION_FAILURE_MESSAGE);
      }
      // A last piece requested past the real end of the file comes out empty
      // (the reported duration can be slightly off) — nothing to transcribe.
      if (data.byteLength === 0) continue;
      chunks.push({
        // Copy into a fresh ArrayBuffer-backed view — ffmpeg's returned bytes
        // may sit on a SharedArrayBuffer, which Blob rejects.
        blob: new Blob([new Uint8Array(data)], { type: mimeType_ }),
        fileName: `${baseName}-part${index + 1}.${outputName.split(".").pop()}`,
        mimeType: mimeType_,
        startMs,
      });
    }
    onProgress?.(total, total);
    if (chunks.length === 0) throw new Error("오디오 분할 결과가 비어 있습니다.");
    return chunks;
  } finally {
    // Frees the wasm heap (which held a full copy of the recording).
    ffmpeg.terminate();
  }
}

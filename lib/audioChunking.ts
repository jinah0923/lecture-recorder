"use client";

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

// `-c copy` needs the output container to match the source's, so a chunk
// keeps the original file's extension rather than some fixed one.
function guessExtension(fileName: string, mimeType: string): string {
  const match = fileName.match(/\.([a-zA-Z0-9]+)$/);
  if (match) return match[1].toLowerCase();
  return MIME_TO_EXTENSION[mimeType.split(";")[0]] ?? "webm";
}

export function shouldChunk(durationMs: number): boolean {
  return durationMs > CHUNK_THRESHOLD_MS;
}

// Cuts a long recording into CHUNK_DURATION_MS pieces with ffmpeg.wasm,
// stream-copying (no re-encode: fast, lossless, format-agnostic). This is what
// replaced server-side ffmpeg-static — Vercel's runtime doesn't ship a usable
// binary, and splitting in the browser also removes the download-whole-file /
// disk / memory / 300s constraints from the Function entirely.
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
  const extension = guessExtension(fileName, mimeType);
  const baseName = fileName.replace(/\.[^.]+$/, "") || "audio";

  const [{ FFmpeg }, { toBlobURL }] = await Promise.all([import("@ffmpeg/ffmpeg"), import("@ffmpeg/util")]);
  const ffmpeg = new FFmpeg();
  try {
    onProgress?.(0, total);
    await ffmpeg.load({
      // Static, unbundled copy (public/ffmpeg/) — when Next bundles the
      // package's own worker, webpack rewrites its dynamic import of the core
      // into a module lookup that can't resolve a runtime blob: URL.
      classWorkerURL: `${window.location.origin}/ffmpeg/worker.js`, // absolute: a relative path gets resolved against the bundle's file:// import.meta.url
      coreURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
    });

    const inputName = `input.${extension}`;
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

    const chunks: AudioChunkFile[] = [];
    for (let index = 0; index < total; index++) {
      onProgress?.(index, total);
      const startMs = index * CHUNK_DURATION_MS;
      const outputName = `chunk-${index}.${extension}`;
      // -ss before -i trades a little seek precision (it can snap to a
      // packet boundary) for speed; a boundary landing a moment off is
      // harmless since chunk transcripts are just concatenated afterward.
      const exitCode = await ffmpeg.exec([
        "-ss",
        String(startMs / 1000),
        "-i",
        inputName,
        "-t",
        String(CHUNK_DURATION_MS / 1000),
        "-c",
        "copy",
        outputName,
      ]);
      if (exitCode !== 0) {
        throw new Error(`오디오 분할에 실패했습니다 (조각 ${index + 1}/${total}). 지원되지 않는 파일 형식일 수 있어요.`);
      }
      const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
      await ffmpeg.deleteFile(outputName);
      // A last piece requested past the real end of the file comes out empty
      // (the reported duration can be slightly off) — nothing to transcribe.
      if (data.byteLength === 0) continue;
      chunks.push({
        // Copy into a fresh ArrayBuffer-backed view — ffmpeg's returned bytes
        // may sit on a SharedArrayBuffer, which Blob rejects.
        blob: new Blob([new Uint8Array(data)], { type: mimeType }),
        fileName: `${baseName}-part${index + 1}.${extension}`,
        mimeType,
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

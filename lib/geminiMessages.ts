// Gemini-related strings shared by the server (lib/gemini.ts) and the client
// (components/RecordingDetailView.tsx, components/ReviewPanel.tsx). Kept free
// of @google/genai imports so client bundles can use it.

// Shown when Google rejects a request as PROHIBITED_CONTENT — a
// non-configurable, server-side block that SAFETY_SETTINGS can't lift. The
// server puts this exact sentence into the job's error message (optionally
// followed by where it happened), and the client matches on it to show a
// dedicated modal instead of the generic failure toast.
export const PROHIBITED_CONTENT_MESSAGE =
  "구글 AI 핵심 보안 정책에 의해 분석이 차단되었습니다. 강의 내용 중 AI가 허용하지 않는 극단적인 심리/임상 사례나 실제 " +
  "개인정보가 포함되어 있을 수 있습니다. 해당 구간을 잘라내거나 다른 파일로 시도해 주세요.";

// Splits a failure message into the policy-block notice and whatever detail
// the server appended after it (e.g. which audio chunk was blocked). Returns
// null for any other kind of failure.
export function parseProhibitedContentError(message: string): { detail: string } | null {
  const index = message.indexOf(PROHIBITED_CONTENT_MESSAGE);
  if (index === -1) return null;
  return { detail: message.slice(index + PROHIBITED_CONTENT_MESSAGE.length).trim() };
}

// Every placeholder line (blockedChunkTranscriptText) contains this phrase —
// the analysis prompt checks for it to tell the model about the gap.
export const BLOCKED_CHUNK_MARKER = "구글 보안 정책(민감성 어휘 감지)으로 차단되어 받아쓰지 못했습니다";

type ChunkRange = { chunkIndex: number; chunkCount: number; startMs: number; endMs: number | null };

function describeChunkRange(chunk: ChunkRange): string {
  return `${chunk.chunkIndex}/${chunk.chunkCount} 조각, ${formatClockTime(chunk.startMs)}~${
    chunk.endMs !== null ? formatClockTime(chunk.endMs) : "끝"
  }`;
}

// Written into the transcript in place of a stretch Gemini refused, so the
// analysis model (and the reader) sees a marked gap rather than nothing.
export function blockedChunkTranscriptText(chunk: ChunkRange): string {
  return `⚠️ 이 구간(${describeChunkRange(chunk)})은 ${BLOCKED_CHUNK_MARKER}.`;
}

export function formatClockTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

// "일부 구간(2/5 조각, 20:00~40:00)이 구글 보안 정책(민감성 어휘 감지)으로 차단되었습니다."
export function describeBlockedChunks(chunks: ChunkRange[]): string {
  return `일부 구간(${chunks.map(describeChunkRange).join(" · ")})이 구글 보안 정책(민감성 어휘 감지)으로 차단되었습니다.`;
}

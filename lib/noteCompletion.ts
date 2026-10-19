// Detecting and repairing a lecture note that stopped partway through.
//
// The analysis call already has the model's full output budget (65,536
// tokens for Gemini Flash) and a hard MAX_TOKENS stop is reported as an
// error, yet notes still came back ending mid-sentence ("한계점:" and then
// nothing) inside a perfectly valid JSON response — the model closing the
// string early on its own. There's no finish reason for that, so the prompt
// asks for an explicit end marker as the very last line of lectureNote: a
// note without it was cut short and gets a continuation call that picks up
// where it stopped.

import { getJobTimeRemainingMs } from "@/lib/jobDeadline";

export const NOTE_END_MARKER = "[[END_OF_NOTE]]";

export const NOTE_END_MARKER_RULE =
  `[완결 표시 — 필수] lectureNote를 끝까지 다 쓴 뒤, 맨 마지막 줄에 ${NOTE_END_MARKER} 를 단독으로 한 줄 적으세요. ` +
  "이 표시는 노트가 중간에 끊기지 않고 완성되었다는 확인용입니다(화면에는 보이지 않습니다). 노트를 마무리하기 전에는 " +
  "절대 쓰지 말고, 분량이 아무리 길어져도 내용을 줄이거나 중간에 끊지 말고 끝까지 작성한 뒤에만 쓰세요.";

// Shown at the end of a note that is still incomplete after the
// continuation attempts (or when there was no time left to try).
export const TRUNCATION_WARNING =
  "> ⚠️ AI 출력이 이 지점에서 끊겼을 수 있습니다. 끝부분 내용이 빠졌다면 '자료 추가해서 다시 분석'으로 다시 생성하거나, " +
  "'AI 심화 탐구'에서 \"○○ 이후 내용이 빠졌어\"처럼 요청해 녹음·교재 기반으로 복원하세요.";

const MAX_CONTINUATION_ROUNDS = 2;
// A continuation can be as long as the original output; below this much
// time left in the job, trying would just get the whole job killed.
const MIN_TIME_FOR_CONTINUATION_MS = 60_000;
// Head room kept after a continuation call for saving the result.
const SAVE_HEADROOM_MS = 15_000;

export function hasNoteEndMarker(note: string): boolean {
  return note.includes(NOTE_END_MARKER);
}

export function stripNoteEndMarker(note: string): string {
  return note.split(NOTE_END_MARKER).join("").trimEnd();
}

// The note minus its last line, and that last line — the line the cut most
// likely went through, so the continuation rewrites it whole instead of
// trying to resume mid-word.
function splitAtLastLine(note: string): { head: string; lastLine: string } {
  const trimmed = note.trimEnd();
  const cut = trimmed.lastIndexOf("\n");
  return cut === -1 ? { head: "", lastLine: trimmed } : { head: trimmed.slice(0, cut), lastLine: trimmed.slice(cut + 1) };
}

export function buildContinuationPrompt(noteSoFar: string, lastLine: string): string {
  return [
    "[이어 쓰기 요청] 당신이 방금 작성하던 lectureNote(상세 강의노트)가 출력 도중 끊겼습니다. 위 강의 자료(녹음/스크립트·" +
      "참고자료)와 지금까지 쓴 노트를 바탕으로, 끊긴 지점부터 노트의 나머지를 끝까지 이어서 작성하세요.",
    "",
    "[지금까지 작성된 lectureNote — 마지막 줄 제외]",
    noteSoFar || "(없음)",
    "",
    "[끊긴 마지막 줄]",
    lastLine,
    "",
    "작성 규칙:",
    "- 출력은 JSON이 아니라 마크다운 본문만 쓰세요(코드 블록으로 감싸지 말 것).",
    "- 출력의 첫 줄은 위 [끊긴 마지막 줄]을 처음부터 다시 쓴 완성된 줄이어야 합니다(이 줄이 원래 줄을 대체합니다). " +
      "그 다음 줄부터 노트의 남은 내용을 이어 쓰세요.",
    "- 이미 작성된 내용을 반복하거나 처음부터 다시 쓰지 마세요. 앞부분과 같은 제목 번호 체계·서식 규칙을 그대로 이어 쓰세요.",
    "- 강의 자료에서 아직 노트에 옮기지 않은 내용을 빠짐없이 끝까지 작성하세요.",
    `- 노트를 끝까지 다 쓴 뒤 마지막 줄에 ${NOTE_END_MARKER} 를 단독으로 적으세요. 이미 노트가 사실상 끝난 상태였다면 ` +
      `첫 줄(완성된 마지막 줄)과 ${NOTE_END_MARKER} 만 출력하세요.`,
  ].join("\n");
}

// continueNote(noteSoFar, lastLine, timeoutMs) returns the continuation text
// (its first line replaces lastLine). Returns the completed note with the
// marker removed, or — when it still couldn't be completed — the note with
// TRUNCATION_WARNING appended.
export async function completeTruncatedNote(
  note: string,
  continueNote: (noteSoFar: string, lastLine: string, timeoutMs: number) => Promise<string>,
  logLabel: string,
): Promise<string> {
  if (!note.trim() || hasNoteEndMarker(note)) return stripNoteEndMarker(note);

  let current = note;
  for (let round = 1; round <= MAX_CONTINUATION_ROUNDS; round++) {
    const remaining = getJobTimeRemainingMs();
    if (remaining < MIN_TIME_FOR_CONTINUATION_MS) {
      console.warn(`[${logLabel}] note looks truncated but no time left to continue`, { remainingMs: remaining });
      break;
    }
    const { head, lastLine } = splitAtLastLine(current);
    console.warn(`[${logLabel}] note has no end marker — requesting continuation`, {
      round,
      noteChars: current.length,
      lastLine: lastLine.slice(0, 120),
    });
    let continuation: string;
    try {
      continuation = (await continueNote(head, lastLine, remaining - SAVE_HEADROOM_MS)).trim();
    } catch (error) {
      console.error(`[${logLabel}] continuation failed`, error);
      break;
    }
    // A fenced reply despite the instructions.
    continuation = continuation.replace(/^```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "");
    if (!continuation) break;
    current = head ? `${head}\n${continuation}` : continuation;
    if (hasNoteEndMarker(current)) return stripNoteEndMarker(current);
  }
  return `${stripNoteEndMarker(current)}\n\n${TRUNCATION_WARNING}`;
}

// Salvaging an analysis that was stopped at the time limit (lib/jobDeadline.ts
// hardStopSignal). The worker streams its JSON answer — {"summary": …,
// "lectureNote": …, "checklist": […]}, in that order — so a stop leaves a
// valid prefix of it. These read whatever fields got written, close markup
// the cut left open, and mark the cut point in the note.

import type { RawAnalysisResponse } from "@/lib/analysisPipeline";

export const TIMEOUT_CUT_NOTICE =
  "> ⚠️ AI 출력이 시간 제한으로 이 지점에서 끊겼습니다. 상단의 '자료 추가해서 다시 분석'이나 '심화 탐구'를 통해 이어 쓰기를 " +
  "진행해 주세요.";

// The JSON string value starting at `start` (just past its opening quote),
// decoded — up to its closing quote, or to the end of a cut-off answer.
function readJsonString(text: string, start: number): { value: string; end: number; complete: boolean } {
  let value = "";
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') return { value, end: index + 1, complete: true };
    if (char !== "\\") {
      value += char;
      index++;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) break; // cut inside an escape
    if (next === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // cut inside \uXXXX
      value += String.fromCharCode(parseInt(hex, 16));
      index += 6;
      continue;
    }
    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
    value += escapes[next] ?? next;
    index += 2;
  }
  return { value, end: text.length, complete: false };
}

function readField(text: string, key: string): { value: string; complete: boolean } | null {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!match) return null;
  const { value, complete } = readJsonString(text, match.index + match[0].length);
  return { value, complete };
}

// Only the items that were written out completely.
function readStringArray(text: string, key: string): string[] {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text);
  if (!match) return [];
  const items: string[] = [];
  let index = match.index + match[0].length;
  while (index < text.length) {
    const open = text.indexOf('"', index);
    const close = text.indexOf("]", index);
    if (open === -1 || (close !== -1 && close < open)) break;
    const item = readJsonString(text, open + 1);
    if (!item.complete) break;
    items.push(item.value);
    index = item.end;
  }
  return items;
}

export function salvageAnalysisJson(text: string): RawAnalysisResponse & { lectureNote: string } {
  return {
    summary: readField(text, "summary")?.value ?? "",
    lectureNote: readField(text, "lectureNote")?.value ?? "",
    checklist: readStringArray(text, "checklist"),
  };
}

// The cut can land inside a code fence (a ```mermaid diagram), a multi-line
// $$ formula, a <mark> or a **bold** — close them, so the notice after it
// isn't swallowed into the open block.
export function closeDanglingMarkup(note: string): string {
  let result = note.trimEnd();
  const lines = result.split("\n");
  const fenceCount = lines.filter((line) => /^\s*```/.test(line)).length;
  if (fenceCount % 2 === 1) return `${result}\n\`\`\``;
  const mathFenceCount = lines.filter((line) => line.trim() === "$$").length;
  if (mathFenceCount % 2 === 1) return `${result}\n$$`;
  const lastLine = lines[lines.length - 1] ?? "";
  const opens = (lastLine.match(/<mark>/g) ?? []).length;
  const closes = (lastLine.match(/<\/mark>/g) ?? []).length;
  if ((lastLine.match(/\*\*/g) ?? []).length % 2 === 1) result += "**";
  if (opens > closes) result += "</mark>".repeat(opens - closes);
  return result;
}

export function appendTimeoutNotice(note: string): string {
  const closed = closeDanglingMarkup(note);
  return closed ? `${closed}\n\n${TIMEOUT_CUT_NOTICE}` : TIMEOUT_CUT_NOTICE;
}

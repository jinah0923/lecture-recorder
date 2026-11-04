// "모두 바꾸기" in the transcript viewer (components/TranscriptPanel.tsx):
// replaces every occurrence of the search term across all segments — for an
// STT mistake repeated throughout a recording ('정화' heard for '정아').
//
// Matching is exactly what the search box highlights: a literal,
// case-insensitive match. Placeholders for stretches that couldn't be
// transcribed (source "blocked") aren't speech, so they're left alone.

import type { TranscriptSegment } from "@/lib/types";

// The panel → page contract for "모두 바꾸기" (components/TranscriptPanel.tsx →
// RecordingDetailView.tsx). alsoNote: the same replacement in the lecture
// note, summary and checklist ("강의노트·요약·체크리스트에도 적용").
export type ReplaceAllRequest = { transcript: TranscriptSegment[]; alsoNote?: { from: string; to: string } };
export type ReplaceAllUndoResult = {
  savedToCloud: boolean;
  // false: the note was edited after the replace, so its undo was skipped
  // rather than throwing that edit away (the script is restored either way).
  noteRestored: boolean;
};
export type ReplaceAllResult = {
  // true when the cloud copy was updated too; false = saved on this device
  // only (signed out / offline), it goes up with the next successful sync.
  savedToCloud: boolean;
  noteCount: number;
  undo: () => Promise<ReplaceAllUndoResult>;
};

function literalPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

export function countTranscriptMatches(transcript: TranscriptSegment[], query: string): number {
  if (!query) return 0;
  const pattern = literalPattern(query);
  return transcript.reduce(
    (total, segment) => (segment.source === "blocked" ? total : total + (segment.text.match(pattern)?.length ?? 0)),
    0,
  );
}

export function replaceAllInText(text: string, query: string, replacement: string): { text: string; count: number } {
  if (!query) return { text, count: 0 };
  let count = 0;
  const next = text.replace(literalPattern(query), () => {
    count++;
    return replacement;
  });
  return { text: next, count };
}

// Link / image targets ("](slide_3)", "](https://…)") and HTML tags
// ("<mark>") are markup, not words — left exactly as they are, so replacing
// a short word can't break a slide image or a highlight.
const MARKUP_PATTERN = /(\]\([^)]*\)|<\/?[a-zA-Z][^>]*>)/;

// The same replacement for the note / summary, when "강의노트·요약·체크리스트에도
// 적용" is checked.
export function replaceAllInMarkdown(markdown: string, query: string, replacement: string): { text: string; count: number } {
  if (!query) return { text: markdown, count: 0 };
  let count = 0;
  const text = markdown
    .split(MARKUP_PATTERN)
    .map((part, index) => {
      // split() with a capturing group puts the markup at odd indices.
      if (index % 2 === 1) return part;
      const replaced = replaceAllInText(part, query, replacement);
      count += replaced.count;
      return replaced.text;
    })
    .join("");
  return { text, count };
}

// Segments without a match keep their identity, so nothing else re-renders.
export function replaceAllInTranscript(
  transcript: TranscriptSegment[],
  query: string,
  replacement: string,
): { transcript: TranscriptSegment[]; count: number } {
  if (!query) return { transcript, count: 0 };
  const pattern = literalPattern(query);
  let count = 0;
  const next = transcript.map((segment) => {
    if (segment.source === "blocked") return segment;
    // A function replacement, so "$&" or "$1" in the new word stays literal.
    const text = segment.text.replace(pattern, () => {
      count++;
      return replacement;
    });
    return text === segment.text ? segment : { ...segment, text };
  });
  return { transcript: count > 0 ? next : transcript, count };
}

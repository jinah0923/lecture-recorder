// "모두 바꾸기" in the transcript viewer (components/TranscriptPanel.tsx):
// replaces every occurrence of the search term across all segments — for an
// STT mistake repeated throughout a recording ('정화' heard for '정아').
//
// Matching is exactly what the search box highlights: a literal,
// case-insensitive match. Placeholders for stretches that couldn't be
// transcribed (source "blocked") aren't speech, so they're left alone.

import type { TranscriptSegment } from "@/lib/types";

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

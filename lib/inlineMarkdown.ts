// Inline formatting for the lecture note, shared by all three renderers
// (lib/markdown.tsx on screen, lib/pdfExport.ts, and the Notion export in
// app/api/export-to-notion/route.ts) so they can't disagree about what's
// bold or highlighted. Supports exactly two constructs: **bold** and
// <mark>highlight</mark> — the note prompt emits nothing else inline, and
// no other HTML is ever interpreted (this returns plain strings; each
// renderer does its own escaping).

export type InlinePart = { text: string; bold: boolean };
// A run of parts sharing one highlight state, so a highlighted sentence with
// bold words inside renders as one continuous <mark>, not several abutting
// ones with gaps between them.
export type InlineGroup = { highlight: boolean; parts: InlinePart[] };

const MARK_SPLIT = /(<mark\b[^>]*>[\s\S]*?<\/mark>)/i;
const MARK_WHOLE = /^<mark\b[^>]*>([\s\S]*)<\/mark>$/i;
const MARK_TAG = /<\/?mark\b[^>]*>/gi;
const BOLD_SPLIT = /(\*\*[^*]+\*\*)/;

export function stripMarkTags(text: string): string {
  return text.replace(MARK_TAG, "");
}

// Any ** left over after pairing (one opened and never closed on this
// line — typically a formula the model broke across lines, or half-bolded)
// is dropped instead of showing as literal asterisks.
function splitBold(text: string): InlinePart[] {
  return text
    .split(BOLD_SPLIT)
    .filter((part) => part.length > 0)
    .map((part) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4
        ? { text: part.slice(2, -2), bold: true }
        : { text: part.replace(/\*\*/g, ""), bold: false },
    )
    .filter((part) => part.text.length > 0);
}

export function tokenizeInline(text: string): InlineGroup[] {
  // The model sometimes writes **<mark>X</mark>** instead of
  // <mark>**X**</mark>; splitting on the mark first would strand each ** on
  // its own and render them as literal asterisks.
  const normalized = text.replace(/\*\*\s*(<mark\b[^>]*>)([\s\S]*?)<\/mark>\s*\*\*/gi, "$1**$2**</mark>");
  const groups: InlineGroup[] = [];
  for (const chunk of normalized.split(new RegExp(MARK_SPLIT.source, "gi"))) {
    if (!chunk) continue;
    const whole = chunk.match(MARK_WHOLE);
    // An unpaired tag (opened but never closed on this line) is dropped
    // rather than shown to the user as raw HTML.
    const parts = splitBold(stripMarkTags(whole ? whole[1] : chunk));
    if (parts.length > 0) groups.push({ highlight: whole !== null, parts });
  }
  return groups;
}

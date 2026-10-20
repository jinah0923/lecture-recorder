// Splitting a lecture note into the pages LectureNote.tsx shows.
//
// "## 대주제" (H2, or a stray H1) is the page break the note prompt is built
// around (MAJOR_TOPIC_RULE in lib/promptRules.ts). But notes don't always
// cooperate — everything under a single "##", or only "###" headings — and
// splitting on H2 alone then turned a long note into one endless page. So a
// section that is still too long is split again: at its "###" headings, and
// failing that between paragraphs. Never inside a code fence (a ```mermaid
// diagram, whose lines can start with "#"), a multi-line $$ formula or a
// <details> block, and never between a bullet and its indented sub-bullets.

import { displayMathFenceClose, matchDisplayMathLine } from "@/lib/inlineMath";
import { isCodeFence, parseListLine } from "@/lib/noteBlocks";

// Character-count based (not a fixed section count) so a page holds roughly
// a consistent amount of reading regardless of how verbose each section is.
export const CHARS_PER_PAGE = 800;
// A section up to this long stays whole on one page (context intact); a
// longer one is split further (see above).
const MAX_SECTION_CHARS = CHARS_PER_PAGE * 2;
// Below this, a split-off piece is merged into the next one.
const MIN_PIECE_CHARS = 200;
// Below this, a page takes the next section even past CHARS_PER_PAGE.
const MIN_PAGE_CHARS = 300;

const MAJOR_HEADING = /^#{1,2}\s+/;
const SUB_HEADING = /^#{3,6}\s+/;

// inBlock[i]: line i sits inside a code fence / $$ formula / <details> block
// that opened on an earlier line — no chunk may start there.
function scanBlocks(lines: string[]): boolean[] {
  const inBlock: boolean[] = [];
  let fence = false;
  let mathClose: string | null = null;
  let detailsDepth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    inBlock.push(fence || mathClose !== null || detailsDepth > 0);
    if (isCodeFence(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (mathClose !== null) {
      if (line === mathClose) mathClose = null;
      continue;
    }
    if (matchDisplayMathLine(line) === null) {
      const close = displayMathFenceClose(line);
      if (close) {
        mathClose = close;
        continue;
      }
    }
    if (line === "<details>") detailsDepth++;
    else if (line === "</details>") detailsDepth = Math.max(0, detailsDepth - 1);
  }
  return inBlock;
}

type Range = { start: number; end: number }; // [start, end) line indices

function splitRange(range: Range, isBreak: (index: number) => boolean): Range[] {
  const parts: Range[] = [];
  let start = range.start;
  for (let index = range.start + 1; index < range.end; index++) {
    if (isBreak(index)) {
      parts.push({ start, end: index });
      start = index;
    }
  }
  parts.push({ start, end: range.end });
  return parts;
}

export function splitIntoSections(markdown: string): string[] {
  const lines = markdown.split("\n");
  const inBlock = scanBlocks(lines);
  const text = (range: Range) => lines.slice(range.start, range.end).join("\n");
  const isHeading = (pattern: RegExp) => (index: number) => !inBlock[index] && pattern.test(lines[index].trim());
  // A paragraph start: first non-blank line after a blank one, outside any
  // block, and not an indented sub-bullet continuing the list above it.
  const isParagraphStart = (index: number) => {
    if (inBlock[index] || !lines[index].trim() || lines[index - 1].trim()) return false;
    const item = parseListLine(lines[index]);
    return !(item && item.depth > 0);
  };

  // A piece too short to stand as a page of its own — typically the "## 대주제"
  // line right before its first "###" — joins the piece after it, so a
  // heading never sits alone at the bottom of one page.
  const joinShortPieces = (pieces: Range[]): Range[] => {
    const joined: Range[] = [];
    let carryStart: number | null = null;
    pieces.forEach((piece, index) => {
      const start = carryStart ?? piece.start;
      if (index < pieces.length - 1 && text({ start, end: piece.end }).trim().length < MIN_PIECE_CHARS) {
        carryStart = start;
        return;
      }
      joined.push({ start, end: piece.end });
      carryStart = null;
    });
    return joined;
  };

  const sections: Range[] = [];
  for (const major of splitRange({ start: 0, end: lines.length }, isHeading(MAJOR_HEADING))) {
    if (text(major).length <= MAX_SECTION_CHARS) {
      sections.push(major);
      continue;
    }
    for (const sub of joinShortPieces(splitRange(major, isHeading(SUB_HEADING)))) {
      if (text(sub).length <= MAX_SECTION_CHARS) sections.push(sub);
      else sections.push(...joinShortPieces(splitRange(sub, isParagraphStart)));
    }
  }

  return sections.map(text).filter((section) => section.trim().length > 0);
}

// Accumulates whole sections onto a page until the next one would push the
// page past CHARS_PER_PAGE (counting spaces), then starts a new page — a
// section is never split mid-way, so context stays intact. A page still
// holding less than MIN_PAGE_CHARS takes the next section anyway, so a short
// section (a "## 1부" with a few lines) never ends up as a near-empty page.
export function paginate(markdown: string): string[] {
  const sections = splitIntoSections(markdown);
  if (sections.length === 0) return [""];

  const pages: string[] = [];
  let currentSections: string[] = [];
  let currentLength = 0;

  for (const section of sections) {
    if (
      currentSections.length > 0 &&
      currentLength >= MIN_PAGE_CHARS &&
      currentLength + section.length > CHARS_PER_PAGE
    ) {
      pages.push(currentSections.join("\n\n"));
      currentSections = [];
      currentLength = 0;
    }
    currentSections.push(section);
    currentLength += section.length;
  }
  if (currentSections.length > 0) pages.push(currentSections.join("\n\n"));

  return pages;
}

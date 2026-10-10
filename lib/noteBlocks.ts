// Block-level line patterns shared by all three lecture-note renderers
// (lib/markdown.tsx, lib/pdfExport.ts, app/api/export-to-notion/route.ts),
// alongside lib/inlineMarkdown.ts for inline formatting.

import { protectMath, splitMathPlaceholders } from "@/lib/inlineMath";

// Formula/equation lines — the prompt (EQUATION_FORMAT_RULE in
// lib/promptRules.ts) has the model write each formula as its own unbroken
// `> 🧮 자산 = 부채 + 자본` line, so it renders as a standalone formula block
// instead of being split across bullets with dangling ** markers.
export const EQUATION_MARKER = "🧮";

// The formula text of an equation line ("> 🧮 X" or a bare "🧮 X"), or null.
export function matchEquationLine(line: string): string | null {
  const match = line.trim().match(/^(?:>\s*)?🧮\s*(.*)$/u);
  return match && match[1].trim() ? match[1].trim() : null;
}

// The text of a plain blockquote line ("> X"). Callers check emoji callouts
// and equation lines first — this matches any remaining ">" line.
export function matchQuoteLine(line: string): string | null {
  const match = line.trim().match(/^>\s?(.*)$/);
  return match ? match[1] : null;
}

// Opening/closing line of a fenced code block (``` or ```lang).
export function isCodeFence(line: string): boolean {
  return /^```/.test(line.trim());
}

// Consumes a fenced code block starting at `start` (the opening fence) and
// returns its raw lines plus the index just past the closing fence. An
// unclosed fence runs to the end of the note.
export function readCodeFence(lines: string[], start: number): { code: string; next: number } {
  const body: string[] = [];
  let cursor = start + 1;
  while (cursor < lines.length && !isCodeFence(lines[cursor])) {
    body.push(lines[cursor]);
    cursor++;
  }
  return { code: body.join("\n"), next: Math.min(cursor + 1, lines.length) };
}

// Consecutive lines starting at `start` that `match` accepts — e.g. a
// multi-step derivation written as several `> 🧮` lines in a row renders as
// one formula block.
export function readMatchingRun(
  lines: string[],
  start: number,
  match: (line: string) => string | null,
): { items: string[]; next: number } {
  const items: string[] = [];
  let cursor = start;
  while (cursor < lines.length) {
    const item = match(lines[cursor]);
    if (item === null) break;
    items.push(item);
    cursor++;
  }
  return { items, next: cursor };
}

// ---- Lists ----------------------------------------------------------------
// One parser for list lines, shared by the screen renderer, the Notion export
// and the clipboard/.md export, so all three agree on what nests under what.

export type ListLine = { depth: number; ordered: boolean; marker: string; text: string };
export type ListNode = ListLine & { children: ListNode[] };

// Indent width with tabs counted as 4 columns; every 2 columns is one level
// (the note prompt writes sub-bullets with 2-space indents).
function indentWidth(rawLine: string): number {
  const leading = rawLine.match(/^[ \t]*/)?.[0] ?? "";
  return leading.replace(/\t/g, "    ").length;
}

export function parseListLine(rawLine: string): ListLine | null {
  const line = rawLine.trim();
  const bullet = line.match(/^([-*•])\s+(.*)$/);
  const ordered = line.match(/^(\d+[.)])\s+(.*)$/);
  const match = bullet ?? ordered;
  if (!match) return null;
  return { depth: Math.floor(indentWidth(rawLine) / 2), ordered: !!ordered, marker: match[1], text: match[2] };
}

// Turns a flat, depth-tagged run of list lines into a proper tree — each
// item's children are whatever immediately-following items sit at a
// strictly greater depth, matching standard nested-markdown-list semantics.
// A jump of several levels at once still nests just one level deeper.
export function buildListTree(items: ListLine[]): ListNode[] {
  const roots: ListNode[] = [];
  const stack: ListNode[] = [];
  for (const item of items) {
    const node: ListNode = { ...item, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) stack.pop();
    (stack.length === 0 ? roots : stack[stack.length - 1].children).push(node);
    stack.push(node);
  }
  return roots;
}

// Formula delimiters as Notion's paste understands them: $...$ inline and
// $$...$$ display. \(...\) / \[...\] (which the AI sometimes writes and the
// app renders) are rewritten; the formula text itself, and anything that
// isn't a formula ("$5와 $10"), is left exactly as written.
function toDollarMath(line: string): string {
  const { text, spans } = protectMath(line);
  if (spans.length === 0) return line;
  return splitMathPlaceholders(text)
    .map((piece) => {
      if (typeof piece === "string") return piece;
      const { tex, display } = spans[piece];
      return display ? `$$${tex}$$` : `$${tex}$`;
    })
    .join("");
}

// The note as Notion's markdown paste expects it: nested list items indented
// by exactly 4 spaces per level (Notion flattens 2-space indents), and "•"
// bullets — which the in-app renderer accepts but markdown doesn't — turned
// into "-". Levels come from the actual nesting (buildListTree's rules), not a
// blind 2→4 substitution, so 2-space, 4-space or mixed indents all map to
// consecutive levels. Code fences are left untouched.
export function toNotionPasteMarkdown(markdown: string): string {
  const out: string[] = [];
  const stack: number[] = [];
  let inFence = false;
  for (const rawLine of markdown.split("\n")) {
    if (isCodeFence(rawLine)) inFence = !inFence;
    if (inFence || isCodeFence(rawLine)) {
      stack.length = 0;
      out.push(rawLine);
      continue;
    }
    // A multi-line display formula's own "\[" / "\]" lines -> "$$".
    const trimmed = rawLine.trim();
    const line = trimmed === "\\[" || trimmed === "\\]" ? rawLine.replace(trimmed, () => "$$") : toDollarMath(rawLine);
    const item = parseListLine(line);
    if (!item) {
      // Anything that isn't a list line ends the run, same as the renderer.
      stack.length = 0;
      out.push(line);
      continue;
    }
    while (stack.length > 0 && stack[stack.length - 1] >= item.depth) stack.pop();
    const level = stack.length;
    stack.push(item.depth);
    out.push(`${"    ".repeat(level)}${item.ordered ? item.marker : "-"} ${item.text}`);
  }
  return out.join("\n");
}

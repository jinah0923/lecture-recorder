// Block-level line patterns shared by all three lecture-note renderers
// (lib/markdown.tsx, lib/pdfExport.ts, app/api/export-to-notion/route.ts),
// alongside lib/inlineMarkdown.ts for inline formatting.

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

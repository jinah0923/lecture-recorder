// LaTeX formulas inside lecture-note text — $\alpha$, \(...\) inline and
// $$...$$, \[...\] display — pulled out before **bold** / <mark> parsing
// (lib/inlineMarkdown.ts) and put back afterwards. Without this, a formula
// containing * would be mistaken for bold, and splitting the text at a
// formula would cut a surrounding <mark>…</mark> in half.

export type MathSpan = { tex: string; display: boolean };

// Private-use characters: never in real note text, and nothing the bold or
// highlight parser reacts to.
const START = "";
const END = "";
const PLACEHOLDER = /(\d+)/;

// $$...$$ | \[...\] | \(...\) | $...$
// The single-$ form follows pandoc's rule so prices don't turn into math:
// no space just inside either $, and the closing $ isn't followed by a digit
// ("$5와 $10" stays text). An escaped \$ is never a delimiter.
const MATH_PATTERN =
  /\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$])/g;

export function protectMath(text: string): { text: string; spans: MathSpan[] } {
  if (!text.includes("$") && !text.includes("\\")) return { text, spans: [] };
  const spans: MathSpan[] = [];
  const replaced = text.replace(MATH_PATTERN, (_match, dollars2, bracket, paren, dollar1) => {
    const display = dollars2 !== undefined || bracket !== undefined;
    spans.push({ tex: String(dollars2 ?? bracket ?? paren ?? dollar1).trim(), display });
    return `${START}${spans.length - 1}${END}`;
  });
  return { text: replaced, spans };
}

// Text with placeholders -> plain strings and formula indexes, in order.
export function splitMathPlaceholders(text: string): Array<string | number> {
  const pieces: Array<string | number> = [];
  let rest = text;
  let match = rest.match(PLACEHOLDER);
  while (match && match.index !== undefined) {
    if (match.index > 0) pieces.push(rest.slice(0, match.index));
    pieces.push(Number(match[1]));
    rest = rest.slice(match.index + match[0].length);
    match = rest.match(PLACEHOLDER);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// A whole line that is one display formula ("$$ ... $$" or "\[ ... \]").
export function matchDisplayMathLine(line: string): string | null {
  const match = line.trim().match(/^\$\$([\s\S]+)\$\$$|^\\\[([\s\S]+)\\\]$/);
  if (!match) return null;
  const tex = (match[1] ?? match[2]).trim();
  return tex && !tex.includes("$$") ? tex : null;
}

// Opening line of a multi-line display formula ("$$" or "\[" alone), and
// the closing line that ends it.
export function displayMathFenceClose(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "$$") return "$$";
  if (trimmed === "\\[") return "\\]";
  return null;
}

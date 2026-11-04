// LaTeX formulas inside lecture-note text — $\alpha$, \(...\) inline and
// $$...$$, \[...\] display — pulled out before **bold** / <mark> parsing
// (lib/inlineMarkdown.ts) and put back afterwards. Without this, a formula
// containing * would be mistaken for bold, and splitting the text at a
// formula would cut a surrounding <mark>…</mark> in half.

export type MathSpan = { tex: string; display: boolean };

// \Alpha, \Beta, … aren't LaTeX (the capitals that look like Latin letters
// have no macro) — the AI writes them for β-mercaptoethylamine and the like.
// KaTeX draws them as the Latin-looking capital ("B"), other renderers
// (Notion's) reject them, and the intended letter is the lowercase one. So
// they're rewritten to it, both as KaTeX macros (lib/katexRender.ts) and in
// the TeX text itself via normalizeTex, which every renderer and export
// goes through.
export const NONSTANDARD_GREEK_MACROS: Record<string, string> = {
  "\\Alpha": "\\alpha",
  "\\Beta": "\\beta",
  "\\Epsilon": "\\epsilon",
  "\\Zeta": "\\zeta",
  "\\Eta": "\\eta",
  "\\Iota": "\\iota",
  "\\Kappa": "\\kappa",
  "\\Mu": "\\mu",
  "\\Nu": "\\nu",
  "\\Omicron": "o",
  "\\Rho": "\\rho",
  "\\Tau": "\\tau",
  "\\Chi": "\\chi",
};
const NONSTANDARD_GREEK_PATTERN = /\\(Alpha|Beta|Epsilon|Zeta|Eta|Iota|Kappa|Mu|Nu|Omicron|Rho|Tau|Chi)(?![A-Za-z])/g;

export function normalizeTex(tex: string): string {
  return tex.replace(NONSTANDARD_GREEK_PATTERN, (macro) => NONSTANDARD_GREEK_MACROS[macro] ?? macro);
}

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
    spans.push({ tex: normalizeTex(String(dollars2 ?? bracket ?? paren ?? dollar1).trim()), display });
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

// A formula and the characters touching it — "(B₁₂)", "NAD⁺와", "(Co³⁺)" —
// as one unbreakable group. A KaTeX formula is its own inline box, so a
// narrow table cell could wrap between "(" and the formula and leave the
// parenthesis stranded on the line above. Pieces (splitMathPlaceholders
// output) come back as they were, or as an array for a group the
// renderer should keep together (white-space: nowrap). A "word" whose text
// is long is left breakable as usual — a nowrap run that long would just
// overflow the cell instead.
const MAX_GLUED_TEXT_CHARS = 16;

export function glueMathToNeighbors(pieces: Array<string | number>): Array<string | number | Array<string | number>> {
  const out: Array<string | number | Array<string | number>> = [];
  let word: Array<string | number> = [];
  const flushWord = () => {
    if (word.length === 0) return;
    const hasMath = word.some((token) => typeof token === "number");
    const textChars = word.reduce<number>((total, token) => total + (typeof token === "string" ? token.length : 0), 0);
    if (hasMath && word.length > 1 && textChars <= MAX_GLUED_TEXT_CHARS) out.push(word);
    else out.push(...word);
    word = [];
  };
  for (const piece of pieces) {
    if (typeof piece === "number") {
      word.push(piece);
      continue;
    }
    for (const token of piece.split(/(\s+)/)) {
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        flushWord();
        out.push(token);
      } else {
        word.push(token);
      }
    }
  }
  flushWord();
  return out;
}

// A whole line that is one display formula ("$$ ... $$" or "\[ ... \]").
export function matchDisplayMathLine(line: string): string | null {
  const match = line.trim().match(/^\$\$([\s\S]+)\$\$$|^\\\[([\s\S]+)\\\]$/);
  if (!match) return null;
  const tex = (match[1] ?? match[2]).trim();
  return tex && !tex.includes("$$") ? normalizeTex(tex) : null;
}

// Opening line of a multi-line display formula ("$$" or "\[" alone), and
// the closing line that ends it. (The lines in between are the formula —
// callers pass the joined body through normalizeTex.)
export function displayMathFenceClose(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "$$") return "$$";
  if (trimmed === "\\[") return "\\]";
  return null;
}

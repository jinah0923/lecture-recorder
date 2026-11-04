// One KaTeX call for every place a formula is drawn — the note on screen
// (lib/markdown.tsx) and the PDF export (lib/pdfExport.ts) — so both get the
// same safety net:
// - macros: the non-standard capital Greek macros the AI writes (\Beta for
//   β-mercaptoethylamine) map to the lowercase letter it meant
//   (NONSTANDARD_GREEK_MACROS). The TeX is normally already normalized by
//   lib/inlineMath.ts; this also covers any path that hands TeX here directly.
// - strict: false: KaTeX's LaTeX-compatibility warnings (unicode text in
//   math, …) are ignored rather than surfaced.
// - A formula KaTeX still can't parse doesn't become KaTeX's red error text:
//   its source is shown in a muted code style, so the note reads normally
//   and nothing is lost.

import katex from "katex";
// Registers \ce{...} / \pu{...} for chemical formulas (H2O, reaction arrows).
import "katex/contrib/mhchem";
import { NONSTANDARD_GREEK_MACROS } from "@/lib/inlineMath";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Inline styles, so it looks the same on screen and in the PDF capture.
const FALLBACK_STYLE =
  "font-family:Consolas,Menlo,monospace;font-size:0.9em;color:#64748b;background:rgba(148,163,184,0.15);" +
  "border-radius:4px;padding:0 4px;white-space:pre-wrap;";

export function renderKatexHtml(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      strict: false,
      // A fresh copy each time: KaTeX writes \gdef definitions into it.
      macros: { ...NONSTANDARD_GREEK_MACROS },
    });
  } catch {
    const source = display ? `$$${tex}$$` : `$${tex}$`;
    return `<span class="math-fallback" title="수식을 그릴 수 없어 원문으로 표시합니다" style="${FALLBACK_STYLE}">${escapeHtml(source)}</span>`;
  }
}

"use client";

import katex from "katex";
// Registers \ce{...} for chemical formulas, as on screen (lib/markdown.tsx).
import "katex/contrib/mhchem";
import { tokenizeInline } from "@/lib/inlineMarkdown";
import { displayMathFenceClose, matchDisplayMathLine, protectMath, splitMathPlaceholders } from "@/lib/inlineMath";
import type { MathSpan } from "@/lib/inlineMath";
import {
  buildListTree,
  isCodeFence,
  matchEquationLine,
  matchQuoteLine,
  parseListLine,
  readCodeFence,
  readMatchingRun,
} from "@/lib/noteBlocks";
import type { ListLine, ListNode } from "@/lib/noteBlocks";
import type { ChecklistItem, TranscriptSegment } from "@/lib/types";

// html2canvas cannot parse modern CSS color functions (e.g. Tailwind v4's
// oklch()-based palette), and — critically — html2pdf.js's own `.from()`
// convenience API clones the source element into an overlay it appends to
// the REAL `document.body` before capturing it (see html2pdf.js's internal
// `toContainer()`), so rendering inside an isolated iframe doesn't help:
// the clone still ends up back in the app's document, inheriting Tailwind's
// oklch-based Preflight reset (e.g. the universal `border-color` default)
// and crashing html2canvas's color parser.
//
// The fix: skip html2pdf.js's high-level API entirely. Build the printable
// content as a plain HTML string (hex/rgb only, no Tailwind classes) inside
// a freshly created iframe with its own blank document — one that never
// loads the app's stylesheet — and call html2canvas directly on the element
// while it's still inside that iframe. Pages are then sliced from the
// resulting canvas and assembled with jsPDF ourselves, which also lets us
// avoid slicing through a callout box or table (marked via
// data-avoid-break) instead of relying on html2pdf.js's pagebreak plugin.

type CalloutStyle = { emoji: string; bg: string; border: string; text: string; borderWidth?: string; bold?: boolean };

const PDF_CALLOUT_STYLES: CalloutStyle[] = [
  // Deliberately bolder than every other callout below (thicker border,
  // more saturated colors, bold text) — the AI's "confirmed exam question"
  // marker (see the [시험 출제 신호 감지] prompt rule in
  // app/api/transcribe-and-summarize/route.ts), meant to visually outrank
  // the plain 🔥 emphasis callout, not just duplicate it in another color.
  { emoji: "🚨", bg: "#fee2e2", border: "#f87171", text: "#7f1d1d", borderWidth: "2px", bold: true },
  { emoji: "🔥", bg: "#fef2f2", border: "#fecaca", text: "#991b1b" },
  { emoji: "💡", bg: "#fefce8", border: "#fef08a", text: "#854d0e" },
  { emoji: "▲", bg: "#ecfdf5", border: "#a7f3d0", text: "#065f46" },
  { emoji: "🗣️", bg: "#eff6ff", border: "#bfdbfe", text: "#1e40af" },
  { emoji: "💜", bg: "#f5f3ff", border: "#ddd6fe", text: "#5b21b6" },
];

const PDF_BACKGROUND = "#ffffff";
const PDF_TEXT_COLOR = "#111827";
const PDF_FONT_FAMILY = "'Apple SD Gothic Neo', 'Malgun Gothic', -apple-system, BlinkMacSystemFont, sans-serif";
const BODY_STYLE = "font-size:12.5px;color:#374151;line-height:1.6;";
const AVOID_BREAK_STYLE = "break-inside:avoid;page-break-inside:avoid;";
const AVOID_BREAK_ATTR = 'data-avoid-break="true"';
// A diagram or slide image: never sliced across pages (see AvoidRange).
const KEEP_WHOLE_ATTR = 'data-keep-whole="true"';
// A heading: a page never ends right after it (see measureAvoidRanges).
const KEEP_WITH_NEXT_ATTR = 'data-keep-with-next="true"';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripBlockquotePrefix(text: string): string {
  return text.replace(/^>\s*/, "");
}

function detectCallout(text: string): CalloutStyle | undefined {
  const trimmed = stripBlockquotePrefix(text.trim());
  return PDF_CALLOUT_STYLES.find((callout) => trimmed.startsWith(callout.emoji));
}

// Same yellow as the on-screen <mark> (lib/markdown.tsx), as a hex literal.
// The box-decoration-break pair is what a real browser needs for a wrapped
// highlight; html2canvas ignores it (see highlightHtml for what it needs).
const PDF_HIGHLIGHT_STYLE =
  "background:#fef08a;color:#111827;display:inline;-webkit-box-decoration-break:clone;box-decoration-break:clone;";
// A single word of a highlight: never wraps internally, and keep-all stops
// Korean from breaking between syllables inside it.
const PDF_HIGHLIGHT_WORD_STYLE = `${PDF_HIGHLIGHT_STYLE}white-space:nowrap;word-break:keep-all;`;

// html2canvas paints an inline element's background as ONE rectangle around
// all of its line boxes, so a <mark> that wraps onto a second line got a
// yellow band running from the start of the first line to the end of the
// last one, across the full width. Each word (and each gap between words)
// gets its own span instead: a span that can't wrap sits on one line, so its
// rectangle is exactly its text. Line breaks still happen at the gaps.
// KaTeX HTML for a formula — the same output as on screen. It only looks
// right with KaTeX's stylesheet and fonts, which exportSectionsToPdf copies
// into the capture frame (see copyKatexCss / loadKatexFonts).
function mathHtml(span: MathSpan): string {
  return katex.renderToString(span.tex, { displayMode: span.display, throwOnError: false, strict: "ignore" });
}

// Text that may contain formula placeholders (protectMath) -> HTML, with
// `plain` applied to the ordinary text between formulas.
function textWithMathHtml(text: string, spans: MathSpan[], plain: (value: string) => string): string {
  if (spans.length === 0) return plain(text);
  return splitMathPlaceholders(text)
    .map((piece) => (typeof piece === "number" ? mathHtml(spans[piece]) : plain(piece)))
    .join("");
}

function highlightHtml(parts: { text: string; bold: boolean }[], spans: MathSpan[] = []): string {
  const spanHtml = parts.flatMap((part) =>
    part.text
      .split(/(\s+)/)
      .filter((token) => token.length > 0)
      .map((token) => {
        const inner = textWithMathHtml(token, spans, escapeHtml);
        const content = part.bold ? `<strong>${inner}</strong>` : inner;
        const style = /^\s+$/.test(token) ? PDF_HIGHLIGHT_STYLE : PDF_HIGHLIGHT_WORD_STYLE;
        return `<span style="${style}">${content}</span>`;
      }),
  );
  return `<mark style="background:transparent;color:inherit;">${spanHtml.join("")}</mark>`;
}

// Invisible break points (zero-width spaces) inside unusually long unbroken
// runs — only used in table cells (renderTableHtml), where one such run would
// otherwise make its column too wide for the page. Ordinary words, Korean
// compounds included, are shorter than this and stay whole.
const LONG_RUN = /[^\s]{15,}/gu;
function softBreakLongRuns(text: string): string {
  return text.replace(LONG_RUN, (run) => (run.match(/.{1,10}/gu) ?? [run]).join("\u200B"));
}

// LaTeX is swapped for placeholders before the **bold** / <mark> pass and
// rendered back afterwards, exactly as on screen (lib/markdown.tsx).
function renderInlineHtml(text: string, options: { softBreakLongRuns?: boolean } = {}): string {
  const { text: protectedText, spans } = protectMath(text);
  const plain = (value: string) => escapeHtml(options.softBreakLongRuns ? softBreakLongRuns(value) : value);
  const withMath = (value: string) => textWithMathHtml(value, spans, plain);
  return tokenizeInline(protectedText)
    .map((group) =>
      group.highlight
        ? highlightHtml(group.parts, spans)
        : group.parts.map((part) => (part.bold ? `<strong>${withMath(part.text)}</strong>` : withMath(part.text))).join(""),
    )
    .join("");
}

// A plain "> " quote line — anything that isn't an emoji callout or a
// formula line (mirrors lib/markdown.tsx).
function matchPlainQuote(line: string): string | null {
  if (detectCallout(line) || matchEquationLine(line) !== null) return null;
  return matchQuoteLine(line);
}

// Formula block — same tinted, centered, bold panel as on screen
// (lib/markdown.tsx), with hex colors since html2canvas can't read oklch.
function renderEquationHtml(equations: string[]): string {
  const rows = equations
    .map(
      (equation) =>
        `<p style="margin:0;font-size:13.5px;font-weight:700;color:${PDF_TEXT_COLOR};text-align:center;line-height:1.6;word-break:keep-all;">${renderInlineHtml(equation)}</p>`,
    )
    .join("");
  return `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}margin:8px 0;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;background:#f1f5f9;display:flex;flex-direction:column;gap:4px;">${rows}</div>`;
}

function headingStyle(level: number): string {
  if (level === 1) return `font-size:16px;font-weight:700;color:${PDF_TEXT_COLOR};`;
  if (level === 2) return `font-size:14px;font-weight:700;color:${PDF_TEXT_COLOR};`;
  return "font-size:13px;font-weight:600;color:#374151;";
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") && !trimmed.includes("-")) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

// Matches lib/markdown.tsx's on-screen convention — see that file for why
// this exact syntax.
const SLIDE_IMAGE_PATTERN = /^!\[[^\]]*\]\(slide_(\d+)\)$/;

// Matches lib/markdown.tsx's generic (non-slide) image pattern — an external
// URL the AI cited for "AI 심화 탐구" (see app/api/expand-note/route.ts).
const IMAGE_PATTERN = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;

// Same look as the on-screen table (lib/markdown.tsx): thin grid lines, a
// light gray semibold header, px-4 py-2 cell padding, and keep-all so cells
// break between words instead of between Korean syllables. Unlike the screen
// there's no sideways scrolling on paper, so no overflow, no nowrap and no
// per-column minimum widths: the table is the page's full width and its
// columns share it. overflow-wrap: break-word (not "anywhere", which would
// let the browser size a column down to one character and wrap "자산" as
// "자/산") plus softBreakLongRuns keep an over-long word from pushing the
// table past the page edge. The rounded outer
// border comes from border-collapse: separate (rounded corners can't be
// clipped without overflow).
const PDF_TABLE_BORDER = "#e2e8f0";
const PDF_TABLE_RADIUS = "8px";

function renderTableHtml(headerCells: string[], bodyRows: string[][]): string {
  const columnCount = headerCells.length;
  const cellBase =
    `padding:8px 16px;vertical-align:top;line-height:1.6;word-break:keep-all;overflow-wrap:break-word;text-align:left;`;
  const rightBorder = (column: number) => (column < columnCount - 1 ? `border-right:1px solid ${PDF_TABLE_BORDER};` : "");
  const theadHtml = `<thead><tr>${headerCells
    .map((cell, column) => {
      const corner =
        (column === 0 ? `border-top-left-radius:${PDF_TABLE_RADIUS};` : "") +
        (column === columnCount - 1 ? `border-top-right-radius:${PDF_TABLE_RADIUS};` : "");
      return `<th style="${cellBase}${rightBorder(column)}${corner}background:#f4f4f5;font-weight:600;color:#27272a;">${renderInlineHtml(cell, { softBreakLongRuns: true })}</th>`;
    })
    .join("")}</tr></thead>`;
  const tbodyHtml = `<tbody>${bodyRows
    .map(
      (row) =>
        `<tr>${headerCells
          .map(
            (_header, column) =>
              `<td style="${cellBase}${rightBorder(column)}border-top:1px solid ${PDF_TABLE_BORDER};color:#3f3f46;">${renderInlineHtml(row[column] ?? "", { softBreakLongRuns: true })}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("")}</tbody>`;
  return (
    `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}margin:12px 0;">` +
    `<table style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid ${PDF_TABLE_BORDER};border-radius:${PDF_TABLE_RADIUS};font-size:12px;">` +
    `${theadHtml}${tbodyHtml}</table></div>`
  );
}

// Bullet style per nesting level, like a browser's default nested lists.
const BULLET_STYLES = ["disc", "circle", "square"];

// Nested lists, mirroring lib/markdown.tsx's renderListNodes: one <ul>/<ol>
// per nesting level, split into separate lists wherever bullets switch to
// numbers or back, and a callout or formula item rendered as its own box
// with its sub-items still nested below it.
function renderListHtml(nodes: ListNode[], depth: number): string {
  let html = "";
  let start = 0;
  while (start < nodes.length) {
    const ordered = nodes[start].ordered;
    let end = start;
    while (end < nodes.length && nodes[end].ordered === ordered) end++;
    const itemsHtml = nodes
      .slice(start, end)
      .map((node) => {
        const nested = node.children.length > 0 ? renderListHtml(node.children, depth + 1) : "";
        const equation = matchEquationLine(node.text);
        if (equation !== null) {
          return `<li style="list-style:none;margin-left:-18px;">${renderEquationHtml([equation])}${nested}</li>`;
        }
        const callout = detectCallout(node.text);
        if (callout) {
          return (
            `<li style="list-style:none;margin-left:-18px;">` +
            `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}border:${callout.borderWidth ?? "1px"} solid ${callout.border};border-radius:8px;padding:8px 12px;margin:4px 0;font-size:12.5px;background:${callout.bg};color:${callout.text};${callout.bold ? "font-weight:600;" : ""}">${renderInlineHtml(stripBlockquotePrefix(node.text))}</div>` +
            `${nested}</li>`
          );
        }
        return `<li style="${BODY_STYLE}">${renderInlineHtml(node.text)}${nested}</li>`;
      })
      .join("");
    const tag = ordered ? "ol" : "ul";
    // Keeps the source numbering when a numbered list doesn't start at 1.
    const firstNumber = ordered ? parseInt(nodes[start].marker, 10) : 1;
    const startAttr = ordered && firstNumber > 1 ? ` start="${firstNumber}"` : "";
    const listStyle = ordered ? "decimal" : BULLET_STYLES[depth % BULLET_STYLES.length];
    html +=
      `<${tag}${startAttr} style="margin:${depth === 0 ? "6px 0" : "4px 0 0"};padding-left:18px;list-style-type:${listStyle};display:flex;flex-direction:column;gap:4px;">` +
      `${itemsHtml}</${tag}>`;
    start = end;
  }
  return html;
}

export function renderMarkdownToHtml(markdown: string, slideImages?: Map<number, string>): string {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let listBuffer: ListLine[] = [];
  let index = 0;

  function flushList() {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    blocks.push(renderListHtml(buildListTree(items), 0));
  }

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      flushList();
      index++;
      continue;
    }

    // <details>/<summary>...</summary>...</details> — see lib/markdown.tsx
    // for the on-screen version this mirrors. A static PDF page can't
    // collapse anything, so this renders as an always-visible, clearly
    // labeled sub-box instead of an interactive toggle — the content still
    // needs to actually appear in the export, just visually set apart.
    if (line === "<details>") {
      flushList();
      let cursor = index + 1;
      let summaryText = "부가 정보";
      const summaryMatch = cursor < lines.length ? lines[cursor].trim().match(/^<summary>(.*)<\/summary>$/) : null;
      if (summaryMatch) {
        summaryText = summaryMatch[1].trim() || summaryText;
        cursor++;
      }
      const innerLines: string[] = [];
      while (cursor < lines.length && lines[cursor].trim() !== "</details>") {
        innerLines.push(lines[cursor]);
        cursor++;
      }
      const innerHtml = renderMarkdownToHtml(innerLines.join("\n").trim(), slideImages);
      blocks.push(
        `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}margin:6px 0;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;">` +
          `<p style="margin:0;padding:8px 12px;font-size:12px;font-weight:700;color:#6b7280;border-bottom:1px solid #e5e7eb;">📎 ${escapeHtml(summaryText)}</p>` +
          `<div style="padding:8px 12px;">${innerHtml}</div>` +
          `</div>`,
      );
      index = cursor + 1;
      continue;
    }

    if (line.startsWith("|") && index + 1 < lines.length && isTableSeparatorRow(lines[index + 1])) {
      flushList();
      const headerCells = splitTableRow(line);
      const bodyRows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
        bodyRows.push(splitTableRow(lines[cursor]));
        cursor++;
      }
      blocks.push(renderTableHtml(headerCells, bodyRows));
      index = cursor;
      continue;
    }

    // Depth comes from the raw line's indentation (see parseListLine), so
    // sub-bullets nest instead of flattening; numbered items become an <ol>.
    const listLine = parseListLine(rawLine);
    if (listLine) {
      listBuffer.push(listLine);
      index++;
      continue;
    }
    flushList();

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(
        `<p ${KEEP_WITH_NEXT_ATTR} style="${headingStyle(level)}margin:${index === 0 ? "0 0 4px" : "12px 0 4px"};">${renderInlineHtml(headingMatch[2])}</p>`,
      );
      index++;
      continue;
    }

    const slideMatch = line.match(SLIDE_IMAGE_PATTERN);
    if (slideMatch) {
      const page = Number(slideMatch[1]);
      const dataUrl = slideImages?.get(page);
      if (dataUrl) {
        blocks.push(
          `<div ${AVOID_BREAK_ATTR} ${KEEP_WHOLE_ATTR} style="${AVOID_BREAK_STYLE}margin:6px 0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;"><img src="${dataUrl}" alt="슬라이드 ${page}" style="display:block;width:100%;" /><p style="margin:0;padding:6px 10px;font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb;">🖼️ 슬라이드 ${page}</p></div>`,
        );
      } else {
        blocks.push(
          `<p style="${BODY_STYLE}margin:4px 0;color:#9ca3af;">🖼️ 슬라이드 ${page} 이미지를 불러올 수 없습니다.</p>`,
        );
      }
      index++;
      continue;
    }

    const imageMatch = line.match(IMAGE_PATTERN);
    if (imageMatch) {
      const [, alt, url] = imageMatch;
      blocks.push(
        `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}margin:6px 0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" crossorigin="anonymous" style="display:block;width:100%;" />${alt ? `<p style="margin:0;padding:6px 10px;font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb;">🖼️ ${escapeHtml(alt)}</p>` : ""}</div>`,
      );
      index++;
      continue;
    }

    if (isCodeFence(line)) {
      flushList();
      const { code, next, language } = readCodeFence(lines, index);
      // A diagram: replaced by its rendered image in exportSectionsToPdf
      // (see renderMermaidDiagrams); the source stays as the fallback.
      if (language === "mermaid") {
        blocks.push(
          `<div ${AVOID_BREAK_ATTR} ${KEEP_WHOLE_ATTR} data-mermaid="${escapeHtml(encodeURIComponent(code))}" style="${AVOID_BREAK_STYLE}margin:10px 0;text-align:center;"><pre style="margin:0;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-family:Consolas,Menlo,monospace;font-size:11px;color:#374151;white-space:pre-wrap;text-align:left;">${escapeHtml(code)}</pre></div>`,
        );
        index = next;
        continue;
      }
      blocks.push(
        `<pre ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}margin:8px 0;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;background:#f1f5f9;font-family:Consolas,Menlo,monospace;font-size:12px;font-weight:600;color:#1f2937;white-space:pre-wrap;word-break:break-word;">${escapeHtml(code)}</pre>`,
      );
      index = next;
      continue;
    }

    // Display formula: a line that is one whole "$$...$$" / "\[...\]", or a
    // "$$" / "\[" line opening a multi-line one (mirrors lib/markdown.tsx).
    const displayTex = matchDisplayMathLine(line);
    const displayFenceClose = displayTex === null ? displayMathFenceClose(line) : null;
    if (displayTex !== null || displayFenceClose !== null) {
      flushList();
      let tex = displayTex ?? "";
      let next = index + 1;
      if (displayFenceClose !== null) {
        const body: string[] = [];
        while (next < lines.length && lines[next].trim() !== displayFenceClose) body.push(lines[next++]);
        tex = body.join("\n").trim();
        next = Math.min(next + 1, lines.length);
      }
      if (tex) {
        blocks.push(`<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}margin:4px 0;color:${PDF_TEXT_COLOR};">${mathHtml({ tex, display: true })}</div>`);
      }
      index = next;
      continue;
    }

    if (matchEquationLine(line) !== null) {
      const { items, next } = readMatchingRun(lines, index, matchEquationLine);
      blocks.push(renderEquationHtml(items));
      index = next;
      continue;
    }

    const callout = detectCallout(line);
    if (callout) {
      // Greedily consume immediately-following plain lines into the same
      // callout box — mirrors lib/markdown.tsx's on-screen behavior.
      const groupLines = [stripBlockquotePrefix(line)];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const nextLine = lines[cursor].trim();
        if (!nextLine) break;
        if (parseListLine(nextLine)) break;
        if (/^#{1,4}\s+/.test(nextLine)) break;
        if (nextLine.startsWith("|")) break;
        if (SLIDE_IMAGE_PATTERN.test(nextLine) || IMAGE_PATTERN.test(nextLine)) break;
        if (detectCallout(nextLine)) break;
        if (matchEquationLine(nextLine) !== null || isCodeFence(nextLine)) break;
        groupLines.push(stripBlockquotePrefix(nextLine));
        cursor++;
      }
      const groupHtml = groupLines.map((groupLine) => `<p style="margin:0;">${renderInlineHtml(groupLine)}</p>`).join("");
      blocks.push(
        `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}border:${callout.borderWidth ?? "1px"} solid ${callout.border};border-radius:8px;padding:8px 12px;margin:6px 0;display:flex;flex-direction:column;gap:4px;font-size:12.5px;background:${callout.bg};color:${callout.text};${callout.bold ? "font-weight:600;" : ""}">${groupHtml}</div>`,
      );
      index = cursor;
      continue;
    }

    if (matchPlainQuote(line) !== null) {
      const { items, next } = readMatchingRun(lines, index, matchPlainQuote);
      const quoteHtml = items.map((item) => `<p style="margin:0;">${renderInlineHtml(item)}</p>`).join("");
      blocks.push(
        `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}${BODY_STYLE}margin:6px 0;padding:8px 14px;border-left:4px solid #cbd5e1;border-radius:0 8px 8px 0;background:#f8fafc;display:flex;flex-direction:column;gap:4px;">${quoteHtml}</div>`,
      );
      index = next;
      continue;
    }

    blocks.push(`<p style="${BODY_STYLE}margin:4px 0;">${renderInlineHtml(line)}</p>`);
    index++;
  }

  flushList();
  return `<div style="display:flex;flex-direction:column;">${blocks.join("")}</div>`;
}

function formatPdfTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderTranscriptToHtml(transcript: TranscriptSegment[]): string {
  if (transcript.length === 0) {
    return `<p style="${BODY_STYLE}margin:4px 0;color:#9ca3af;">변환된 스크립트가 없습니다.</p>`;
  }
  const rows = transcript
    .map(
      (segment) =>
        `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}display:flex;gap:10px;margin:4px 0;">` +
        `<span style="flex-shrink:0;width:40px;font-family:monospace;font-size:11px;color:#9ca3af;">${formatPdfTimestamp(segment.startMs)}</span>` +
        `<p style="${BODY_STYLE}margin:0;flex:1;">${renderInlineHtml(segment.text)}</p>` +
        `</div>`,
    )
    .join("");
  return `<div style="display:flex;flex-direction:column;">${rows}</div>`;
}

function renderChecklistToHtml(checklist: ChecklistItem[]): string {
  if (checklist.length === 0) {
    return `<p style="${BODY_STYLE}margin:4px 0;color:#9ca3af;">생성된 체크리스트가 없습니다.</p>`;
  }
  const rows = checklist
    .map((item) => {
      const boxColor = item.done ? "#10b981" : "#9ca3af";
      const textStyle = item.done ? "color:#9ca3af;text-decoration:line-through;" : "color:#374151;";
      return (
        `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}display:flex;gap:8px;margin:4px 0;align-items:flex-start;">` +
        `<span style="flex-shrink:0;font-size:14px;line-height:1.6;color:${boxColor};">${item.done ? "☑" : "☐"}</span>` +
        `<p style="font-size:12.5px;line-height:1.6;margin:0;${textStyle}">${renderInlineHtml(item.text)}</p>` +
        `</div>`
      );
    })
    .join("");
  return `<div style="display:flex;flex-direction:column;">${rows}</div>`;
}

function sanitizeFileNamePart(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, "").trim() || "제목 없는 강의";
}

function buildPdfFileName(recordingTitle: string, date: Date): string {
  const dateLabel = date.toISOString().slice(0, 10);
  return `[강의노트] ${sanitizeFileNamePart(recordingTitle)}_${dateLabel}.pdf`;
}

const CONTENT_WIDTH_PX = 760;
const CAPTURE_SCALE = 2;
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const MARGIN_MM = 15;
const USABLE_WIDTH_MM = PAGE_WIDTH_MM - MARGIN_MM * 2;
const USABLE_HEIGHT_MM = PAGE_HEIGHT_MM - MARGIN_MM * 2;

// keepWhole: a diagram or slide image — moved to the next page as a unit
// even when that leaves more blank space than the usual limit, because a
// picture sliced across two pages is unreadable (see KEEP_WHOLE_ATTR).
export type AvoidRange = { top: number; bottom: number; keepWhole?: boolean };

// The PDF is one tall canvas cut into pages, so "page-break-inside: avoid"
// has to be done here: a page ends just above any block it would otherwise
// slice through. Only blocks up to this fraction of a page are kept whole —
// a long table or callout is cut between its rows/lines instead of being
// pushed whole to the next page, which is what used to leave pages mostly
// blank. That also bounds the empty space at the bottom of any page.
const MAX_UNBROKEN_FRACTION = 0.3;
// Pictures up to this share of a page are never cut; taller ones must be.
const MAX_KEEP_WHOLE_FRACTION = 0.9;

// Where each page ends. No forced breaks: selected sections simply follow
// one another, separated by a divider (see exportSectionsToPdf).
export function computePageSlices(canvasHeightPx: number, usableHeightPx: number, avoidRanges: AvoidRange[]) {
  const maxUnbroken = usableHeightPx * MAX_UNBROKEN_FRACTION;
  const ranges = avoidRanges.filter((range) => range.bottom - range.top <= maxUnbroken);
  const wholeRanges = avoidRanges.filter(
    (range) => range.keepWhole && range.bottom - range.top <= usableHeightPx * MAX_KEEP_WHOLE_FRACTION,
  );
  const slices: Array<{ sy: number; sh: number }> = [];
  let y = 0;
  while (y < canvasHeightPx - 0.5) {
    let end = Math.min(y + usableHeightPx, canvasHeightPx);
    if (end < canvasHeightPx) {
      // Never pulled up past this, so a page is always at least
      // (1 - MAX_UNBROKEN_FRACTION) full.
      const minEnd = y + usableHeightPx * (1 - MAX_UNBROKEN_FRACTION);
      // Repeat until stable: moving the end up can land it inside another
      // (enclosing) block, which then needs the same treatment.
      let moved = true;
      while (moved) {
        moved = false;
        for (const range of ranges) {
          if (range.top >= minEnd && range.top < end && range.bottom > end) {
            end = range.top;
            moved = true;
          }
        }
        for (const range of wholeRanges) {
          if (range.top > y + 1 && range.top < end && range.bottom > end) {
            end = range.top;
            moved = true;
          }
        }
      }
    }
    slices.push({ sy: y, sh: end - y });
    y = end;
  }
  return slices;
}

// The smallest units a page break must not run through — a line of text
// sliced in half is unreadable — plus the marked boxes (callouts, tables,
// formulas, quotes, images), which computePageSlices keeps whole only when
// they're short.
const MIN_BLOCK_SELECTOR = "p, li, tr, img, pre, [data-avoid-break]";
// How much of what follows a heading has to stay on its page with it.
const KEEP_WITH_NEXT_PX = 60;

function measureAvoidRanges(root: HTMLElement, scale: number): AvoidRange[] {
  const rootTop = root.getBoundingClientRect().top;
  const toRange = (el: Element): AvoidRange => {
    const rect = el.getBoundingClientRect();
    return { top: (rect.top - rootTop) * scale, bottom: (rect.bottom - rootTop) * scale };
  };
  const ranges = Array.from(root.querySelectorAll(MIN_BLOCK_SELECTOR)).map(toRange);
  for (const picture of Array.from(root.querySelectorAll("[data-keep-whole]"))) {
    ranges.push({ ...toRange(picture), keepWhole: true });
  }
  for (const heading of Array.from(root.querySelectorAll("[data-keep-with-next]"))) {
    const next = heading.nextElementSibling;
    if (!next) continue;
    const own = toRange(heading);
    ranges.push({ top: own.top, bottom: Math.min(toRange(next).bottom, own.bottom + KEEP_WITH_NEXT_PX * scale) });
  }
  return ranges;
}

// The capture frame is a blank document on purpose (no Tailwind — its
// oklch() colors crash html2canvas), so KaTeX's stylesheet has to be brought
// in explicitly or formulas collapse into overlapping glyphs. These are the
// KaTeX rules (styles and @font-face) the app already loaded via
// katex.min.css in app/layout.tsx, copied from the page's own stylesheets;
// nothing else of the app's CSS comes along.
function copyKatexCss(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let sheetRules: CSSRuleList;
    try {
      sheetRules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet
    }
    for (const rule of Array.from(sheetRules)) {
      const text = rule.cssText;
      if (text.includes("katex") || text.includes("KaTeX")) rules.push(text);
    }
  }
  return rules.join("\n");
}

// Every KaTeX font, loaded before capture. Needed in both documents:
// html2canvas lays text out in the capture frame but draws it on a canvas
// that belongs to the app's own document, and an unloaded font silently
// falls back (wrong glyph widths, overlapping symbols).
// ---- Formulas as images -----------------------------------------------------
// html2canvas draws text with its own renderer, which gets KaTeX's stacked
// layout wrong — fraction bars land on the numerator and subscripts on the
// baseline — even with the right stylesheet and fonts. So each formula is
// drawn by the browser itself instead: serialized into an SVG
// <foreignObject> with the KaTeX CSS and the fonts it uses inlined, rendered
// to a PNG, and swapped in for the formula in the capture frame, where
// html2canvas just copies the image. A browser that won't draw a
// foreignObject into a readable canvas (some Safari versions) keeps the
// html2canvas rendering instead of failing the export.

const FORMULA_IMAGE_PAD_PX = 3;
const fontDataUrlCache = new Map<string, Promise<string | null>>();

function fetchAsDataUrl(url: string): Promise<string | null> {
  let cached = fontDataUrlCache.get(url);
  if (!cached) {
    cached = fetch(url)
      .then((response) => (response.ok ? response.blob() : null))
      .then(
        (blob) =>
          blob &&
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      )
      .catch(() => null);
    fontDataUrlCache.set(url, cached);
  }
  return cached;
}

// The page's KaTeX rules, split into ordinary style rules and @font-face rules.
function katexCssRules(): { styleRules: string[]; fontFaces: CSSFontFaceRule[] } {
  const styleRules: string[] = [];
  const fontFaces: CSSFontFaceRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let sheetRules: CSSRuleList;
    try {
      sheetRules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(sheetRules)) {
      if (rule instanceof CSSFontFaceRule) {
        if (rule.style.getPropertyValue("font-family").includes("KaTeX")) fontFaces.push(rule);
      } else if (rule.cssText.includes("katex")) {
        styleRules.push(rule.cssText);
      }
    }
  }
  return { styleRules, fontFaces };
}

// @font-face rules for just these families, each with its woff2 inlined —
// an SVG drawn as an image can't fetch anything itself.
async function inlinedFontFaceCss(fontFaces: CSSFontFaceRule[], families: Set<string>): Promise<string> {
  const rules = await Promise.all(
    fontFaces.map(async (rule) => {
      const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      if (!families.has(family)) return "";
      const woff2 = rule.style.getPropertyValue("src").match(/url\(["']?([^"')]+\.woff2)["']?\)/);
      if (!woff2) return "";
      const dataUrl = await fetchAsDataUrl(new URL(woff2[1], window.location.href).href);
      if (!dataUrl) return "";
      const style = rule.style.getPropertyValue("font-style") || "normal";
      const weight = rule.style.getPropertyValue("font-weight") || "normal";
      return `@font-face{font-family:${family};font-style:${style};font-weight:${weight};src:url(${dataUrl}) format("woff2");}`;
    }),
  );
  return rules.join("");
}

// html2canvas doesn't place text where the browser does: it draws each run
// at (top of its box + a baseline it measured itself), and that measurement
// (FontMetrics.parseMetrics in html2canvas 1.4) puts a 1x1 image on the
// baseline in the app's own document and adds a fixed +2px — where the app's
// CSS (img { display: block } from Tailwind's reset) shifts it further. So
// its text lands a few px below the true baseline. Formula images are placed
// on the TRUE baseline, so they're lowered by the same amount to line up with
// the text as html2canvas actually draws it. This repeats html2canvas's
// measurement exactly, in the same document it uses.
const html2canvasBaselineCache = new Map<string, number>();
function html2canvasBaseline(fontFamily: string, fontSize: string): number {
  const key = `${fontFamily}|${fontSize}`;
  const cached = html2canvasBaselineCache.get(key);
  if (cached !== undefined) return cached;
  const container = document.createElement("div");
  const img = document.createElement("img");
  const span = document.createElement("span");
  container.style.visibility = "hidden";
  container.style.fontFamily = fontFamily;
  container.style.fontSize = fontSize;
  container.style.margin = "0";
  container.style.padding = "0";
  container.style.whiteSpace = "nowrap";
  document.body.appendChild(container);
  img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  img.width = 1;
  img.height = 1;
  img.style.margin = "0";
  img.style.padding = "0";
  img.style.verticalAlign = "baseline";
  span.style.fontFamily = fontFamily;
  span.style.fontSize = fontSize;
  span.style.margin = "0";
  span.style.padding = "0";
  span.appendChild(document.createTextNode("Hidden Text"));
  container.appendChild(span);
  container.appendChild(img);
  const baseline = img.offsetTop - span.offsetTop + 2;
  document.body.removeChild(container);
  html2canvasBaselineCache.set(key, baseline);
  return baseline;
}

// How far below the true baseline html2canvas will draw `parent`'s text.
function html2canvasTextDrop(frameDoc: Document, parent: HTMLElement, before: Node): number {
  const style = frameDoc.defaultView?.getComputedStyle(parent);
  if (!style) return 0;
  const sample = frameDoc.createElement("span");
  sample.textContent = "Hidden Text";
  const probe = frameDoc.createElement("span");
  probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;";
  parent.insertBefore(sample, before);
  parent.insertBefore(probe, before);
  const trueBaseline = probe.getBoundingClientRect().top - sample.getBoundingClientRect().top;
  sample.remove();
  probe.remove();
  return html2canvasBaseline(style.fontFamily, style.fontSize) - trueBaseline;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("formula image failed to load"));
    image.src = src;
  });
}

// Returns false when this browser can't do it (the caller then leaves the
// remaining formulas to html2canvas).
async function replaceFormulasWithImages(frameDoc: Document, root: HTMLElement, scale: number): Promise<boolean> {
  const frameWindow = frameDoc.defaultView;
  if (!frameWindow) return false;
  const formulas = Array.from(root.querySelectorAll<HTMLElement>(".katex")).filter(
    (el) => !el.parentElement?.closest(".katex"),
  );
  if (formulas.length === 0) return true;
  const { styleRules, fontFaces } = katexCssRules();
  const styleCss = styleRules.join("");
  const serializer = new XMLSerializer();

  for (const formula of formulas) {
    const parent = formula.parentElement;
    if (!parent) continue;
    const isDisplay = parent.classList.contains("katex-display");
    const families = new Set(
      [formula, ...Array.from(formula.querySelectorAll("*"))]
        .map((el) => frameWindow.getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim())
        .filter((family) => family.startsWith("KaTeX")),
    );
    const fontCss = await inlinedFontFaceCss(fontFaces, families);
    const parentStyle = frameWindow.getComputedStyle(parent);
    const pad = FORMULA_IMAGE_PAD_PX;
    // The image's content: the formula in a shrink-to-fit box. Laid out once
    // for real in the frame (same engine as the SVG render) to read its size
    // and where its baseline falls, so the image can be placed exactly —
    // guessing from the formula's own box gets inline formulas wrong (line
    // height, and fractions taller than the text line).
    const wrapperStyle =
      `display:inline-block;padding:${pad}px;font-size:${parentStyle.fontSize};color:${parentStyle.color};` +
      `line-height:${parentStyle.lineHeight};white-space:nowrap;`;
    const replica = frameDoc.createElement("div");
    replica.style.cssText = `position:absolute;left:-10000px;top:0;${wrapperStyle}`;
    const baselineProbe = frameDoc.createElement("span");
    baselineProbe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;";
    replica.append(baselineProbe, formula.cloneNode(true));
    frameDoc.body.appendChild(replica);
    const box = replica.getBoundingClientRect();
    const baselineFromTop = baselineProbe.getBoundingClientRect().top - box.top;
    const width = Math.ceil(box.width);
    const height = Math.ceil(box.height);
    replica.remove();

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="${wrapperStyle}">` +
      `<style><![CDATA[${fontCss}${styleCss}]]></style>` +
      `<span style="display:inline-block;width:0;height:0;vertical-align:baseline;"></span>${serializer.serializeToString(formula)}</div>` +
      `</foreignObject></svg>`;

    let png: string;
    try {
      const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const context = canvas.getContext("2d");
      if (!context) return false;
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, width, height);
      png = canvas.toDataURL("image/png"); // throws if the browser tainted the canvas
    } catch (error) {
      console.warn("[pdfExport] drawing formulas natively isn't available here; using html2canvas for them", error);
      return false;
    }

    const replacement = frameDoc.createElement("img");
    replacement.src = png;
    replacement.alt = formula.textContent ?? "";
    // Inline: the image's own baseline (baselineFromTop) sits on the text
    // baseline. Display: centered by .katex-display's text-align.
    replacement.style.cssText = isDisplay
      ? `display:inline-block;width:${width}px;height:${height}px;vertical-align:middle;`
      : `display:inline-block;width:${width}px;height:${height}px;vertical-align:${(baselineFromTop - height - html2canvasTextDrop(frameDoc, parent, formula)).toFixed(2)}px;margin:0 -${pad}px;`;
    formula.replaceWith(replacement);
  }
  return true;
}

// ```mermaid diagrams -> images. mermaid draws them as SVG (labels as plain
// SVG text, so the SVG can be rasterized everywhere), which is turned into a
// PNG at the capture scale and dropped in place of the source placeholder.
// A diagram that fails to render keeps showing its source.
async function renderMermaidDiagrams(root: HTMLElement, scale: number): Promise<void> {
  const placeholders = Array.from(root.querySelectorAll<HTMLElement>("[data-mermaid]"));
  if (placeholders.length === 0) return;
  const { renderMermaidSvg } = await import("@/lib/mermaidRender");
  const maxWidth = CONTENT_WIDTH_PX - 20;
  for (const placeholder of placeholders) {
    try {
      const code = decodeURIComponent(placeholder.dataset.mermaid ?? "");
      const svgText = await renderMermaidSvg(code, { dark: false, htmlLabels: false });
      if (!svgText) continue;
      // mermaid's SVG is width="100%" with a viewBox; give it a real size so
      // it can be drawn as an image.
      const svgDoc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const svg = svgDoc.documentElement;
      const viewBox = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
      if (viewBox.length !== 4 || !(viewBox[2] > 0) || !(viewBox[3] > 0)) continue;
      const width = Math.min(viewBox[2], maxWidth);
      const height = (viewBox[3] * width) / viewBox[2];
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      svg.removeAttribute("style");
      const image = await loadImage(
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`,
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, width, height);
      const png = canvas.toDataURL("image/png");
      placeholder.innerHTML = `<img src="${png}" alt="다이어그램" style="display:inline-block;width:${width}px;height:${height}px;" />`;
    } catch (error) {
      console.warn("[pdfExport] diagram could not be rendered; keeping its source", error);
    }
  }
}

async function loadKatexFonts(docs: Document[]): Promise<void> {
  await Promise.all(
    docs.flatMap((doc) =>
      Array.from(doc.fonts)
        .filter((face) => face.family.includes("KaTeX"))
        .map((face) => face.load().catch(() => undefined)),
    ),
  );
  await Promise.all(docs.map((doc) => doc.fonts.ready));
}

export type PdfSectionId = "summary" | "lectureNote" | "transcript" | "checklist";

const SECTION_TITLES: Record<PdfSectionId, string> = {
  summary: "AI 요약본",
  lectureNote: "상세 강의노트",
  transcript: "변환된 스크립트",
  checklist: "체크리스트",
};

export type PdfExportData = {
  title: string;
  summary: string;
  lectureNote: string;
  transcript: TranscriptSegment[];
  checklist: ChecklistItem[];
  slideImages?: Map<number, string>;
};

function renderSectionBodyHtml(sectionId: PdfSectionId, data: PdfExportData): string {
  switch (sectionId) {
    case "summary":
      return renderMarkdownToHtml(data.summary?.trim() ? data.summary : "요약 내용이 없습니다.");
    case "lectureNote":
      return renderMarkdownToHtml(
        data.lectureNote?.trim() ? data.lectureNote : "상세 강의노트가 없습니다.",
        data.slideImages,
      );
    case "transcript":
      return renderTranscriptToHtml(data.transcript);
    case "checklist":
      return renderChecklistToHtml(data.checklist);
  }
}

// Renders whichever sections the user picked (PdfExportModal), each from its
// full, untouched source — same data-preservation principle as copy/.txt/.md
// download and Notion export. Sections run on continuously (no page break
// between them), each after the first set off by a divider and spacing.
// Next.js's webpack build splits html2canvas/jspdf into separate chunks
// fetched on demand (see the dynamic import below, which also keeps them
// out of the server bundle). That fetch can fail — a stale service worker
// or a deployed build hash the browser's cache doesn't know about yet —
// surfacing as a `ChunkLoadError` rather than anything about PDF export
// itself, so it needs its own detection and message.
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "ChunkLoadError" ||
    /loading chunk .+ failed/i.test(error.message) ||
    /failed to fetch dynamically imported module/i.test(error.message)
  );
}

export async function exportSectionsToPdf(sections: PdfSectionId[], data: PdfExportData): Promise<void> {
  if (sections.length === 0) return;

  let html2canvas: typeof import("html2canvas").default;
  let jsPDF: typeof import("jspdf").jsPDF;
  try {
    const [html2canvasModule, jsPdfModule] = await Promise.all([import("html2canvas"), import("jspdf")]);
    html2canvas = html2canvasModule.default;
    jsPDF = jsPdfModule.jsPDF;
  } catch (error) {
    if (isChunkLoadError(error)) {
      window.alert("브라우저 캐시 문제로 PDF 모듈을 불러오지 못했습니다. 페이지가 새로고침됩니다.");
      window.location.reload();
      return;
    }
    throw error;
  }

  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.top = "0";
  iframe.style.left = "-10000px";
  iframe.style.width = `${CONTENT_WIDTH_PX}px`;
  iframe.style.height = "1200px";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);

  try {
    const frameDoc = iframe.contentDocument;
    if (!frameDoc) throw new Error("PDF 렌더링용 프레임을 생성하지 못했습니다.");

    // A blank document written from scratch — never loads the app's
    // Tailwind stylesheet, so no oklch() value can ever reach html2canvas.
    // <base> so the copied @font-face url()s (root-relative /_next/static/...)
    // resolve against the app's origin.
    frameDoc.open();
    frameDoc.write(
      `<!DOCTYPE html><html><head><meta charset="utf-8" /><base href="${window.location.origin}/" /></head><body></body></html>`,
    );
    frameDoc.close();

    const safeTitle = escapeHtml(data.title || "제목 없는 강의");

    const sectionsHtml = sections
      .map((sectionId, index) => {
        const divider = index === 0 ? "" : '<hr style="border:0;border-top:2px solid #d1d5db;margin:28px 0 20px;" />';
        const heading = `<p ${KEEP_WITH_NEXT_ATTR} style="font-size:16px;font-weight:700;color:${PDF_TEXT_COLOR};margin:0 0 10px;">${escapeHtml(SECTION_TITLES[sectionId])}</p>`;
        const body = renderSectionBodyHtml(sectionId, data);
        return `${divider}<div>${heading}${body}</div>`;
      })
      .join("");

    frameDoc.body.style.margin = "0";
    frameDoc.body.style.backgroundColor = PDF_BACKGROUND;
    frameDoc.body.innerHTML = `<div id="pdf-export-root" style="width:${CONTENT_WIDTH_PX}px;box-sizing:border-box;background:${PDF_BACKGROUND};color:${PDF_TEXT_COLOR};font-family:${PDF_FONT_FAMILY};">
      <p style="font-size:18px;font-weight:700;color:${PDF_TEXT_COLOR};margin:0 0 14px;">${safeTitle}</p>
      ${sectionsHtml}
    </div>`;

    const printRoot = frameDoc.getElementById("pdf-export-root");
    if (!printRoot) throw new Error("PDF 렌더링용 컨테이너를 찾지 못했습니다.");

    await renderMermaidDiagrams(printRoot, CAPTURE_SCALE);

    const hasMath = !!printRoot.querySelector(".katex");
    if (hasMath) {
      const style = frameDoc.createElement("style");
      style.textContent = copyKatexCss();
      frameDoc.head.appendChild(style);
      await loadKatexFonts([frameDoc, document]);
      await replaceFormulasWithImages(frameDoc, printRoot, CAPTURE_SCALE);
    }

    // Slide images are inline data: URLs, so this resolves near-instantly —
    // but html2canvas still needs actual decoded dimensions before it
    // captures, and the avoid-break measurements below need real layout.
    await Promise.all(
      Array.from(printRoot.querySelectorAll("img")).map(
        (img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
              }),
      ),
    );

    const avoidRanges = measureAvoidRanges(printRoot, CAPTURE_SCALE);

    // Captured directly from the still-isolated iframe element — never
    // reparented into the app's document, unlike html2pdf.js's own flow.
    const canvas = await html2canvas(printRoot, {
      scale: CAPTURE_SCALE,
      backgroundColor: PDF_BACKGROUND,
      useCORS: true,
      // html2canvas measures positions in its own copy of the frame. Its
      // fonts must be loaded there too before measuring, or formulas are
      // laid out with fallback-font metrics (fraction bars through the
      // numerator, subscripts on the baseline) while drawn in KaTeX fonts.
      onclone: hasMath ? (clonedDoc) => loadKatexFonts([clonedDoc]) : undefined,
    });

    const mmPerCanvasPx = USABLE_WIDTH_MM / canvas.width;
    const usableHeightPx = USABLE_HEIGHT_MM / mmPerCanvasPx;
    const slices = computePageSlices(canvas.height, usableHeightPx, avoidRanges);

    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = canvas.width;
    const pageCtx = pageCanvas.getContext("2d");
    if (!pageCtx) throw new Error("PDF 페이지 캔버스를 생성하지 못했습니다.");

    slices.forEach((slice, pageIndex) => {
      pageCanvas.height = slice.sh;
      pageCtx.fillStyle = PDF_BACKGROUND;
      pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      pageCtx.drawImage(canvas, 0, slice.sy, canvas.width, slice.sh, 0, 0, canvas.width, slice.sh);

      if (pageIndex > 0) pdf.addPage();
      pdf.addImage(
        pageCanvas.toDataURL("image/jpeg", 0.98),
        "JPEG",
        MARGIN_MM,
        MARGIN_MM,
        USABLE_WIDTH_MM,
        slice.sh * mmPerCanvasPx,
      );
    });

    pdf.save(buildPdfFileName(data.title, new Date()));
  } finally {
    document.body.removeChild(iframe);
  }
}

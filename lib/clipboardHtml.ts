// The text/html half of the "클립보드 복사" button (see copyRichToClipboard in
// lib/export.ts). Pasting plain markdown into Notion leaves ** and <mark> as
// literal text; Notion reads this HTML instead, so the note arrives with
// real headings, nested lists, tables, quotes, bold and highlights.
//
// Plain semantic tags only (no classes, no app CSS) — what Notion and other
// editors map onto their own blocks. Formulas deliberately stay as their
// $...$ / $$...$$ source text, never KaTeX's rendered HTML, which pastes as
// a jumble of glyphs.

import { stripMarkTags, tokenizeInline } from "@/lib/inlineMarkdown";
import {
  displayMathFenceClose,
  matchDisplayMathLine,
  protectMath,
  splitMathPlaceholders,
} from "@/lib/inlineMath";
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

// Same yellow as the on-screen highlighter. Inline style as well as the tag:
// editors that don't style <mark> themselves still show the background.
const HIGHLIGHT_STYLE = "background-color:#fef08a;";

// Same emoji set as the screen renderer's callouts (lib/markdown.tsx).
const CALLOUT_EMOJIS = ["🚨", "🔥", "💡", "▲", "🗣️", "💜"];

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stripQuotePrefix(line: string): string {
  return line.trim().replace(/^>\s*/, "");
}

function isCalloutLine(line: string): boolean {
  const text = stripQuotePrefix(line);
  return CALLOUT_EMOJIS.some((emoji) => text.startsWith(emoji));
}

function plainQuote(line: string): string | null {
  if (isCalloutLine(line) || matchEquationLine(line) !== null) return null;
  return matchQuoteLine(line);
}

// **bold** -> <strong>, <mark> -> <mark style=…>, formulas -> their source
// with $ / $$ delimiters (escaped as text). Formulas are swapped out before
// the bold/highlight pass so a formula's own * or < isn't misread.
function inlineHtml(text: string): string {
  const { text: protectedText, spans } = protectMath(text);
  const withMath = (value: string) =>
    splitMathPlaceholders(value)
      .map((piece) => {
        if (typeof piece === "string") return escapeHtml(piece);
        const { tex, display } = spans[piece];
        return escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
      })
      .join("");
  return tokenizeInline(protectedText)
    .map((group) => {
      const inner = group.parts
        .map((part) => (part.bold ? `<strong>${withMath(part.text)}</strong>` : withMath(part.text)))
        .join("");
      return group.highlight ? `<mark style="${HIGHLIGHT_STYLE}">${inner}</mark>` : inner;
    })
    .join("");
}

function listHtml(nodes: ListNode[]): string {
  let html = "";
  let start = 0;
  while (start < nodes.length) {
    const ordered = nodes[start].ordered;
    let end = start;
    while (end < nodes.length && nodes[end].ordered === ordered) end++;
    const items = nodes
      .slice(start, end)
      .map((node) => `<li>${inlineHtml(stripQuotePrefix(node.text))}${node.children.length > 0 ? listHtml(node.children) : ""}</li>`)
      .join("");
    const firstNumber = ordered ? parseInt(nodes[start].marker, 10) : 1;
    html += ordered
      ? `<ol${firstNumber > 1 ? ` start="${firstNumber}"` : ""}>${items}</ol>`
      : `<ul>${items}</ul>`;
    start = end;
  }
  return html;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableSeparatorRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

const SLIDE_IMAGE_PATTERN = /^!\[[^\]]*\]\(slide_(\d+)\)$/;
const IMAGE_PATTERN = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;

export function markdownToClipboardHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let list: ListLine[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(listHtml(buildListTree(list)));
    list = [];
  };

  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      flushList();
      index++;
      continue;
    }

    if (isCodeFence(line)) {
      flushList();
      const { code, next, language } = readCodeFence(lines, index);
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
      blocks.push(`<pre><code${languageClass}>${escapeHtml(code)}</code></pre>`);
      index = next;
      continue;
    }

    // Display formula on its own line(s): one paragraph holding the $$…$$ source.
    const displayTex = matchDisplayMathLine(line);
    const fenceClose = displayTex === null ? displayMathFenceClose(line) : null;
    if (displayTex !== null || fenceClose !== null) {
      flushList();
      let tex = displayTex ?? "";
      let next = index + 1;
      if (fenceClose !== null) {
        const body: string[] = [];
        while (next < lines.length && lines[next].trim() !== fenceClose) body.push(lines[next++].trim());
        tex = body.join(" ").trim();
        next = Math.min(next + 1, lines.length);
      }
      if (tex) blocks.push(`<p>${escapeHtml(`$$${tex}$$`)}</p>`);
      index = next;
      continue;
    }

    // <details> asides: the summary as a bold line, then the content.
    if (line === "<details>") {
      flushList();
      let cursor = index + 1;
      const summary = cursor < lines.length ? lines[cursor].trim().match(/^<summary>(.*)<\/summary>$/) : null;
      if (summary) {
        blocks.push(`<p><strong>${inlineHtml(summary[1].trim() || "부가 정보")}</strong></p>`);
        cursor++;
      }
      index = cursor;
      continue;
    }
    if (line === "</details>") {
      flushList();
      index++;
      continue;
    }

    if (line.startsWith("|") && index + 1 < lines.length && isTableSeparatorRow(lines[index + 1])) {
      flushList();
      const header = splitTableRow(line);
      let cursor = index + 2;
      const rows: string[][] = [];
      while (cursor < lines.length && lines[cursor].trim().startsWith("|")) rows.push(splitTableRow(lines[cursor++]));
      blocks.push(
        `<table><thead><tr>${header.map((cell) => `<th>${inlineHtml(cell)}</th>`).join("")}</tr></thead>` +
          `<tbody>${rows
            .map((row) => `<tr>${header.map((_h, column) => `<td>${inlineHtml(row[column] ?? "")}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`,
      );
      index = cursor;
      continue;
    }

    const listLine = parseListLine(rawLine);
    if (listLine) {
      list.push(listLine);
      index++;
      continue;
    }
    flushList();

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      blocks.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    const slide = line.match(SLIDE_IMAGE_PATTERN);
    if (slide) {
      blocks.push(`<p>🖼️ 슬라이드 ${slide[1]}</p>`);
      index++;
      continue;
    }
    const image = line.match(IMAGE_PATTERN);
    if (image) {
      blocks.push(`<p><img src="${escapeHtml(image[2])}" alt="${escapeHtml(stripMarkTags(image[1]))}" /></p>`);
      index++;
      continue;
    }

    // Callouts (emoji lines), formula lines and plain "> " quotes -> one
    // blockquote per run of consecutive lines; Notion turns it into a quote.
    if (isCalloutLine(line) || matchEquationLine(line) !== null || plainQuote(line) !== null) {
      const { items, next } = readMatchingRun(lines, index, (candidate) =>
        candidate.trim() && (isCalloutLine(candidate) || matchEquationLine(candidate) !== null || plainQuote(candidate) !== null)
          ? stripQuotePrefix(candidate)
          : null,
      );
      blocks.push(`<blockquote>${items.map((item) => `<p>${inlineHtml(item)}</p>`).join("")}</blockquote>`);
      index = next;
      continue;
    }

    blocks.push(`<p>${inlineHtml(line)}</p>`);
    index++;
  }
  flushList();
  return blocks.join("");
}

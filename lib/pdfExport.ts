"use client";

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

type CalloutStyle = { emoji: string; bg: string; border: string; text: string };

const PDF_CALLOUT_STYLES: CalloutStyle[] = [
  { emoji: "🔥", bg: "#fef2f2", border: "#fecaca", text: "#991b1b" },
  { emoji: "💡", bg: "#fefce8", border: "#fef08a", text: "#854d0e" },
  { emoji: "🗣️", bg: "#eff6ff", border: "#bfdbfe", text: "#1e40af" },
  { emoji: "💜", bg: "#f5f3ff", border: "#ddd6fe", text: "#5b21b6" },
];

const PDF_BACKGROUND = "#ffffff";
const PDF_TEXT_COLOR = "#111827";
const PDF_FONT_FAMILY = "'Apple SD Gothic Neo', 'Malgun Gothic', -apple-system, BlinkMacSystemFont, sans-serif";
const BODY_STYLE = "font-size:12.5px;color:#374151;line-height:1.6;";
const AVOID_BREAK_STYLE = "break-inside:avoid;page-break-inside:avoid;";
const AVOID_BREAK_ATTR = 'data-avoid-break="true"';

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

function renderInlineHtml(text: string): string {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts
    .map((part) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4
        ? `<strong>${escapeHtml(part.slice(2, -2))}</strong>`
        : escapeHtml(part),
    )
    .join("");
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

function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let listBuffer: string[] = [];
  let index = 0;

  function flushList() {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];

    if (items.some((item) => detectCallout(item))) {
      const itemsHtml = items
        .map((item) => {
          const callout = detectCallout(item);
          if (callout) {
            return `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}border:1px solid ${callout.border};border-radius:8px;padding:8px 12px;font-size:12.5px;background:${callout.bg};color:${callout.text};">${renderInlineHtml(item)}</div>`;
          }
          return `<ul style="margin:0;padding-left:18px;list-style-type:disc;"><li style="${BODY_STYLE}">${renderInlineHtml(item)}</li></ul>`;
        })
        .join("");
      blocks.push(`<div style="display:flex;flex-direction:column;gap:6px;margin:6px 0;">${itemsHtml}</div>`);
      return;
    }

    const liHtml = items.map((item) => `<li style="${BODY_STYLE}">${renderInlineHtml(item)}</li>`).join("");
    blocks.push(
      `<ul style="margin:6px 0;padding-left:18px;list-style-type:disc;display:flex;flex-direction:column;gap:4px;">${liHtml}</ul>`,
    );
  }

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      flushList();
      index++;
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
      const theadHtml = `<thead style="background:#fafafa;"><tr>${headerCells
        .map(
          (cell) =>
            `<th style="border-bottom:1px solid #e5e7eb;padding:6px 10px;font-weight:700;color:#374151;">${renderInlineHtml(cell)}</th>`,
        )
        .join("")}</tr></thead>`;
      const tbodyHtml = `<tbody>${bodyRows
        .map(
          (row, rowIndex) =>
            `<tr style="border-bottom:${rowIndex === bodyRows.length - 1 ? "none" : "1px solid #f3f4f6"};">${row
              .map((cell) => `<td style="padding:6px 10px;color:#4b5563;">${renderInlineHtml(cell)}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody>`;
      blocks.push(
        `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}margin:6px 0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;text-align:left;font-size:12px;">${theadHtml}${tbodyHtml}</table></div>`,
      );
      index = cursor;
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.*)$/);
    if (bulletMatch) {
      listBuffer.push(bulletMatch[1]);
      index++;
      continue;
    }
    flushList();

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(
        `<p style="${headingStyle(level)}margin:${index === 0 ? "0 0 4px" : "12px 0 4px"};">${renderInlineHtml(headingMatch[2])}</p>`,
      );
      index++;
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
        if (/^[-*•]\s+/.test(nextLine)) break;
        if (/^#{1,4}\s+/.test(nextLine)) break;
        if (nextLine.startsWith("|")) break;
        if (detectCallout(nextLine)) break;
        groupLines.push(stripBlockquotePrefix(nextLine));
        cursor++;
      }
      const groupHtml = groupLines.map((groupLine) => `<p style="margin:0;">${renderInlineHtml(groupLine)}</p>`).join("");
      blocks.push(
        `<div ${AVOID_BREAK_ATTR} style="${AVOID_BREAK_STYLE}border:1px solid ${callout.border};border-radius:8px;padding:8px 12px;margin:6px 0;display:flex;flex-direction:column;gap:4px;font-size:12.5px;background:${callout.bg};color:${callout.text};">${groupHtml}</div>`,
      );
      index = cursor;
      continue;
    }

    blocks.push(`<p style="${BODY_STYLE}margin:4px 0;">${renderInlineHtml(line)}</p>`);
    index++;
  }

  flushList();
  return `<div style="display:flex;flex-direction:column;">${blocks.join("")}</div>`;
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

type AvoidRange = { top: number; bottom: number };

// Picks each page's end so it never lands inside a callout box or table
// (falls back to a plain cut only if a single block is taller than a page).
function computePageSlices(canvasHeightPx: number, usableHeightPx: number, avoidRanges: AvoidRange[]) {
  const slices: Array<{ sy: number; sh: number }> = [];
  let y = 0;
  while (y < canvasHeightPx - 0.5) {
    let end = Math.min(y + usableHeightPx, canvasHeightPx);
    for (const range of avoidRanges) {
      if (range.top > y && range.top < end && range.bottom > end) {
        end = range.top;
      }
    }
    slices.push({ sy: y, sh: end - y });
    y = end;
  }
  return slices;
}

// Always exports the full, untouched markdown (never the currently-paginated
// slice shown on screen) — same data-preservation principle as copy/.txt/.md
// download and Notion export.
export async function exportLectureNoteToPdf(markdown: string, recordingTitle: string): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);

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
    frameDoc.open();
    frameDoc.write('<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body></body></html>');
    frameDoc.close();

    const safeTitle = escapeHtml(recordingTitle || "제목 없는 강의");
    const bodyMarkdown = markdown?.trim() ? markdown : "상세 강의노트가 없습니다.";

    frameDoc.body.style.margin = "0";
    frameDoc.body.style.backgroundColor = PDF_BACKGROUND;
    frameDoc.body.innerHTML = `<div id="pdf-export-root" style="width:${CONTENT_WIDTH_PX}px;box-sizing:border-box;background:${PDF_BACKGROUND};color:${PDF_TEXT_COLOR};font-family:${PDF_FONT_FAMILY};">
      <p style="font-size:18px;font-weight:700;color:${PDF_TEXT_COLOR};margin:0 0 12px;">${safeTitle}</p>
      ${renderMarkdownToHtml(bodyMarkdown)}
    </div>`;

    const printRoot = frameDoc.getElementById("pdf-export-root");
    if (!printRoot) throw new Error("PDF 렌더링용 컨테이너를 찾지 못했습니다.");

    const rootRect = printRoot.getBoundingClientRect();
    const avoidRanges: AvoidRange[] = Array.from(printRoot.querySelectorAll("[data-avoid-break]")).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        top: (rect.top - rootRect.top) * CAPTURE_SCALE,
        bottom: (rect.bottom - rootRect.top) * CAPTURE_SCALE,
      };
    });

    // Captured directly from the still-isolated iframe element — never
    // reparented into the app's document, unlike html2pdf.js's own flow.
    const canvas = await html2canvas(printRoot, {
      scale: CAPTURE_SCALE,
      backgroundColor: PDF_BACKGROUND,
      useCORS: true,
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

    pdf.save(buildPdfFileName(recordingTitle, new Date()));
  } finally {
    document.body.removeChild(iframe);
  }
}

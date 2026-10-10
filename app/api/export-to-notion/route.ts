import { NextResponse } from "next/server";
import { APIResponseError, Client, isNotionClientError } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client";
import { extractNotionId } from "@/lib/notionUtils";
import { formatDuration } from "@/lib/format";
import { tokenizeInline } from "@/lib/inlineMarkdown";
import { displayMathFenceClose, matchDisplayMathLine, protectMath, splitMathPlaceholders } from "@/lib/inlineMath";
import {
  EQUATION_MARKER,
  buildListTree,
  isCodeFence,
  matchEquationLine,
  matchQuoteLine,
  parseListLine,
  readCodeFence,
  readMatchingRun,
} from "@/lib/noteBlocks";
import type { ListLine, ListNode } from "@/lib/noteBlocks";

export const runtime = "nodejs";
export const maxDuration = 120;

const RICH_TEXT_CHAR_LIMIT = 2000;
// Notion's limits per append request: at most 100 blocks in any one
// children array, and at most 1000 block elements in total (nested ones
// included).
const BLOCKS_PER_REQUEST = 100;
const MAX_BLOCK_ELEMENTS_PER_REQUEST = 1000;
// Real lecture transcripts can run to hundreds of segments; cap how many we
// push into the toggle so one export can't balloon into hundreds of Notion
// API calls and blow the function's time budget.
const MAX_TRANSCRIPT_PARAGRAPHS = 500;

type NotionAnnotations = { bold?: boolean; color?: NotionCalloutColor };
// Plain text, or an inline equation (Notion renders its expression with
// KaTeX, the same engine as the app — see lib/markdown.tsx).
type NotionRichText =
  | { type?: "text"; text: { content: string }; annotations?: NotionAnnotations }
  | { type: "equation"; equation: { expression: string }; annotations?: NotionAnnotations };

// Notion's cap on an equation's expression; anything longer goes as text.
const EQUATION_CHAR_LIMIT = 1000;

// A block plus the blocks nested under it (sub-bullets under a bullet,
// toggle contents). Kept as a tree until appendBlockTree sends it, which puts
// each block's children inside the parent's own `children` — so Notion keeps
// the nesting instead of every item landing flat at the top level.
type BlockNode = { block: BlockObjectRequest; children: BlockNode[] };

function leaf(block: BlockObjectRequest): BlockNode {
  return { block, children: [] };
}

type IncomingChecklistItem = { text?: unknown; done?: unknown };
type IncomingTranscriptSegment = { startMs?: unknown; text?: unknown };

type ExportRequestBody = {
  notionToken?: unknown;
  targetId?: unknown;
  title?: unknown;
  summary?: unknown;
  lectureNote?: unknown;
  checklist?: unknown;
  transcript?: unknown;
};

// Notion's ApiColor type isn't exported by the SDK, so this narrow literal
// union is declared locally — its members are a subset of ApiColor's, which
// is enough for structural assignment into callout.color below.
type NotionCalloutColor =
  | "gray_background"
  | "green_background"
  | "red_background"
  | "yellow_background"
  | "orange_background"
  | "blue_background"
  | "purple_background";

// 🚨 takes red — Notion's strongest available callout color — since it's
// the AI's "confirmed exam question" marker (see the [시험 출제 신호 감지]
// prompt rule in app/api/transcribe-and-summarize/route.ts) and needs to
// visually outrank the plain 🔥 emphasis callout, not just duplicate it in
// another color; 🔥 moved to yellow to free red up rather than collide.
const CALLOUT_COLOR_BY_EMOJI: Record<string, NotionCalloutColor> = {
  "🚨": "red_background",
  "🔥": "yellow_background",
  "💡": "orange_background",
  "▲": "green_background",
  "🗣️": "blue_background",
  "💜": "purple_background",
};
// Bolded on top of its color, unlike the others — extra emphasis to match
// the on-screen (lib/markdown.tsx) and PDF (lib/pdfExport.ts) renderers,
// which also give 🚨 a visually heavier treatment than the rest.
const BOLD_CALLOUT_EMOJIS = new Set(["🚨"]);
// A callout icon must be a real emoji; "▲" (the note's 필기 팁 marker) isn't one.
const NOTION_ICON_BY_MARKER: Record<string, string> = { "▲": "📝" };
const CALLOUT_EMOJIS = Object.keys(CALLOUT_COLOR_BY_EMOJI);

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
  return chunks;
}

// <mark> (the note's 형광펜, see lib/inlineMarkdown.ts) maps to a Notion
// text background color. Callers inside a callout that's already yellow pass
// a different color so the highlight doesn't vanish into its background.
// LaTeX in the text ($\alpha$, \(...\), and $$...$$ mid-sentence) becomes
// Notion inline equations. Formulas are swapped for placeholders before the
// **bold** / <mark> pass and restored afterwards (same as lib/markdown.tsx),
// so a formula's own * or < isn't misread and a highlighted or bold formula
// keeps that styling. A $$...$$ on its own line is an equation block instead
// (see convertLectureNoteToBlocks).
function buildRichText(text: string, bold = false, highlightColor: NotionCalloutColor = "yellow_background"): NotionRichText[] {
  if (!text) return [];
  const { text: protectedText, spans } = protectMath(text);
  const result: NotionRichText[] = [];
  for (const group of tokenizeInline(protectedText)) {
    for (const part of group.parts) {
      const isBold = bold || part.bold;
      const annotations: NotionAnnotations = {
        ...(isBold ? { bold: true } : {}),
        ...(group.highlight ? { color: highlightColor } : {}),
      };
      const withAnnotations = Object.keys(annotations).length > 0 ? { annotations } : {};
      for (const piece of splitMathPlaceholders(part.text)) {
        if (typeof piece === "number" && spans[piece].tex.length <= EQUATION_CHAR_LIMIT) {
          result.push({ type: "equation", equation: { expression: spans[piece].tex }, ...withAnnotations });
          continue;
        }
        const content = typeof piece === "number" ? `$${spans[piece].tex}$` : piece;
        for (const chunk of chunkText(content, RICH_TEXT_CHAR_LIMIT)) {
          result.push({ type: "text", text: { content: chunk }, ...withAnnotations });
        }
      }
    }
  }
  return result;
}

// The AI writes selective callouts as a blockquote line ("> 🔥 ..."), but a
// bare emoji-prefixed line is also accepted — mirrors lib/markdown.tsx.
function stripBlockquotePrefix(line: string): string {
  return line.replace(/^>\s*/, "");
}

function detectCalloutEmoji(line: string): string | null {
  const trimmed = stripBlockquotePrefix(line.trim());
  return CALLOUT_EMOJIS.find((emoji) => trimmed.startsWith(emoji)) ?? null;
}

// A plain "> " quote line — anything that isn't an emoji callout or a
// formula line (mirrors lib/markdown.tsx).
function matchPlainQuote(line: string): string | null {
  if (detectCalloutEmoji(line) || matchEquationLine(line) !== null) return null;
  return matchQuoteLine(line);
}

function stripCalloutEmoji(line: string, emoji: string): string {
  return stripBlockquotePrefix(line.trim()).slice(emoji.length).trim();
}

// Matches lib/pdfExport.ts / lib/markdown.tsx's own table-row parsing —
// same "| a | b |" syntax, same separator-row detection — so the three
// renderers agree on what counts as a real table.
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

// Formula lines (`> 🧮 ...`) -> a gray, bold 🧮 callout, one line per
// formula. Not Notion's native equation block: that takes KaTeX, and these
// formulas are plain text with Korean terms (자산 = 부채 + 자본).
function equationCalloutBlock(equations: string[]): BlockObjectRequest {
  return {
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: EQUATION_MARKER },
      color: "gray_background",
      rich_text: buildRichText(equations.join("\n"), true),
    },
  };
}

function emojiCalloutBlock(line: string, emoji: string): BlockObjectRequest {
  return {
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: NOTION_ICON_BY_MARKER[emoji] ?? emoji },
      color: CALLOUT_COLOR_BY_EMOJI[emoji],
      rich_text: buildRichText(
        stripCalloutEmoji(line, emoji),
        BOLD_CALLOUT_EMOJIS.has(emoji),
        CALLOUT_COLOR_BY_EMOJI[emoji] === "yellow_background" ? "orange_background" : "yellow_background",
      ),
    },
  };
}

// One list item and its sub-items. A list item that's itself a callout or
// formula line becomes that block (with the sub-items still nested under
// it), matching how lib/markdown.tsx renders it on screen.
function listNodeToBlock(node: ListNode): BlockNode {
  const children = node.children.map(listNodeToBlock);
  const equation = matchEquationLine(node.text);
  if (equation !== null) return { block: equationCalloutBlock([equation]), children };
  const emoji = detectCalloutEmoji(node.text);
  if (emoji) return { block: emojiCalloutBlock(node.text, emoji), children };
  const rich_text = buildRichText(node.text);
  return {
    block: node.ordered
      ? { type: "numbered_list_item", numbered_list_item: { rich_text } }
      : { type: "bulleted_list_item", bulleted_list_item: { rich_text } },
    children,
  };
}

/**
 * Converts the app's lightweight lecture-note markdown (headings, nested
 * bullets/numbered lists, **bold**, callout and formula lines, tables,
 * toggles — see lib/markdown.tsx, the in-app renderer this mirrors) into a
 * tree of Notion block objects.
 */
function convertLectureNoteToBlocks(markdown: string): BlockNode[] {
  const lines = markdown.split("\n");
  const blocks: BlockNode[] = [];
  const push = (block: BlockObjectRequest) => blocks.push(leaf(block));
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index++;
      continue;
    }

    // Fenced code block -> Notion's own code block, verbatim.
    if (isCodeFence(line)) {
      const { code, next } = readCodeFence(lines, index);
      push({
        type: "code",
        code: {
          language: "plain text",
          rich_text: chunkText(code, RICH_TEXT_CHAR_LIMIT).map((content) => ({ type: "text" as const, text: { content } })),
        },
      });
      index = next;
      continue;
    }

    // Display formula — a line that's one whole "$$...$$" / "\[...\]", or a
    // "$$" / "\[" line opening a multi-line one — becomes a Notion equation
    // block (centered, like the app's display math).
    const displayTex = matchDisplayMathLine(line);
    const displayFenceClose = displayTex === null ? displayMathFenceClose(line) : null;
    if (displayTex !== null || displayFenceClose !== null) {
      let expression = displayTex ?? "";
      let next = index + 1;
      if (displayFenceClose !== null) {
        const body: string[] = [];
        while (next < lines.length && lines[next].trim() !== displayFenceClose) body.push(lines[next++]);
        expression = body.join("\n").trim();
        next = Math.min(next + 1, lines.length);
      }
      if (expression && expression.length <= EQUATION_CHAR_LIMIT) {
        push({ type: "equation", equation: { expression } });
      } else if (expression) {
        push({ type: "paragraph", paragraph: { rich_text: buildRichText(`$$${expression}$$`) } });
      }
      index = next;
      continue;
    }

    if (matchEquationLine(line) !== null) {
      const { items, next } = readMatchingRun(lines, index, matchEquationLine);
      push(equationCalloutBlock(items));
      index = next;
      continue;
    }

    // <details>/<summary>...</summary>...</details> — see lib/markdown.tsx
    // for the on-screen version this mirrors. Notion has a native toggle
    // block for exactly this (already used below for the transcript), so
    // it maps directly rather than needing a fallback representation.
    if (line === "<details>") {
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
      blocks.push({
        block: { type: "toggle", toggle: { rich_text: buildRichText(summaryText) } },
        children: convertLectureNoteToBlocks(innerLines.join("\n")),
      });
      index = cursor + 1;
      continue;
    }

    // Markdown table: a header row immediately followed by a "|---|---|"
    // separator row. Notion has a real `table` block (with `table_row`
    // children) for exactly this — unlike every other block type here,
    // Notion requires a table's rows to be included as `table.children` in
    // the very same request that creates the table, so this consumes the
    // whole table up front rather than emitting it row by row.
    if (line.startsWith("|") && index + 1 < lines.length && isTableSeparatorRow(lines[index + 1])) {
      const headerCells = splitTableRow(line);
      const tableWidth = headerCells.length;
      const bodyRows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
        bodyRows.push(splitTableRow(lines[cursor]));
        cursor++;
      }
      // Every row's cell count must equal table_width exactly or Notion
      // rejects the whole request — pad/truncate defensively rather than
      // trust the AI's output to be perfectly well-formed.
      const toTableRow = (cells: string[]) => ({
        type: "table_row" as const,
        table_row: {
          cells: Array.from({ length: tableWidth }, (_, cellIndex) => buildRichText(cells[cellIndex] ?? "")),
        },
      });
      push({
        type: "table",
        table: {
          table_width: tableWidth,
          has_column_header: true,
          has_row_header: false,
          children: [headerCells, ...bodyRows].map(toTableRow),
        },
      });
      index = cursor;
      continue;
    }

    if (line.startsWith("|")) {
      if (isTableSeparatorRow(line)) {
        index++;
        continue; // orphaned separator row (no header row before it) — skip
      }
      const cells = splitTableRow(line);
      push({
        type: "paragraph",
        paragraph: { rich_text: buildRichText(cells.join("  ·  ")) },
      });
      index++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const richText = buildRichText(headingMatch[2]);
      if (level <= 2) {
        push({ type: "heading_2", heading_2: { rich_text: richText } });
      } else {
        push({ type: "heading_3", heading_3: { rich_text: richText } });
      }
      index++;
      continue;
    }

    // A run of list lines -> nested list blocks. Indentation is read from the
    // raw lines (parseListLine), so sub-bullets become children of their
    // parent item instead of more top-level bullets.
    if (parseListLine(lines[index])) {
      const items: ListLine[] = [];
      while (index < lines.length) {
        const item = parseListLine(lines[index]);
        if (!item) break;
        items.push(item);
        index++;
      }
      blocks.push(...buildListTree(items).map(listNodeToBlock));
      continue;
    }

    // `![슬라이드 N](slide_N)` (see lib/markdown.tsx) — the actual image is a
    // local data: URL the app cached client-side, which Notion's API can't
    // accept (it only takes externally-hosted URLs), so this renders as a
    // plain reference instead of broken markdown syntax.
    const slideMatch = line.match(/^!\[[^\]]*\]\(slide_(\d+)\)$/);
    if (slideMatch) {
      push({
        type: "paragraph",
        paragraph: { rich_text: buildRichText(`🖼️ 슬라이드 ${slideMatch[1]} (이미지는 앱에서 확인해주세요)`) },
      });
      index++;
      continue;
    }

    // A general markdown image (e.g. an external reference image the AI
    // cited for "AI 심화 탐구" — see app/api/expand-note/route.ts), unlike
    // the slide placeholder above, points at a real externally-hosted URL,
    // which Notion's `image` block can embed directly via `external.url`.
    const imageMatch = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/);
    if (imageMatch) {
      push({
        type: "image",
        image: { type: "external", external: { url: imageMatch[2] } },
      });
      index++;
      continue;
    }

    const calloutEmoji = detectCalloutEmoji(line);
    if (calloutEmoji) {
      push(emojiCalloutBlock(line, calloutEmoji));
      index++;
      continue;
    }

    if (matchPlainQuote(line) !== null) {
      const { items, next } = readMatchingRun(lines, index, matchPlainQuote);
      push({ type: "quote", quote: { rich_text: buildRichText(items.join("\n")) } });
      index = next;
      continue;
    }

    push({ type: "paragraph", paragraph: { rich_text: buildRichText(line) } });
    index++;
  }

  return blocks;
}

function buildSummaryCalloutBlock(summary: string): BlockObjectRequest {
  return {
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: "💡" },
      color: "blue_background",
      rich_text: [
        ...buildRichText("AI 핵심 개요\n", true),
        ...buildRichText(summary || "요약 내용이 없습니다."),
      ],
    },
  };
}

function buildChecklistBlocks(checklist: IncomingChecklistItem[]): BlockObjectRequest[] {
  if (checklist.length === 0) return [];
  const items: BlockObjectRequest[] = checklist
    .filter((item): item is { text: string; done?: unknown } => typeof item.text === "string" && item.text.trim().length > 0)
    .map((item) => ({
      type: "to_do",
      to_do: { rich_text: buildRichText(item.text), checked: item.done === true },
    }));
  if (items.length === 0) return [];
  return [{ type: "heading_3", heading_3: { rich_text: buildRichText("✅ 체크리스트") } }, ...items];
}

function buildTranscriptParagraphs(transcript: IncomingTranscriptSegment[]): BlockObjectRequest[] {
  const segments = transcript.filter(
    (segment): segment is { startMs: number; text: string } =>
      typeof segment.text === "string" && segment.text.trim().length > 0,
  );
  if (segments.length === 0) return [];

  const capped = segments.slice(0, MAX_TRANSCRIPT_PARAGRAPHS);
  const paragraphs: BlockObjectRequest[] = capped.map((segment) => {
    const timestamp = typeof segment.startMs === "number" ? `[${formatDuration(segment.startMs)}] ` : "";
    return {
      type: "paragraph",
      paragraph: { rich_text: buildRichText(`${timestamp}${segment.text.trim()}`) },
    };
  });
  if (segments.length > MAX_TRANSCRIPT_PARAGRAPHS) {
    paragraphs.push({
      type: "paragraph",
      paragraph: { rich_text: buildRichText("… (이하 스크립트 생략 — 전체 내용은 앱에서 확인해주세요)") },
    });
  }
  return paragraphs;
}

// Notion takes a block's children inside its type-specific object, e.g.
// { type: "bulleted_list_item", bulleted_list_item: { rich_text, children } }.
function withChildren(block: BlockObjectRequest, children: BlockObjectRequest[]): BlockObjectRequest {
  if (children.length === 0 || !block.type) return block;
  const content = (block as Record<string, unknown>)[block.type] as Record<string, unknown>;
  return { ...block, [block.type]: { ...content, children } } as BlockObjectRequest;
}

// Ids of a block's first `count` children, in order.
async function listChildIds(notion: Client, blockId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion.blocks.children.list({ block_id: blockId, page_size: 100, start_cursor: cursor });
    ids.push(...page.results.map((result) => result.id));
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor && ids.length < count);
  return ids.slice(0, count);
}

// Appends a block tree under parentId, keeping every block's children nested
// inside it. Each request carries a batch of blocks with their direct
// children inline; anything deeper is appended afterwards to the created
// child blocks (whose ids come from listing the parent's children), so the
// nesting depth is unlimited. A typical note — bullets with one level of
// sub-bullets — still goes out in the same few requests as before.
async function appendBlockTree(notion: Client, parentId: string, nodes: BlockNode[]): Promise<void> {
  let start = 0;
  while (start < nodes.length) {
    const batch: BlockNode[] = [];
    let elements = 0;
    while (start + batch.length < nodes.length && batch.length < BLOCKS_PER_REQUEST) {
      const node = nodes[start + batch.length];
      const size = 1 + Math.min(node.children.length, BLOCKS_PER_REQUEST);
      if (batch.length > 0 && elements + size > MAX_BLOCK_ELEMENTS_PER_REQUEST) break;
      batch.push(node);
      elements += size;
    }
    start += batch.length;

    const response = await notion.blocks.children.append({
      block_id: parentId,
      children: batch.map((node) =>
        withChildren(
          node.block,
          node.children.slice(0, BLOCKS_PER_REQUEST).map((child) => child.block),
        ),
      ),
    });

    for (const [position, node] of batch.entries()) {
      if (node.children.length === 0) continue;
      const blockId = response.results[position]?.id;
      if (!blockId) throw new Error("노션에 추가된 블록을 확인하지 못해 하위 항목을 넣을 수 없습니다.");
      const inline = node.children.slice(0, BLOCKS_PER_REQUEST);
      if (inline.some((child) => child.children.length > 0)) {
        const childIds = await listChildIds(notion, blockId, inline.length);
        for (const [childPosition, child] of inline.entries()) {
          if (child.children.length > 0 && childIds[childPosition]) {
            await appendBlockTree(notion, childIds[childPosition], child.children);
          }
        }
      }
      if (node.children.length > BLOCKS_PER_REQUEST) {
        await appendBlockTree(notion, blockId, node.children.slice(BLOCKS_PER_REQUEST));
      }
    }
  }
}

function mapNotionError(error: unknown): { status: number; message: string } {
  if (APIResponseError.isAPIResponseError(error)) {
    if (error.code === "unauthorized") {
      return {
        status: 401,
        message: "Notion 토큰이 유효하지 않습니다. Integration의 'Internal Integration Secret' 값을 다시 확인해주세요.",
      };
    }
    if (error.code === "object_not_found" || error.code === "restricted_resource") {
      return {
        status: 404,
        message:
          "해당 노션 페이지를 찾을 수 없거나 접근 권한이 없습니다. 노션 페이지 우측 상단 '⋯' 메뉴 → '연결 추가'에서 이 Integration을 연결했는지 확인해주세요.",
      };
    }
    if (error.code === "validation_error") {
      return {
        status: 400,
        message: `노션 요청이 거부되었습니다: ${error.message}`,
      };
    }
    if (error.code === "rate_limited") {
      return { status: 429, message: "노션 API 요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." };
    }
    return { status: 502, message: `노션 API 오류: ${error.message}` };
  }
  if (isNotionClientError(error)) {
    return { status: 502, message: `노션 연결에 실패했습니다: ${error.message}` };
  }
  return { status: 500, message: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다." };
}

export async function POST(request: Request) {
  let body: ExportRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const notionToken = typeof body.notionToken === "string" ? body.notionToken.trim() : "";
  if (!notionToken) {
    return NextResponse.json({ error: "Notion 통합 토큰을 입력해주세요." }, { status: 400 });
  }

  const rawTargetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  const targetPageId = rawTargetId ? extractNotionId(rawTargetId) : null;
  if (!targetPageId) {
    return NextResponse.json(
      { error: "유효한 노션 페이지 링크 또는 ID를 찾을 수 없습니다. 링크를 다시 확인해주세요." },
      { status: 400 },
    );
  }

  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "제목 없는 강의";
  const summary = typeof body.summary === "string" ? body.summary : "";
  const lectureNote = typeof body.lectureNote === "string" ? body.lectureNote : "";
  const checklist = Array.isArray(body.checklist) ? (body.checklist as IncomingChecklistItem[]) : [];
  const transcript = Array.isArray(body.transcript) ? (body.transcript as IncomingTranscriptSegment[]) : [];

  const notion = new Client({ auth: notionToken });

  try {
    const lectureNoteBlocks = lectureNote.trim()
      ? convertLectureNoteToBlocks(lectureNote)
      : [leaf({ type: "paragraph", paragraph: { rich_text: buildRichText("상세 강의노트가 없습니다.") } })];

    // A divider + heading marks where this export starts, since we're
    // appending into a page the user already owns (and may export multiple
    // lectures into over time) rather than creating a fresh page for it.
    const bodyBlocks: BlockNode[] = [
      leaf({ type: "divider", divider: {} }),
      leaf({ type: "heading_2", heading_2: { rich_text: buildRichText(`📚 ${title}`) } }),
      leaf(buildSummaryCalloutBlock(summary)),
      leaf({ type: "heading_3", heading_3: { rich_text: buildRichText("📖 상세 강의노트") } }),
      ...lectureNoteBlocks,
      ...buildChecklistBlocks(checklist).map(leaf),
    ];
    const transcriptParagraphs = buildTranscriptParagraphs(transcript);
    if (transcriptParagraphs.length > 0) {
      bodyBlocks.push({
        block: { type: "toggle", toggle: { rich_text: buildRichText("🎙️ 전체 스크립트 전문", true) } },
        children: transcriptParagraphs.map(leaf),
      });
    }

    // Append directly into the target page's own body (blocks.children.append
    // accepts a page ID as block_id — a page is itself a block in the API).
    await appendBlockTree(notion, targetPageId, bodyBlocks);

    const page = await notion.pages.retrieve({ page_id: targetPageId });
    const url =
      "url" in page && typeof page.url === "string"
        ? page.url
        : `https://www.notion.so/${targetPageId.replace(/-/g, "")}`;
    return NextResponse.json({ url, pageId: targetPageId });
  } catch (error) {
    const { status, message } = mapNotionError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

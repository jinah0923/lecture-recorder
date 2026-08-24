import { NextResponse } from "next/server";
import { APIResponseError, Client, isNotionClientError } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client";
import { extractNotionId } from "@/lib/notionUtils";
import { formatDuration } from "@/lib/format";

export const runtime = "nodejs";
export const maxDuration = 120;

const RICH_TEXT_CHAR_LIMIT = 2000;
const BLOCKS_PER_REQUEST = 100;
// Real lecture transcripts can run to hundreds of segments; cap how many we
// push into the toggle so one export can't balloon into hundreds of Notion
// API calls and blow the function's time budget.
const MAX_TRANSCRIPT_PARAGRAPHS = 500;

type NotionRichText = {
  type?: "text";
  text: { content: string };
  annotations?: { bold?: boolean };
};

// A plain paragraph block has no children of its own, so it structurally
// satisfies Notion's "single level of children" constraint for blocks
// nested one level deep (e.g. inside the transcript toggle below) — unlike
// the broader, recursively-nested `BlockObjectRequest` union type.
type NotionParagraphBlock = { type: "paragraph"; paragraph: { rich_text: NotionRichText[] } };

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
type NotionCalloutColor = "red_background" | "orange_background" | "blue_background" | "purple_background";

const CALLOUT_COLOR_BY_EMOJI: Record<string, NotionCalloutColor> = {
  "🔥": "red_background",
  "💡": "orange_background",
  "🗣️": "blue_background",
  "💜": "purple_background",
};
const CALLOUT_EMOJIS = Object.keys(CALLOUT_COLOR_BY_EMOJI);

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
  return chunks;
}

function buildRichText(text: string, bold = false): NotionRichText[] {
  if (!text) return [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((part) => part.length > 0);
  const result: NotionRichText[] = [];
  for (const part of parts) {
    const isBold = bold || (part.startsWith("**") && part.endsWith("**") && part.length > 4);
    const content = part.startsWith("**") && part.endsWith("**") && part.length > 4 ? part.slice(2, -2) : part;
    for (const chunk of chunkText(content, RICH_TEXT_CHAR_LIMIT)) {
      result.push({
        type: "text",
        text: { content: chunk },
        ...(isBold ? { annotations: { bold: true } } : {}),
      });
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

function stripCalloutEmoji(line: string, emoji: string): string {
  return stripBlockquotePrefix(line.trim()).slice(emoji.length).trim();
}

/**
 * Converts the app's lightweight lecture-note markdown (headings, bullets,
 * **bold**, and 🔥/💡/🗣️/💜 callout lines — see lib/markdown.tsx, the
 * in-app renderer this mirrors) into Notion's official block objects.
 */
function convertLectureNoteToBlocks(markdown: string): BlockObjectRequest[] {
  const lines = markdown.split("\n");
  const blocks: BlockObjectRequest[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("|")) {
      if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line)) continue; // table separator row
      const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      blocks.push({
        type: "paragraph",
        paragraph: { rich_text: buildRichText(cells.join("  ·  ")) },
      });
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const richText = buildRichText(headingMatch[2]);
      if (level <= 2) {
        blocks.push({ type: "heading_2", heading_2: { rich_text: richText } });
      } else {
        blocks.push({ type: "heading_3", heading_3: { rich_text: richText } });
      }
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.*)$/);
    if (bulletMatch) {
      blocks.push({
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: buildRichText(bulletMatch[1]) },
      });
      continue;
    }

    // `![슬라이드 N](slide_N)` (see lib/markdown.tsx) — the actual image is a
    // local data: URL the app cached client-side, which Notion's API can't
    // accept (it only takes externally-hosted URLs), so this renders as a
    // plain reference instead of broken markdown syntax.
    const slideMatch = line.match(/^!\[[^\]]*\]\(slide_(\d+)\)$/);
    if (slideMatch) {
      blocks.push({
        type: "paragraph",
        paragraph: { rich_text: buildRichText(`🖼️ 슬라이드 ${slideMatch[1]} (이미지는 앱에서 확인해주세요)`) },
      });
      continue;
    }

    const calloutEmoji = detectCalloutEmoji(line);
    if (calloutEmoji) {
      blocks.push({
        type: "callout",
        callout: {
          icon: { type: "emoji", emoji: calloutEmoji },
          color: CALLOUT_COLOR_BY_EMOJI[calloutEmoji],
          rich_text: buildRichText(stripCalloutEmoji(line, calloutEmoji)),
        },
      });
      continue;
    }

    blocks.push({ type: "paragraph", paragraph: { rich_text: buildRichText(line) } });
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

function buildTranscriptParagraphs(transcript: IncomingTranscriptSegment[]): NotionParagraphBlock[] {
  const segments = transcript.filter(
    (segment): segment is { startMs: number; text: string } =>
      typeof segment.text === "string" && segment.text.trim().length > 0,
  );
  if (segments.length === 0) return [];

  const capped = segments.slice(0, MAX_TRANSCRIPT_PARAGRAPHS);
  const paragraphs: NotionParagraphBlock[] = capped.map((segment) => {
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

async function appendInBatches(notion: Client, blockId: string, children: BlockObjectRequest[]): Promise<void> {
  for (const batch of chunkArray(children, BLOCKS_PER_REQUEST)) {
    if (batch.length === 0) continue;
    await notion.blocks.children.append({ block_id: blockId, children: batch });
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
      : [{ type: "paragraph" as const, paragraph: { rich_text: buildRichText("상세 강의노트가 없습니다.") } }];

    // A divider + heading marks where this export starts, since we're
    // appending into a page the user already owns (and may export multiple
    // lectures into over time) rather than creating a fresh page for it.
    const bodyBlocks: BlockObjectRequest[] = [
      { type: "divider", divider: {} },
      { type: "heading_2", heading_2: { rich_text: buildRichText(`📚 ${title}`) } },
      buildSummaryCalloutBlock(summary),
      { type: "heading_3", heading_3: { rich_text: buildRichText("📖 상세 강의노트") } },
      ...lectureNoteBlocks,
      ...buildChecklistBlocks(checklist),
    ];

    // Append directly into the target page's own body (blocks.children.append
    // accepts a page ID as block_id — a page is itself a block in the API).
    await appendInBatches(notion, targetPageId, bodyBlocks);

    const transcriptParagraphs = buildTranscriptParagraphs(transcript);
    if (transcriptParagraphs.length > 0) {
      const toggleFirstBatch = transcriptParagraphs.slice(0, BLOCKS_PER_REQUEST);
      const toggleRestBatches = transcriptParagraphs.slice(BLOCKS_PER_REQUEST);
      const appended = await notion.blocks.children.append({
        block_id: targetPageId,
        children: [
          {
            type: "toggle",
            toggle: {
              rich_text: buildRichText("🎙️ 전체 스크립트 전문", true),
              children: toggleFirstBatch,
            },
          },
        ],
      });
      const toggleBlockId = appended.results[0]?.id;
      if (toggleBlockId && toggleRestBatches.length > 0) {
        await appendInBatches(notion, toggleBlockId, toggleRestBatches);
      }
    }

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

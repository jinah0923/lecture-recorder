import type { ReactNode } from "react";
import { MarkdownImage } from "@/components/MarkdownImage";
import { SlideImage } from "@/components/SlideImage";

const CALLOUT_STYLES: Array<{ emoji: string; className: string }> = [
  // Deliberately bolder than every other callout below (thicker border,
  // more saturated background, bold text) — this is the AI's "confirmed
  // exam question" marker (see the [시험 출제 신호 감지] prompt rule in
  // app/api/transcribe-and-summarize/route.ts), meant to visually outrank
  // the plain 🔥 emphasis callout, not just duplicate it in another color.
  {
    emoji: "🚨",
    className:
      "border-2 border-red-400 bg-red-100 font-semibold text-red-900 dark:border-red-500/70 dark:bg-red-950/60 dark:text-red-200",
  },
  {
    emoji: "🔥",
    className: "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300",
  },
  {
    emoji: "💡",
    className:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  },
  {
    emoji: "🗣️",
    className: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-300",
  },
  {
    emoji: "💜",
    className:
      "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900/50 dark:bg-violet-950/40 dark:text-violet-300",
  },
];

// The AI is prompted to write selective callouts as a blockquote line
// ("> 🔥 ..."), but may also emit a bare emoji-prefixed line — accept both.
function stripBlockquotePrefix(text: string): string {
  return text.replace(/^>\s*/, "");
}

function detectCallout(text: string) {
  const trimmed = stripBlockquotePrefix(text.trim());
  return CALLOUT_STYLES.find((callout) => trimmed.startsWith(callout.emoji));
}

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={index} className="font-bold text-zinc-900 dark:text-zinc-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

// Notion-style heading hierarchy — each level's size/weight/margin step down
// together so a section break (h1/h2) reads as a clear visual boundary, not
// just slightly bigger text. h1 goes all the way to pure white in dark mode
// (rather than zinc-100 like h2) so it unambiguously outranks everything
// below it.
function headingClassName(level: number) {
  if (level === 1) return "text-2xl font-extrabold mt-7 mb-3 text-zinc-900 dark:text-white";
  if (level === 2) return "text-xl font-bold mt-6 mb-2.5 text-zinc-900 dark:text-zinc-100";
  if (level === 3) return "text-lg font-semibold mt-4 mb-2 text-zinc-800 dark:text-zinc-200";
  return "text-base font-semibold mt-3 mb-1.5 text-zinc-700 dark:text-zinc-300";
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

// The AI is instructed to write `![슬라이드 N](slide_N)` right below the
// paragraph that discusses that slide — matched against the actual cached
// image via `slideImages` (page number -> data URL), passed down from
// wherever the reference PDF's pages were extracted (lib/pdfSlides.ts).
const SLIDE_IMAGE_PATTERN = /^!\[[^\]]*\]\(slide_(\d+)\)$/;

// General markdown image, e.g. an external reference image the AI cited for
// "AI 심화 탐구" (see app/api/expand-note/route.ts) — distinct from the
// slide-placeholder pattern above, which uses a local `slide_N` token
// instead of a real URL.
const IMAGE_PATTERN = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;

type FlatListItem = { depth: number; ordered: boolean; text: string };
type ListNode = FlatListItem & { children: ListNode[] };

// Turns a flat, depth-tagged run of list lines into a proper tree — each
// item's children are whatever immediately-following items sit at a
// strictly greater depth, matching standard nested-markdown-list semantics.
function buildListTree(items: FlatListItem[]): ListNode[] {
  const roots: ListNode[] = [];
  const stack: ListNode[] = [];

  for (const item of items) {
    const node: ListNode = { ...item, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) {
      stack.pop();
    }
    (stack.length === 0 ? roots : stack[stack.length - 1].children).push(node);
    stack.push(node);
  }
  return roots;
}

// Renders a tree level as one or more <ul>/<ol> — split into separate lists
// wherever the ordered/unordered marker changes, so e.g. a bullet list
// followed by a numbered list (both at the same depth) render as two
// distinct lists rather than one mismatched tag. A callout-styled item (see
// detectCallout) renders as its own bordered box instead of a plain <li>,
// consistent with how a standalone callout line renders outside a list.
function renderListNodes(nodes: ListNode[], keyPrefix: string): ReactNode[] {
  const output: ReactNode[] = [];
  let runStart = 0;
  while (runStart < nodes.length) {
    const ordered = nodes[runStart].ordered;
    let runEnd = runStart;
    while (runEnd < nodes.length && nodes[runEnd].ordered === ordered) runEnd++;
    const run = nodes.slice(runStart, runEnd);
    const Tag = ordered ? "ol" : "ul";
    const runKey = `${keyPrefix}-${runStart}`;
    output.push(
      <Tag
        key={runKey}
        className={`${ordered ? "list-decimal" : "list-disc"} ml-1 space-y-2 pl-5 marker:text-zinc-400 dark:marker:text-zinc-500`}
      >
        {run.map((node, itemIndex) => {
          const itemKey = `${runKey}-${itemIndex}`;
          const callout = detectCallout(node.text);
          const nestedList = node.children.length > 0 && (
            <div className="mt-2">{renderListNodes(node.children, itemKey)}</div>
          );
          if (callout) {
            return (
              <li key={itemIndex} className="list-none -ml-5">
                <div className={`my-4 rounded-lg border px-3 py-2 text-sm leading-[1.7] ${callout.className}`}>
                  {renderInline(stripBlockquotePrefix(node.text))}
                </div>
                {nestedList}
              </li>
            );
          }
          return (
            <li key={itemIndex} className="text-sm leading-[1.7] text-zinc-700 dark:text-zinc-300">
              {renderInline(node.text)}
              {nestedList}
            </li>
          );
        })}
      </Tag>,
    );
    runStart = runEnd;
  }
  return output;
}

export function renderMarkdown(markdown: string, slideImages?: Map<number, string>): ReactNode {
  const lines = markdown.split("\n");
  const blocks: ReactNode[] = [];
  let listBuffer: FlatListItem[] = [];
  let index = 0;

  function flushList(key: string) {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    blocks.push(<div key={`list-${key}`}>{renderListNodes(buildListTree(items), `list-${key}`)}</div>);
  }

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      flushList(String(index));
      index++;
      continue;
    }

    // <details>/<summary>...</summary>...</details> — the AI wraps
    // non-essential asides (professor bio, one-off icebreakers) in this so
    // they don't clutter the main flow; each tag must be on its own line
    // per the prompt (app/api/transcribe-and-summarize/route.ts), so this
    // only ever needs to match a bare "<details>" line, not inline HTML.
    if (line === "<details>") {
      flushList(String(index));
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
      blocks.push(
        <details
          key={index}
          className="group rounded-lg border border-slate-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-zinc-600 marker:hidden dark:text-zinc-400 [&::-webkit-details-marker]:hidden">
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5 shrink-0 stroke-current transition-transform group-open:rotate-90"
              fill="none"
              strokeWidth="2"
            >
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {summaryText}
          </summary>
          <div className="mt-2 border-t border-slate-200 pt-2 dark:border-zinc-800">
            {renderMarkdown(innerLines.join("\n").trim(), slideImages)}
          </div>
        </details>,
      );
      // cursor sits on the "</details>" line (or ran off the end if the AI
      // left it unclosed) — either way, resume just past it.
      index = cursor + 1;
      continue;
    }

    // Markdown table: a "| ... |" header row immediately followed by a separator row.
    if (line.startsWith("|") && index + 1 < lines.length && isTableSeparatorRow(lines[index + 1])) {
      flushList(String(index));
      const headerCells = splitTableRow(line);
      const bodyRows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
        bodyRows.push(splitTableRow(lines[cursor]));
        cursor++;
      }
      blocks.push(
        <div key={`table-${index}`} className="my-1 overflow-x-auto rounded-lg border border-slate-200 dark:border-zinc-800">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                {headerCells.map((cell, cellIndex) => (
                  <th
                    key={cellIndex}
                    className="border-b border-slate-200 px-3 py-1.5 font-semibold text-zinc-700 dark:border-zinc-800 dark:text-zinc-300"
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-1.5 text-zinc-600 dark:text-zinc-400">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      index = cursor;
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.*)$/);
    const orderedMatch = line.match(/^\d+[.)]\s+(.*)$/);
    if (bulletMatch || orderedMatch) {
      // Depth is read from the original (untrimmed) line's leading
      // whitespace — `line` above has already had it stripped — so a
      // sub-bullet indented under its parent renders as an actual nested
      // list rather than flattening into the same level.
      const leadingSpaces = rawLine.length - rawLine.trimStart().length;
      const depth = Math.floor(leadingSpaces / 2);
      listBuffer.push({ depth, ordered: !!orderedMatch, text: (bulletMatch ?? orderedMatch)![1] });
      index++;
      continue;
    }
    flushList(String(index));

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(
        <p key={index} className={`first:mt-0 ${headingClassName(level)}`}>
          {renderInline(headingMatch[2])}
        </p>,
      );
      index++;
      continue;
    }

    const slideMatch = line.match(SLIDE_IMAGE_PATTERN);
    if (slideMatch) {
      const page = Number(slideMatch[1]);
      blocks.push(<SlideImage key={index} page={page} dataUrl={slideImages?.get(page)} />);
      index++;
      continue;
    }

    const imageMatch = line.match(IMAGE_PATTERN);
    if (imageMatch) {
      blocks.push(<MarkdownImage key={index} alt={imageMatch[1]} src={imageMatch[2]} />);
      index++;
      continue;
    }

    const callout = detectCallout(line);
    if (callout) {
      // Greedily consume immediately-following plain lines into the same
      // callout box, so a multi-line block (title + sub-points) renders as
      // one cohesive card rather than several separate paragraphs.
      const groupLines = [stripBlockquotePrefix(line)];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const nextLine = lines[cursor].trim();
        if (!nextLine) break;
        if (/^[-*•]\s+/.test(nextLine)) break;
        if (/^\d+[.)]\s+/.test(nextLine)) break;
        if (/^#{1,4}\s+/.test(nextLine)) break;
        if (nextLine.startsWith("|")) break;
        if (SLIDE_IMAGE_PATTERN.test(nextLine) || IMAGE_PATTERN.test(nextLine)) break;
        if (detectCallout(nextLine)) break;
        groupLines.push(stripBlockquotePrefix(nextLine));
        cursor++;
      }
      blocks.push(
        <div key={index} className={`my-4 flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm leading-[1.7] ${callout.className}`}>
          {groupLines.map((groupLine, groupIndex) => (
            <p key={groupIndex}>{renderInline(groupLine)}</p>
          ))}
        </div>,
      );
      index = cursor;
      continue;
    }

    blocks.push(
      <p key={index} className="text-sm text-zinc-700 dark:text-zinc-300">
        {renderInline(line)}
      </p>,
    );
    index++;
  }

  flushList("end");
  return <div className="flex flex-col gap-1.5">{blocks}</div>;
}

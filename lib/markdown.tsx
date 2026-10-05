import { Fragment, type ReactNode } from "react";
import { MarkdownImage } from "@/components/MarkdownImage";
import { SlideImage } from "@/components/SlideImage";
import { tokenizeInline } from "@/lib/inlineMarkdown";
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
    emoji: "▲",
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300",
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

// A plain "> " quote line — anything that isn't an emoji callout or a
// formula line.
function matchPlainQuote(line: string): string | null {
  if (detectCallout(line) || matchEquationLine(line) !== null) return null;
  return matchQuoteLine(line);
}

// Notion-style formula block: a tinted, padded panel with the formula
// centered in bold, one row per `> 🧮` line. break-keep keeps Korean terms
// (자산, 부채) whole when a long formula wraps on a narrow screen.
const EQUATION_BLOCK_CLASS =
  "my-3 flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-slate-100 px-4 py-3 text-center dark:border-zinc-700 dark:bg-zinc-800/70";
const EQUATION_LINE_CLASS =
  "text-[15px] font-semibold leading-relaxed tracking-wide text-zinc-900 break-keep dark:text-zinc-50";

function renderEquationBlock(key: string | number, equations: string[]): ReactNode {
  return (
    <div key={key} role="math" className={EQUATION_BLOCK_CLASS}>
      {equations.map((equation, equationIndex) => (
        <p key={equationIndex} className={EQUATION_LINE_CLASS}>
          {renderInline(equation)}
        </p>
      ))}
    </div>
  );
}

// <mark> is the note's "형광펜" — sentences the professor or the slides
// emphasized (see the [강조 요소] rule in app/api/transcribe-and-summarize).
// Text is forced dark on both themes since it sits on a yellow fill, and
// box-decoration-clone keeps the padding/rounding on every line when a long
// highlighted sentence wraps.
function renderInline(text: string): ReactNode[] {
  return tokenizeInline(text).map((group, groupIndex) => {
    const parts = group.parts.map((part, partIndex) =>
      part.bold ? (
        <strong
          key={partIndex}
          className={group.highlight ? "font-bold" : "font-bold text-zinc-900 dark:text-zinc-100"}
        >
          {part.text}
        </strong>
      ) : (
        <Fragment key={partIndex}>{part.text}</Fragment>
      ),
    );
    return group.highlight ? (
      <mark
        key={groupIndex}
        className="rounded-sm bg-yellow-200 px-0.5 text-zinc-900 box-decoration-clone dark:bg-yellow-300/85 dark:text-zinc-950"
      >
        {parts}
      </mark>
    ) : (
      <Fragment key={groupIndex}>{parts}</Fragment>
    );
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
          const equation = matchEquationLine(node.text);
          const nestedList = node.children.length > 0 && (
            <div className="mt-2">{renderListNodes(node.children, itemKey)}</div>
          );
          if (equation !== null) {
            return (
              <li key={itemIndex} className="list-none -ml-5">
                {renderEquationBlock("equation", [equation])}
                {nestedList}
              </li>
            );
          }
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
  let listBuffer: ListLine[] = [];
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

    // Fenced code block — shown verbatim (no inline parsing), in the same
    // tinted panel style as formula blocks.
    if (isCodeFence(line)) {
      flushList(String(index));
      const { code, next } = readCodeFence(lines, index);
      blocks.push(
        <pre
          key={index}
          className="my-3 overflow-x-auto rounded-lg border border-slate-200 bg-slate-100 px-4 py-3 font-mono text-[13px] font-semibold leading-relaxed text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-100"
        >
          <code>{code}</code>
        </pre>,
      );
      index = next;
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

    // Depth comes from the original (untrimmed) line's indentation, so a
    // sub-bullet renders as an actual nested list (see parseListLine).
    const listLine = parseListLine(rawLine);
    if (listLine) {
      listBuffer.push(listLine);
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

    if (matchEquationLine(line) !== null) {
      const { items, next } = readMatchingRun(lines, index, matchEquationLine);
      blocks.push(renderEquationBlock(index, items));
      index = next;
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
        if (matchEquationLine(nextLine) !== null || isCodeFence(nextLine)) break;
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

    // Plain blockquote (no callout emoji) — previously shown with a literal
    // ">" in front. Consecutive "> " lines form one quote.
    if (matchPlainQuote(line) !== null) {
      const { items, next } = readMatchingRun(lines, index, matchPlainQuote);
      blocks.push(
        <blockquote
          key={index}
          className="my-2 flex flex-col gap-1 rounded-r-lg border-l-4 border-slate-300 bg-slate-50 px-4 py-2.5 text-sm leading-[1.7] text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-300"
        >
          {items.map((item, itemIndex) => (
            <p key={itemIndex}>{renderInline(item)}</p>
          ))}
        </blockquote>,
      );
      index = next;
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

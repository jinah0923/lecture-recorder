import type { ReactNode } from "react";

const CALLOUT_STYLES: Array<{ emoji: string; className: string }> = [
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
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

function headingClassName(level: number) {
  if (level === 1) return "text-base font-semibold text-zinc-900 dark:text-zinc-100";
  if (level === 2) return "text-sm font-semibold text-zinc-900 dark:text-zinc-100";
  return "text-sm font-medium text-zinc-700 dark:text-zinc-300";
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

export function renderMarkdown(markdown: string): ReactNode {
  const lines = markdown.split("\n");
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];
  let index = 0;

  function flushList(key: string) {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];

    if (items.some((item) => detectCallout(item))) {
      blocks.push(
        <div key={`list-${key}`} className="flex flex-col gap-1.5">
          {items.map((item, itemIndex) => {
            const callout = detectCallout(item);
            if (callout) {
              return (
                <div
                  key={itemIndex}
                  className={`rounded-lg border px-3 py-2 text-sm ${callout.className}`}
                >
                  {renderInline(item)}
                </div>
              );
            }
            return (
              <ul key={itemIndex} className="ml-4 list-disc">
                <li className="text-sm text-zinc-700 dark:text-zinc-300">{renderInline(item)}</li>
              </ul>
            );
          })}
        </div>,
      );
      return;
    }

    blocks.push(
      <ul key={`ul-${key}`} className="ml-4 list-disc space-y-1">
        {items.map((item, itemIndex) => (
          <li key={itemIndex} className="text-sm text-zinc-700 dark:text-zinc-300">
            {renderInline(item)}
          </li>
        ))}
      </ul>,
    );
  }

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      flushList(String(index));
      index++;
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
        <div key={`table-${index}`} className="my-1 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                {headerCells.map((cell, cellIndex) => (
                  <th
                    key={cellIndex}
                    className="border-b border-zinc-200 px-3 py-1.5 font-semibold text-zinc-700 dark:border-zinc-800 dark:text-zinc-300"
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
    if (bulletMatch) {
      listBuffer.push(bulletMatch[1]);
      index++;
      continue;
    }
    flushList(String(index));

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(
        <p key={index} className={`mt-3 first:mt-0 ${headingClassName(level)}`}>
          {renderInline(headingMatch[2])}
        </p>,
      );
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
        if (/^#{1,4}\s+/.test(nextLine)) break;
        if (nextLine.startsWith("|")) break;
        if (detectCallout(nextLine)) break;
        groupLines.push(stripBlockquotePrefix(nextLine));
        cursor++;
      }
      blocks.push(
        <div key={index} className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm ${callout.className}`}>
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

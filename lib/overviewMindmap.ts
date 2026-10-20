// The "전체 개요 마인드맵" at the top of every lecture note: a ```mermaid
// mindmap of the note's major topics (## ) and their subtopics (### ), placed
// before the first "## " so the note reads summary → overview map → detail.
//
// The prompt asks the model for it (OVERVIEW_MINDMAP_RULE). When the model
// leaves it out, ensureOverviewMindmap builds one from the note's own
// headings, so every note has it — and a built one is always valid syntax.

import { isCodeFence } from "@/lib/noteBlocks";

export const OVERVIEW_MINDMAP_TITLE = "**🗺️ 전체 개요 마인드맵**";

export const OVERVIEW_MINDMAP_RULE = [
  "[전체 개요 마인드맵 — 필수, 매번 생성] lectureNote의 맨 앞(`> 🔥` 핵심 단서 콜아웃이 있으면 그 바로 다음, 첫 번째 `## ` " +
    "대주제보다 앞)에 강의 전체의 뼈대를 한눈에 보여주는 마인드맵을 반드시 넣으세요. 형식은 정확히 다음과 같습니다:\n" +
    `${OVERVIEW_MINDMAP_TITLE}\n\n` +
    "```mermaid\nmindmap\n  root((강의 주제))\n    대주제 1\n      소주제 1-1\n      소주제 1-2\n    대주제 2\n      소주제 2-1\n```",
  "- 구성: root는 강의 전체 주제(짧은 핵심어). 그 아래 1단계는 이 노트의 `## ` 대주제들을 같은 순서·같은 개수로, 2단계는 " +
    "각 대주제의 주요 `### ` 소주제만 넣으세요. 세부 내용·설명 문장은 넣지 말고 핵심 주제어만 간략하게 — 전체 노드는 25개 이내.",
  "- 문법(어기면 마인드맵이 깨집니다): 첫 줄은 `mindmap`, 다음 줄은 공백 2칸 + `root((주제))`, 하위 항목은 공백 2칸씩 더 " +
    "들여써 한 줄에 하나씩. root 외의 노드 텍스트에는 괄호 ( ) [ ] { }, 큰따옴표, 콜론(:), `**`, `<mark>`, `$`를 쓰지 말고, " +
    "번호(1., 1.1)도 붙이지 말고, 각 노드는 15자 이내의 핵심어로 쓰세요.",
  "- 이 마인드맵 제목 줄은 `## ` 제목이 아니므로 대주제 개수에 포함되지 않습니다. 마인드맵은 노트 전체에서 이 위치에 한 번만 " +
    "넣으세요(본문의 도식 재현용 다이어그램과는 별개).",
].join("\n");

const MAX_TOPICS = 8;
const MAX_SUBTOPICS = 5;
const MAX_LABEL_CHARS = 24;

// A heading turned into a mindmap node: markdown, numbering and every
// character mindmap gives a meaning to (shapes, icons, classes) removed.
function nodeLabel(heading: string): string {
  const label = heading
    .replace(/<\/?mark>/g, "")
    .replace(/\*\*|__|`|\$/g, "")
    .replace(/^\s*(\d+부(-\d+)*(\.\d+)*[.:]?|\d+(\.\d+)*\.?)\s*/, "")
    .replace(/[()[\]{}<>"':;#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

type HeadingLine = { index: number; level: 2 | 3; text: string };

function readHeadings(lines: string[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  let inFence = false;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (isCodeFence(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (match) headings.push({ index, level: match[1].length <= 2 ? 2 : 3, text: match[2] });
  });
  return headings;
}

// Does the part of the note before its first major heading already hold a
// mermaid mindmap?
function hasLeadingMindmap(lines: string[], firstMajorIndex: number): boolean {
  for (let index = 0; index < firstMajorIndex; index++) {
    if (!isCodeFence(lines[index].trim()) || !/mermaid/i.test(lines[index])) continue;
    const firstCodeLine = lines.slice(index + 1, firstMajorIndex).find((line) => line.trim());
    if (firstCodeLine?.trim().startsWith("mindmap")) return true;
  }
  return false;
}

export function buildOverviewMindmap(headings: HeadingLine[], rootLabel: string): string | null {
  const topics: { label: string; subtopics: string[] }[] = [];
  for (const heading of headings) {
    const label = nodeLabel(heading.text);
    if (!label) continue;
    if (heading.level === 2) {
      if (topics.length < MAX_TOPICS) topics.push({ label, subtopics: [] });
    } else {
      const parent = topics[topics.length - 1];
      if (parent && parent.subtopics.length < MAX_SUBTOPICS) parent.subtopics.push(label);
    }
  }
  if (topics.length === 0) return null;
  const lines = ["```mermaid", "mindmap", `  root((${nodeLabel(rootLabel) || "강의 전체 개요"}))`];
  for (const topic of topics) {
    lines.push(`    ${topic.label}`);
    for (const subtopic of topic.subtopics) lines.push(`      ${subtopic}`);
  }
  lines.push("```");
  return lines.join("\n");
}

export function ensureOverviewMindmap(note: string): string {
  if (!note.trim()) return note;
  const lines = note.split("\n");
  const headings = readHeadings(lines);
  const firstMajor = headings.find((heading) => heading.level === 2);
  if (!firstMajor || hasLeadingMindmap(lines, firstMajor.index)) return note;

  const mindmap = buildOverviewMindmap(headings, "강의 전체 개요");
  if (!mindmap) return note;
  const before = lines.slice(0, firstMajor.index).join("\n").trimEnd();
  const after = lines.slice(firstMajor.index).join("\n");
  return [before, OVERVIEW_MINDMAP_TITLE, mindmap, after].filter((part) => part.length > 0).join("\n\n");
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pagination } from "@/components/Pagination";
import { renderMarkdown } from "@/lib/markdown";

type LectureNoteProps = {
  /** Full, untouched lecture-note markdown — pagination below is a pure
   * rendering concern; callers must keep using this same string (not
   * whatever page is currently shown) for copy/download/Notion export and
   * IndexedDB persistence. */
  markdown: string;
  /** Page number -> cached slide image, for `![슬라이드 N](slide_N)` placeholders. */
  slideImages?: Map<number, string>;
};

// Character-count based (not a fixed section count) so a page holds roughly
// a consistent amount of reading regardless of how verbose each section is.
const CHARS_PER_PAGE = 800;

// Splits on H1/H2 headings only ("## 1. 대주제명" is the app's convention
// for a major topic — see the transcribe-and-summarize prompt). H3 sub-
// headings stay grouped with their parent section.
function splitIntoSections(markdown: string): string[] {
  const lines = markdown.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const isMajorHeading = /^#{1,2}\s+/.test(line.trim());
    if (isMajorHeading && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));

  return sections.filter((section) => section.trim().length > 0);
}

// Accumulates whole sections onto a page until the next one would push the
// page past CHARS_PER_PAGE (counting spaces), then starts a new page — a
// section is never split mid-way, so context stays intact.
function paginate(markdown: string): string[] {
  const sections = splitIntoSections(markdown);
  if (sections.length === 0) return [""];

  const pages: string[] = [];
  let currentSections: string[] = [];
  let currentLength = 0;

  for (const section of sections) {
    if (currentSections.length > 0 && currentLength + section.length > CHARS_PER_PAGE) {
      pages.push(currentSections.join("\n\n"));
      currentSections = [];
      currentLength = 0;
    }
    currentSections.push(section);
    currentLength += section.length;
  }
  if (currentSections.length > 0) pages.push(currentSections.join("\n\n"));

  return pages;
}

export function LectureNote({ markdown, slideImages }: LectureNoteProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);

  const pages = useMemo(() => paginate(markdown), [markdown]);
  const totalPages = pages.length;

  // A fresh note (new analysis, or the user editing it back down to fewer
  // sections) should land back on page 1 rather than an out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [markdown]);

  function scrollToTop() {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    contentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function goToPage(next: number) {
    setPage(next);
    scrollToTop();
  }

  const currentMarkdown = pages[Math.min(page, totalPages) - 1] ?? "";

  return (
    <div>
      <div ref={contentRef} className="max-h-[32rem] overflow-y-auto rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
        {currentMarkdown.trim() ? (
          renderMarkdown(currentMarkdown, slideImages)
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">상세 강의노트가 없습니다.</p>
        )}
      </div>
      <Pagination page={Math.min(page, totalPages)} totalPages={totalPages} onPageChange={goToPage} onTop={scrollToTop} />
    </div>
  );
}

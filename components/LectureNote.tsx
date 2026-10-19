"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pagination } from "@/components/Pagination";
import { renderMarkdown } from "@/lib/markdown";
import { paginate } from "@/lib/notePagination";

type LectureNoteProps = {
  /** Full, untouched lecture-note markdown — pagination below is a pure
   * rendering concern; callers must keep using this same string (not
   * whatever page is currently shown) for copy/download/Notion export and
   * IndexedDB persistence. */
  markdown: string;
  /** Page number -> cached slide image, for `![슬라이드 N](slide_N)` placeholders. */
  slideImages?: Map<number, string>;
};

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

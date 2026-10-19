"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { DiagramLightbox } from "@/components/DiagramLightbox";
import { renderMermaidSvg } from "@/lib/mermaidRender";

type DiagramState = { status: "loading" } | { status: "ready"; svg: string } | { status: "error" };

// A ```mermaid block in the lecture note (lib/markdown.tsx), drawn as an SVG
// diagram. Re-renders when the light/dark theme changes. If the AI wrote
// invalid diagram syntax, the source is shown instead so nothing is lost.
export function MermaidDiagram({ code }: { code: string }) {
  const { resolvedTheme } = useTheme();
  const [state, setState] = useState<DiagramState>({ status: "loading" });
  const [zoomOpen, setZoomOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    renderMermaidSvg(code, { dark: resolvedTheme === "dark", htmlLabels: true })
      .then((svg) => {
        if (!cancelled) setState(svg ? { status: "ready", svg } : { status: "error" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [code, resolvedTheme]);

  if (state.status === "error") {
    return (
      <div className="my-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/30">
        <p className="mb-1.5 text-xs text-amber-800 dark:text-amber-300">
          ⚠️ 다이어그램 문법에 오류가 있어 원문을 표시합니다.
        </p>
        <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="my-4 flex w-full justify-center rounded-lg border border-slate-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
        <p className="py-6 text-xs text-zinc-400 dark:text-zinc-500">다이어그램을 그리는 중…</p>
      </div>
    );
  }

  // Click / tap opens the full-screen zoom viewer (components/DiagramLightbox.tsx).
  return (
    <>
      <button
        type="button"
        onClick={() => setZoomOpen(true)}
        aria-label="다이어그램 크게 보기"
        title="클릭하면 크게 볼 수 있어요"
        className="group relative my-4 flex w-full cursor-zoom-in justify-center overflow-x-auto rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-indigo-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-indigo-700"
      >
        {/* mermaid's output with securityLevel "strict" (sanitized labels, no
            links or scripts) — see lib/mermaidRender.ts. */}
        <span
          className="block max-w-full [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
        <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-zinc-900/70 px-2 py-0.5 text-[11px] font-medium text-white opacity-80 transition group-hover:opacity-100">
          🔍 크게 보기
        </span>
      </button>
      {zoomOpen && <DiagramLightbox svg={state.svg} onClose={() => setZoomOpen(false)} />}
    </>
  );
}

"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

// Full-screen viewer for a rendered ```mermaid diagram (components/
// MermaidDiagram.tsx): pinch / wheel zoom, drag to pan.
//
// Zoom changes the SVG's actual width and height — never a CSS scale() of a
// picture of it — so the browser lays the vector out again at every zoom
// level and labels stay sharp however far in you go. (Transform-based zoom
// libraries scale a rasterized layer and get blurry.) Only the pan offset is
// a transform: a translate doesn't resample anything.

type View = { scale: number; x: number; y: number };

const MIN_ZOOM_FACTOR = 0.5; // relative to the fit-to-screen scale
const MAX_SCALE = 12;
const BUTTON_ZOOM_STEP = 1.4;
const PANEL_PADDING = 16; // px around the diagram on its backdrop panel

function svgNaturalSize(svgMarkup: string): { width: number; height: number } {
  const viewBox = svgMarkup.match(/viewBox="([^"]+)"/)?.[1]?.split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  return { width: 800, height: 600 };
}

export function DiagramLightbox({ svg, onClose }: { svg: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const natural = useRef(svgNaturalSize(svg)).current;
  const [view, setView] = useState<View | null>(null);
  const fitScaleRef = useRef(1);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;

  // Active pointers on the stage, and the gesture they started.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; view: View }
    | { kind: "pinch"; startDistance: number; startMid: { x: number; y: number }; view: View }
    | null
  >(null);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);

  const clampScale = useCallback(
    (scale: number) => Math.min(Math.max(scale, fitScaleRef.current * MIN_ZOOM_FACTOR), Math.max(MAX_SCALE, fitScaleRef.current)),
    [],
  );

  const fitView = useCallback((): View | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const { width, height } = stage.getBoundingClientRect();
    const scale = Math.min(
      (width - PANEL_PADDING * 2 - 24) / natural.width,
      (height - PANEL_PADDING * 2 - 24) / natural.height,
    );
    fitScaleRef.current = scale;
    const boxWidth = natural.width * scale + PANEL_PADDING * 2;
    const boxHeight = natural.height * scale + PANEL_PADDING * 2;
    return { scale, x: (width - boxWidth) / 2, y: (height - boxHeight) / 2 };
  }, [natural]);

  // Zoom to `scale` keeping the stage point (px, py) fixed under the finger
  // or cursor.
  const zoomAt = useCallback(
    (from: View, scale: number, px: number, py: number): View => {
      const next = clampScale(scale);
      const ratio = next / from.scale;
      return {
        scale: next,
        x: px - (px - from.x - PANEL_PADDING) * ratio - PANEL_PADDING,
        y: py - (py - from.y - PANEL_PADDING) * ratio - PANEL_PADDING,
      };
    },
    [clampScale],
  );

  useLayoutEffect(() => {
    setView(fitView());
  }, [fitView]);

  // The SVG's real size follows the zoom (see the note at the top). Also
  // re-applied when the markup itself is replaced (the inline diagram
  // re-renders on a theme change while the viewer is open).
  useLayoutEffect(() => {
    const svgElement = diagramRef.current?.querySelector("svg");
    if (!svgElement || !view) return;
    svgElement.style.width = `${natural.width * view.scale}px`;
    svgElement.style.height = `${natural.height * view.scale}px`;
    svgElement.style.maxWidth = "none";
  }, [view, natural, svg]);

  // Functional updates, so quick repeated presses / wheel ticks each build
  // on the last one.
  const zoomByStep = useCallback(
    (factor: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      setView((current) => (current ? zoomAt(current, current.scale * factor, rect.width / 2, rect.height / 2) : current));
    },
    [zoomAt],
  );

  // The latest onClose without re-running the effect below on every parent
  // render (that would bounce focus and the scroll lock each time).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape / + / - / 0, page scroll locked behind the viewer, focus moved in
  // and given back to the diagram afterwards.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === "+" || event.key === "=") {
        zoomByStep(BUTTON_ZOOM_STEP);
      } else if (event.key === "-") {
        zoomByStep(1 / BUTTON_ZOOM_STEP);
      } else if (event.key === "0") {
        setView(fitView());
      }
    }
    // Capture phase, so Escape closes only this viewer and not a modal
    // underneath it (DeepDiveModal listens on window too).
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [zoomByStep, fitView]);

  // Wheel / trackpad pinch zoom — a non-passive listener so the page itself
  // doesn't scroll or browser-zoom.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setView((current) => (current ? zoomAt(current, current.scale * factor, px, py) : current));
    }
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [zoomAt]);

  function stagePoint(event: ReactPointerEvent) {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function beginGesture() {
    const current = viewRef.current;
    if (!current) return;
    const points = Array.from(pointers.current.values());
    if (points.length >= 2) {
      const [a, b] = points;
      gesture.current = {
        kind: "pinch",
        startDistance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: current,
      };
    } else if (points.length === 1) {
      gesture.current = { kind: "pan", startX: points[0].x, startY: points[0].y, view: current };
    } else {
      gesture.current = null;
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    // Keeps the gesture going when a finger leaves the stage; a pointer the
    // browser can't capture just isn't, rather than breaking the gesture.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const point = stagePoint(event);
    pointers.current.set(event.pointerId, point);
    beginGesture();

    // Double tap / double click: zoom in 2x there, or back to fit when
    // already zoomed in.
    const now = Date.now();
    const previous = lastTap.current;
    if (pointers.current.size === 1 && previous && now - previous.time < 300 && Math.hypot(point.x - previous.x, point.y - previous.y) < 30) {
      const current = viewRef.current;
      if (current) {
        setView(current.scale > fitScaleRef.current * 1.05 ? fitView() : zoomAt(current, current.scale * 2, point.x, point.y));
      }
      lastTap.current = null;
      gesture.current = null;
    } else {
      lastTap.current = { time: now, x: point.x, y: point.y };
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, stagePoint(event));
    const active = gesture.current;
    if (!active) return;
    const points = Array.from(pointers.current.values());
    if (active.kind === "pan" && points.length === 1) {
      setView({
        ...active.view,
        x: active.view.x + points[0].x - active.startX,
        y: active.view.y + points[0].y - active.startY,
      });
    } else if (active.kind === "pinch" && points.length >= 2) {
      const [a, b] = points;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Zoom about where the pinch started, then follow the fingers' drift.
      const zoomed = zoomAt(active.view, active.view.scale * (distance / active.startDistance), active.startMid.x, active.startMid.y);
      setView({ ...zoomed, x: zoomed.x + mid.x - active.startMid.x, y: zoomed.y + mid.y - active.startMid.y });
    }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    // Lifting one finger of a pinch continues as a pan with the other.
    beginGesture();
  }

  const percent = view ? Math.round((view.scale / fitScaleRef.current) * 100) : 100;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col bg-black/95" role="dialog" aria-modal="true" aria-label="다이어그램 크게 보기">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-white safe-pt">
        <p className="min-w-0 truncate text-xs text-white/70">
          핀치·휠로 확대/축소, 드래그로 이동, 두 번 탭하면 확대/맞춤
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => zoomByStep(1 / BUTTON_ZOOM_STEP)}
            aria-label="축소"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg transition hover:bg-white/20"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => setView(fitView())}
            aria-label="화면에 맞추기"
            className="h-9 min-w-[3.5rem] rounded-full bg-white/10 px-2 text-xs tabular-nums transition hover:bg-white/20"
          >
            {percent}%
          </button>
          <button
            type="button"
            onClick={() => zoomByStep(BUTTON_ZOOM_STEP)}
            aria-label="확대"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg transition hover:bg-white/20"
          >
            +
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="ml-1 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 transition hover:bg-white/20"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="relative flex-1 cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {view && (
          <div
            className="absolute left-0 top-0 rounded-xl bg-white shadow-2xl dark:bg-zinc-900"
            style={{ transform: `translate(${view.x}px, ${view.y}px)`, padding: PANEL_PADDING }}
          >
            {/* Same sanitized mermaid output as the inline diagram. */}
            <div ref={diagramRef} className="[&_svg]:block" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

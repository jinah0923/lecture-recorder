"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatDateTime, formatDuration } from "@/lib/format";
import type { LectureSessionSummary } from "@/lib/types";

type CategoryListViewProps = {
  category: string;
  sessions: LectureSessionSummary[];
  onSelectSession: (session: LectureSessionSummary) => void;
  onDeleteSession: (id: string) => void;
  onNewRecording: () => void;
  onReorderSession: (id: string, sortOrder: number) => void;
};

// Sort positions default to Date.now()-scale numbers (see lib/db.ts's
// effectiveSortOrder), so a one-day gap is comfortably larger than any
// realistic difference between two sessions' timestamps — moving an item to
// an edge lands it clear of its new neighbor with plenty of room for more
// edge inserts later, without needing to renumber anything else.
const EDGE_GAP = 24 * 60 * 60 * 1000;

function SortableSessionItem({
  session,
  onSelectSession,
  onDeleteSession,
}: {
  session: LectureSessionSummary;
  onSelectSession: (session: LectureSessionSummary) => void;
  onDeleteSession: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1 rounded-2xl border border-slate-200 bg-slate-50 px-2 py-3 shadow-sm transition-colors dark:border-zinc-800 dark:bg-zinc-900 ${
        isDragging
          ? "border-indigo-300 shadow-xl dark:border-indigo-700"
          : "hover:border-indigo-200 dark:hover:border-indigo-900"
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="드래그해서 순서 변경"
        title="꾹 눌러서 순서 변경"
        className="flex h-11 w-8 shrink-0 touch-none items-center justify-center rounded-lg text-zinc-300 transition hover:bg-zinc-100 hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-400"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
          <circle cx="9" cy="6" r="1.5" />
          <circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" />
          <circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" />
          <circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>
      <button type="button" onClick={() => onSelectSession(session)} className="min-w-0 flex-1 px-2 py-1 text-left">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{session.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{formatDateTime(session.updatedAt)}</span>
          <span>·</span>
          <span className="font-mono">{formatDuration(session.durationMs)}</span>
          {session.hasAiResult && (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
              요약 완료
            </span>
          )}
        </p>
      </button>
      <button
        type="button"
        onClick={() => onDeleteSession(session.id)}
        aria-label="녹음 삭제"
        className="shrink-0 rounded-full p-1.5 text-zinc-400 transition hover:bg-red-50 hover:text-red-500 dark:text-zinc-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path
            d="M6 7h12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </li>
  );
}

export function CategoryListView({
  category,
  sessions,
  onSelectSession,
  onDeleteSession,
  onNewRecording,
  onReorderSession,
}: CategoryListViewProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // Mobile needs a deliberate press-and-hold before a drag starts — without
    // a delay, the very first touch-move of an ordinary tap-to-open or a
    // list scroll would get misread as a drag. tolerance allows a few
    // pixels of finger wobble during that hold without cancelling it.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sessions.findIndex((session) => session.id === active.id);
    const newIndex = sessions.findIndex((session) => session.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(sessions, oldIndex, newIndex);
    const before = reordered[newIndex - 1];
    const after = reordered[newIndex + 1];

    let nextSortOrder: number;
    if (before && after) {
      nextSortOrder = (before.sortOrder + after.sortOrder) / 2;
    } else if (before) {
      nextSortOrder = before.sortOrder - EDGE_GAP;
    } else if (after) {
      nextSortOrder = after.sortOrder + EDGE_GAP;
    } else {
      nextSortOrder = Date.now();
    }

    onReorderSession(String(active.id), nextSortOrder);
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onNewRecording}
          className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          + &apos;{category}&apos;에 새 녹음
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-16 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">아직 녹음이 없어요</p>
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">이 카테고리에 첫 녹음을 추가해보세요</p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sessions.map((session) => session.id)} strategy={verticalListSortingStrategy}>
            <ul className="flex flex-col gap-2">
              {sessions.map((session) => (
                <SortableSessionItem
                  key={session.id}
                  session={session}
                  onSelectSession={onSelectSession}
                  onDeleteSession={onDeleteSession}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

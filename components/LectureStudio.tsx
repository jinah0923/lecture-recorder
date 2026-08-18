"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AddCategoryModal } from "@/components/AddCategoryModal";
import { AlbumView } from "@/components/AlbumView";
import { CategoryListView } from "@/components/CategoryListView";
import { NewRecordingView } from "@/components/NewRecordingView";
import { RecordingDetailView } from "@/components/RecordingDetailView";
import { WeeklyChecklist } from "@/components/WeeklyChecklist";
import {
  deleteSession,
  listAllChecklistItems,
  listSessions,
  loadCategories,
  saveCategories,
  toggleSessionChecklistItem,
} from "@/lib/db";
import type { ChecklistFeedItem, LectureSessionSummary, SessionAudio } from "@/lib/types";

type Screen =
  | { kind: "albums" }
  | { kind: "category"; category: string }
  | { kind: "record"; sessionId: string; category: string }
  | { kind: "detail"; sessionId: string };

export function LectureStudio() {
  const [screenStack, setScreenStack] = useState<Screen[]>([{ kind: "albums" }]);
  const screen = screenStack[screenStack.length - 1];

  const [sessions, setSessions] = useState<LectureSessionSummary[]>([]);
  const [categories, setCategories] = useState<string[]>(["일반"]);
  const [checklistFeed, setChecklistFeed] = useState<ChecklistFeedItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [handoffAudio, setHandoffAudio] = useState<{ sessionId: string; audio: SessionAudio } | null>(
    null,
  );

  const refreshSessions = useCallback(() => {
    listSessions().then(setSessions).catch(() => {});
  }, []);

  const refreshChecklistFeed = useCallback(() => {
    listAllChecklistItems().then(setChecklistFeed).catch(() => {});
  }, []);

  const refreshAll = useCallback(() => {
    refreshSessions();
    refreshChecklistFeed();
  }, [refreshSessions, refreshChecklistFeed]);

  const handleCategoryCreated = useCallback((name: string) => {
    setCategories((prev) => {
      if (prev.includes(name)) return prev;
      const next = [...prev, name];
      saveCategories(next).catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    Promise.all([loadCategories(), listSessions(), listAllChecklistItems()]).then(
      ([savedCategories, sessionList, checklist]) => {
        if (savedCategories.length > 0) {
          setCategories((prev) => Array.from(new Set([...prev, ...savedCategories])));
        }
        setSessions(sessionList);
        setChecklistFeed(checklist);
        setLoaded(true);
      },
    );
  }, []);

  const categorySummaries = useMemo(() => {
    const map = new Map<string, { count: number; updatedAt: number }>();
    for (const name of categories) map.set(name, { count: 0, updatedAt: 0 });
    for (const session of sessions) {
      const entry = map.get(session.category) ?? { count: 0, updatedAt: 0 };
      entry.count += 1;
      entry.updatedAt = Math.max(entry.updatedAt, session.updatedAt);
      map.set(session.category, entry);
    }
    return Array.from(map.entries())
      .map(([name, info]) => ({ name, ...info }))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }, [categories, sessions]);

  function navigateTo(next: Screen) {
    setScreenStack((stack) => [...stack, next]);
  }

  function replaceScreen(next: Screen) {
    setScreenStack((stack) => [...stack.slice(0, -1), next]);
  }

  function goBack() {
    setScreenStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
  }

  function handleNewRecording(presetCategory: string) {
    const id = crypto.randomUUID();
    navigateTo({ kind: "record", sessionId: id, category: presetCategory });
  }

  function handleSelectCategory(name: string) {
    navigateTo({ kind: "category", category: name });
  }

  function handleSelectSession(session: LectureSessionSummary) {
    navigateTo({ kind: "detail", sessionId: session.id });
  }

  function handleDeleteSession(id: string) {
    deleteSession(id).then(refreshAll).catch(() => {});
  }

  function handleSubmitCategory(name: string) {
    handleCategoryCreated(name);
    setShowAddCategory(false);
  }

  function handleToggleChecklistItem(sessionId: string, itemId: string) {
    setChecklistFeed((prev) =>
      prev.map((item) =>
        item.sessionId === sessionId && item.id === itemId ? { ...item, done: !item.done } : item,
      ),
    );
    toggleSessionChecklistItem(sessionId, itemId)
      .then(refreshSessions)
      .catch(() => refreshChecklistFeed());
  }

  const headerTitle = useMemo(() => {
    if (screen.kind === "albums") return "카테고리";
    if (screen.kind === "category") return screen.category;
    if (screen.kind === "record") return "새 녹음";
    return "복습";
  }, [screen]);

  if (!loaded) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-400">
        불러오는 중...
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-5xl flex-col">
        {screen.kind !== "detail" && (
          <header className="mb-5 flex items-center gap-3">
            {screen.kind !== "albums" && (
              <button
                type="button"
                onClick={goBack}
                aria-label="뒤로가기"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-600 transition hover:bg-zinc-100"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                Lecture studio
              </p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-zinc-900">
                {headerTitle}
              </h1>
            </div>
          </header>
        )}

        {screen.kind === "albums" && (
          <div className="flex flex-col gap-6">
            <AlbumView
              categories={categorySummaries}
              onSelectCategory={handleSelectCategory}
              onAddCategory={() => setShowAddCategory(true)}
            />
            <WeeklyChecklist
              items={checklistFeed}
              onToggle={handleToggleChecklistItem}
              onNavigateToSession={(sessionId) => navigateTo({ kind: "detail", sessionId })}
            />
          </div>
        )}

        {screen.kind === "category" && (
          <CategoryListView
            category={screen.category}
            sessions={sessions.filter((session) => session.category === screen.category)}
            onSelectSession={handleSelectSession}
            onDeleteSession={handleDeleteSession}
            onNewRecording={() => handleNewRecording(screen.category)}
          />
        )}

        {screen.kind === "record" && (
          <NewRecordingView
            key={screen.sessionId}
            sessionId={screen.sessionId}
            initialCategory={screen.category}
            categories={categories}
            onCategoryCreated={handleCategoryCreated}
            onCreated={(_category, audio) => {
              setHandoffAudio({ sessionId: screen.sessionId, audio });
              refreshAll();
              replaceScreen({ kind: "detail", sessionId: screen.sessionId });
            }}
          />
        )}

        {screen.kind === "detail" && (
          <RecordingDetailView
            key={screen.sessionId}
            sessionId={screen.sessionId}
            categories={categories}
            onCategoryCreated={handleCategoryCreated}
            onBack={goBack}
            onSessionSaved={refreshAll}
            initialAudio={
              handoffAudio?.sessionId === screen.sessionId ? handoffAudio.audio : undefined
            }
          />
        )}
      </div>

      {showAddCategory && (
        <AddCategoryModal
          existingCategories={categories}
          onSubmit={handleSubmitCategory}
          onClose={() => setShowAddCategory(false)}
        />
      )}
    </div>
  );
}

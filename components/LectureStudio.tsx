"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { AddCategoryModal } from "@/components/AddCategoryModal";
import { AlbumView } from "@/components/AlbumView";
import { CategoryListView } from "@/components/CategoryListView";
import { NewRecordingView } from "@/components/NewRecordingView";
import { RecordingDetailView } from "@/components/RecordingDetailView";
import { TrashModal } from "@/components/TrashModal";
import { WeeklyChecklist } from "@/components/WeeklyChecklist";
import { purgeSessionBlobs } from "@/lib/blobUpload";
import {
  compareBySortOrder,
  listAllChecklistItems,
  listDeletedSessions,
  listSessions,
  loadCategories,
  permanentlyDeleteSession,
  purgeExpiredTrash,
  reorderSession,
  restoreSession,
  saveCategories,
  softDeleteSession,
  toggleSessionChecklistItem,
} from "@/lib/db";
import { mergeAndSync, pushLocalSessions } from "@/lib/sync";
import type { ChecklistFeedItem, LectureSession, LectureSessionSummary, SessionAudio } from "@/lib/types";

function blobCleanupTexts(sessions: Array<LectureSession | null>): string[] {
  return sessions.flatMap((session) => (session?.aiResult ? [session.aiResult.lectureNote, session.aiResult.summary] : []));
}

type Screen =
  | { kind: "albums" }
  | { kind: "category"; category: string }
  | { kind: "record"; sessionId: string; category: string }
  | { kind: "detail"; sessionId: string };

export function LectureStudio() {
  const { status: authStatus } = useSession();
  const [screenStack, setScreenStack] = useState<Screen[]>([{ kind: "albums" }]);
  const screen = screenStack[screenStack.length - 1];

  const [sessions, setSessions] = useState<LectureSessionSummary[]>([]);
  const [trashedSessions, setTrashedSessions] = useState<LectureSessionSummary[]>([]);
  const [categories, setCategories] = useState<string[]>(["일반"]);
  const [checklistFeed, setChecklistFeed] = useState<ChecklistFeedItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [handoffAudio, setHandoffAudio] = useState<{ sessionId: string; audio: SessionAudio } | null>(
    null,
  );

  const refreshSessions = useCallback(() => {
    listSessions().then(setSessions).catch(() => {});
  }, []);

  const refreshTrash = useCallback(() => {
    listDeletedSessions().then(setTrashedSessions).catch(() => {});
  }, []);

  const refreshChecklistFeed = useCallback(() => {
    listAllChecklistItems().then(setChecklistFeed).catch(() => {});
  }, []);

  const refreshAll = useCallback(() => {
    refreshSessions();
    refreshTrash();
    refreshChecklistFeed();
    // The edit that triggered this refresh is already the newest version of
    // whatever changed, so this only needs to push it — pulling the cloud
    // first would just be a redundant round trip. See lib/sync.ts.
    if (authStatus === "authenticated") pushLocalSessions().catch(() => {});
  }, [refreshSessions, refreshTrash, refreshChecklistFeed, authStatus]);

  // Deletion needs a stronger guarantee than refreshAll's fire-and-forget
  // push: the whole point of moving to trash is that it takes effect
  // immediately and consistently on both sides, not "eventually, assuming
  // the tab stays open long enough for the background push to land" — a
  // refresh in that gap is exactly what used to bring a deleted session back
  // (mergeAndSync's union merge would still see the old cloud copy and
  // restore it locally). Awaiting the push here closes that window for the
  // device doing the deleting; lib/sync.ts's own isTrashExpired check is
  // what protects every other device against a stale copy of THIS session.
  const syncNow = useCallback(async () => {
    if (authStatus !== "authenticated") return;
    await pushLocalSessions().catch(() => {});
  }, [authStatus]);

  const handleCategoryCreated = useCallback((name: string) => {
    setCategories((prev) => {
      if (prev.includes(name)) return prev;
      const next = [...prev, name];
      saveCategories(next).catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    // Auto Purge — runs once up front so a trashed session past its 30-day
    // retention never actually renders in the trash list, rather than
    // waiting for someone to notice and clean it up manually.
    purgeExpiredTrash().then((purged) => {
      if (purged.length > 0) void purgeSessionBlobs(blobCleanupTexts(purged));
      Promise.all([loadCategories(), listSessions(), listDeletedSessions(), listAllChecklistItems()]).then(
        ([savedCategories, sessionList, trashList, checklist]) => {
          if (savedCategories.length > 0) {
            setCategories((prev) => Array.from(new Set([...prev, ...savedCategories])));
          }
          setSessions(sessionList);
          setTrashedSessions(trashList);
          setChecklistFeed(checklist);
          setLoaded(true);
        },
      );
    });
  }, []);

  // Runs whenever auth status resolves to "authenticated" — both right after
  // a fresh Google sign-in and on a later visit where this device is still
  // signed in — pulling whatever changed on other devices since last time
  // and merging it in. Local data above isn't gated on this; the screen
  // refreshes once the merge lands. mergeAndSync (lib/sync.ts) re-applies the
  // same 30-day trash expiry during the merge itself, so a stale "not yet
  // expired" copy from the cloud can't undo this device's own auto-purge
  // above just because the two effects race.
  useEffect(() => {
    if (authStatus !== "authenticated") return;
    mergeAndSync()
      .then(() => {
        refreshSessions();
        refreshTrash();
        refreshChecklistFeed();
      })
      .catch(() => {});
  }, [authStatus, refreshSessions, refreshTrash, refreshChecklistFeed]);

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

  async function handleMoveToTrash(id: string) {
    await softDeleteSession(id);
    refreshSessions();
    refreshTrash();
    refreshChecklistFeed();
    await syncNow();
  }

  async function handleRestoreSession(id: string) {
    await restoreSession(id);
    refreshSessions();
    refreshTrash();
    refreshChecklistFeed();
    await syncNow();
  }

  async function handlePermanentDeleteSession(id: string) {
    if (!window.confirm("이 녹음을 영구적으로 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;
    const removed = await permanentlyDeleteSession(id);
    if (removed) void purgeSessionBlobs(blobCleanupTexts([removed]));
    refreshTrash();
    await syncNow();
  }

  // Optimistic — the reordered position shows immediately (dnd-kit already
  // visually settled it before this even fires), IndexedDB and the cloud
  // catch up right after rather than gating the UI on either round trip.
  async function handleReorderSession(id: string, sortOrder: number) {
    const now = Date.now();
    setSessions((prev) =>
      prev.map((session) => (session.id === id ? { ...session, sortOrder, updatedAt: now } : session)).sort(compareBySortOrder),
    );
    await reorderSession(id, sortOrder);
    await syncNow();
  }

  async function handleEmptyTrash() {
    if (trashedSessions.length === 0) return;
    if (
      !window.confirm(
        `휴지통에 있는 ${trashedSessions.length}개 항목을 모두 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.`,
      )
    ) {
      return;
    }
    const removed = await Promise.all(trashedSessions.map((session) => permanentlyDeleteSession(session.id)));
    void purgeSessionBlobs(blobCleanupTexts(removed));
    refreshTrash();
    await syncNow();
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
    <div className="header-safe-pt min-h-screen px-4 pb-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-5xl flex-col">
        {screen.kind !== "detail" && (
          <header className="mb-5 flex items-center gap-3">
            {screen.kind !== "albums" && (
              <button
                type="button"
                onClick={goBack}
                aria-label="뒤로가기"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
                Lecture studio
              </p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
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
              onOpenTrash={() => setShowTrash(true)}
              trashCount={trashedSessions.length}
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
            onDeleteSession={handleMoveToTrash}
            onNewRecording={() => handleNewRecording(screen.category)}
            onReorderSession={handleReorderSession}
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

      {showTrash && (
        <TrashModal
          items={trashedSessions}
          onRestore={handleRestoreSession}
          onPermanentDelete={handlePermanentDeleteSession}
          onEmptyTrash={handleEmptyTrash}
          onClose={() => setShowTrash(false)}
        />
      )}
    </div>
  );
}

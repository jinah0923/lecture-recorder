"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [showExitToast, setShowExitToast] = useState(false);

  // popstate's handler is registered once (see the effect below) and would
  // otherwise close over the screenStack from that first render — this
  // keeps it reading the live value without re-subscribing the listener on
  // every navigation.
  const screenStackRef = useRef(screenStack);
  useEffect(() => {
    screenStackRef.current = screenStack;
  }, [screenStack]);

  const exitArmedRef = useRef(false);
  const exitTimerRef = useRef<number | null>(null);

  // Wires the physical/gesture back action (Android's system back button, a
  // browser's back swipe) to this app's own screen stack instead of leaving
  // popstate to fall through to whatever the browser would otherwise do
  // (navigate away from the PWA / close it outright with no warning).
  // navigateTo/replaceScreen below push a matching history entry per screen
  // level, so popstate firing one level "back" in real browser history
  // lines up with popping exactly one level off screenStack.
  useEffect(() => {
    window.history.replaceState({ lectureRecorderScreen: true }, "", window.location.href);
    // A single tagged entry isn't enough on its own: on a genuinely fresh
    // launch with no in-app navigation yet, that's the ONLY entry this
    // document owns, so the very first back press would go straight past
    // it to whatever real page/state came before this app ever loaded —
    // a cross-document navigation, which never fires popstate at all (it
    // can't be intercepted after the fact). Pushing one extra self-referential
    // entry right away guarantees the first-ever back press still lands on
    // a same-document state (this one), which DOES fire popstate — giving
    // the handler below a chance to run before anything real happens.
    window.history.pushState({ lectureRecorderScreen: true }, "", window.location.href);

    function handlePopState() {
      if (screenStackRef.current.length > 1) {
        setScreenStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
        return;
      }

      // Already at the root ("카테고리") screen — this popstate is the
      // browser having just navigated back one entry, which would otherwise
      // exit the app outright. First press: cancel that by immediately
      // pushing the entry right back, and show the "한 번 더 누르면
      // 종료" warning instead. Second press within the window: actually
      // exit — see below for why that needs one more explicit back() call,
      // not just leaving this popstate's own consumption alone.
      if (exitArmedRef.current) {
        if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
        exitArmedRef.current = false;
        setShowExitToast(false);
        // This popstate only consumed the single buffer entry the first
        // press pushed — from the user's perspective that's invisible (same
        // screen, nothing to see), not an actual exit. One more back() is
        // what actually reaches (or, if this app truly owns the bottom of
        // the stack, re-attempts past) a real exit: in a standalone/TWA PWA
        // this is the signal that tells the native shell the web history is
        // now exhausted and it should finish the activity, rather than the
        // app just quietly sitting on an empty back-stack until a third
        // press. Harmless no-op if there's genuinely nothing left.
        window.history.back();
        return;
      }

      exitArmedRef.current = true;
      setShowExitToast(true);
      window.history.pushState({ lectureRecorderScreen: true }, "", window.location.href);
      exitTimerRef.current = window.setTimeout(() => {
        exitArmedRef.current = false;
        setShowExitToast(false);
      }, 2000);
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    };
  }, []);

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
    // One real history entry per screen level, so a later physical/gesture
    // back press (popstate — see the effect above) has something to walk
    // back through one level at a time, matching screenStack's own depth.
    window.history.pushState({ lectureRecorderScreen: true }, "", window.location.href);
  }

  function replaceScreen(next: Screen) {
    setScreenStack((stack) => [...stack.slice(0, -1), next]);
    // Doesn't grow the stack, so it shouldn't grow browser history either —
    // e.g. finishing a new recording swaps "record" for "detail" in place;
    // back from there should return to the category list, not to the
    // now-irrelevant in-progress recording screen.
    window.history.replaceState({ lectureRecorderScreen: true }, "", window.location.href);
  }

  // Routed through the browser's own back navigation rather than popping
  // screenStack directly, so an in-app back button and the physical/gesture
  // back action both end up going through the exact same popstate handler
  // above — one code path, instead of two that could drift out of sync.
  function goBack() {
    window.history.back();
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
          // The back button sits alone on its own row and the title block
          // is always stacked below it, rather than side-by-side in one
          // row — a long category name in a side-by-side layout could grow
          // wide enough to reach the top-center area where iPadOS floats
          // its Split View "..." multitasking pill, and no amount of
          // truncation tuning guarantees that never happens across every
          // title length/viewport width. Stacking rules it out structurally:
          // nothing in this header is ever positioned anywhere but the far
          // left, full stop.
          <header className="mb-5">
            {screen.kind !== "albums" && (
              <button
                type="button"
                onClick={goBack}
                aria-label="뒤로가기"
                title="뒤로가기"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <div className={`min-w-0 ${screen.kind !== "albums" ? "mt-4" : ""}`}>
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

      {showExitToast && (
        <div className="safe-pb fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <p className="rounded-full bg-zinc-900/95 px-4 py-3 text-center text-sm text-white shadow-lg dark:bg-zinc-800/95">
            뒤로가기 버튼을 한 번 더 누르면 앱이 종료됩니다.
          </p>
        </div>
      )}
    </div>
  );
}

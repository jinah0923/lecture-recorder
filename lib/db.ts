import type { ChecklistFeedItem, LectureSession, LectureSessionSummary, SessionAudio, SlideImage } from "@/lib/types";

const DB_NAME = "lecture-recorder";
const DB_VERSION = 3;
const SESSION_STORE = "session";
const CATEGORY_STORE = "categories";
// Kept separate from SESSION_STORE — slide images are meaningfully larger
// than the rest of a session's data, so they get their own store rather
// than bloating every session read with image payloads it may not need.
const SLIDE_IMAGE_STORE = "slideImages";
// A temporary cache of the in-progress recording's audio Blob, keyed by
// sessionId — separate from SESSION_STORE (which never persists the blob
// itself, only metadata like audioFileName) so this can be cleared
// independently the moment it's no longer needed (see deleteCachedAudioBlob)
// without touching the session row at all. Exists purely to survive a
// refresh/background-kill mid-analysis; not a permanent audio store — see
// RecordingDetailView.tsx, which clears it once analysis fully completes.
const AUDIO_CACHE_STORE = "audioCache";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CATEGORY_STORE)) {
        db.createObjectStore(CATEGORY_STORE, { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains(SLIDE_IMAGE_STORE)) {
        db.createObjectStore(SLIDE_IMAGE_STORE, { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains(AUDIO_CACHE_STORE)) {
        db.createObjectStore(AUDIO_CACHE_STORE, { keyPath: "sessionId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const request = work(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

export async function saveSession(session: LectureSession): Promise<void> {
  await runTransaction(SESSION_STORE, "readwrite", (store) => store.put(session));
}

export async function loadSessionById(id: string): Promise<LectureSession | null> {
  const result = await runTransaction<LectureSession | undefined>(SESSION_STORE, "readonly", (store) =>
    store.get(id),
  );
  return result ?? null;
}

// Soft delete — the everyday "delete" action (CategoryListView's trash icon)
// moves a session to trash rather than removing it. See permanentlyDeleteSession
// below for the real, irreversible removal (individual "영구 삭제" / "휴지통
// 비우기" / the 30-day auto-purge in purgeExpiredTrash). Bumping updatedAt
// alongside deletedAt is what makes this correctly win a cross-device merge
// (lib/sync.ts) even against a stale "still active" copy from another
// device that hasn't seen the deletion yet.
export async function softDeleteSession(id: string): Promise<void> {
  const session = await loadSessionById(id);
  if (!session) return;
  const now = Date.now();
  await saveSession({ ...session, deletedAt: now, updatedAt: now });
}

export async function restoreSession(id: string): Promise<void> {
  const session = await loadSessionById(id);
  if (!session) return;
  await saveSession({ ...session, deletedAt: null, updatedAt: Date.now() });
}

// Irreversible — actually removes the row (and its slide images) rather
// than flagging it. Returns the removed session (if it existed) so the
// caller can find and clean up anything that outlives the IndexedDB row
// itself, e.g. the permanently-hosted "AI 심화 탐구" image blobs embedded
// in aiResult.lectureNote (see lib/blobUpload.ts's purgeSessionBlobs and
// app/api/purge-blobs/route.ts).
export async function permanentlyDeleteSession(id: string): Promise<LectureSession | null> {
  const session = await loadSessionById(id);
  await runTransaction(SESSION_STORE, "readwrite", (store) => store.delete(id));
  await deleteSlideImages(id);
  await deleteCachedAudioBlob(id);
  return session;
}

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Exported so lib/sync.ts's mergeAndSync can apply the same 30-day rule to a
// session that comes back from the cloud during a merge — a plain "purge on
// load" pass alone isn't enough, since a stale cloud copy of an
// already-locally-purged session would otherwise get merged straight back in
// (same class of resurrection bug deletedAt itself exists to fix, just for
// the expiry case specifically).
export function isTrashExpired(session: LectureSession): boolean {
  return Boolean(session.deletedAt) && Date.now() - (session.deletedAt as number) > TRASH_RETENTION_MS;
}

// Sweeps every session that's been in trash for more than 30 days and
// permanently removes it — the "Auto Purge" half of the trash feature.
// Meant to be called wherever trashed sessions get read (app load, opening
// the trash view) so an expired item never actually renders to the user,
// rather than running on a schedule.
export async function purgeExpiredTrash(): Promise<LectureSession[]> {
  const all = await loadAllSessions();
  const expired = all.filter(isTrashExpired);
  await Promise.all(expired.map((session) => runTransaction(SESSION_STORE, "readwrite", (store) => store.delete(session.id))));
  await Promise.all(expired.map((session) => deleteSlideImages(session.id)));
  return expired;
}

// A session saved before drag-to-reorder existed has no sortOrder at all —
// falling back to updatedAt (same units/direction: higher sorts first)
// means a category nobody has ever manually reordered looks exactly like it
// did before this feature existed, rather than jumping to some arbitrary
// order the first time these rows are read.
function effectiveSortOrder(row: LectureSession | LectureSessionSummary): number {
  return row.sortOrder ?? row.updatedAt;
}

// Exported so components/LectureStudio.tsx can re-sort its in-memory
// summaries the exact same way after an optimistic drag-reorder update,
// instead of duplicating (and risking drifting from) this comparator.
export function compareBySortOrder(a: LectureSessionSummary, b: LectureSessionSummary): number {
  return effectiveSortOrder(b) - effectiveSortOrder(a) || b.updatedAt - a.updatedAt;
}

function toSummary(row: LectureSession): LectureSessionSummary {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    updatedAt: row.updatedAt,
    durationMs: row.durationMs ?? 0,
    hasAiResult: Boolean(row.aiResult),
    deletedAt: row.deletedAt ?? null,
    sortOrder: effectiveSortOrder(row),
  };
}

// Sets a session's manual sort position — see lib/types.ts's sortOrder for
// the gap-based scheme (components/CategoryListView.tsx computes the actual
// midpoint/edge value; this just persists whatever it decided). Bumping
// updatedAt alongside it is what makes the new position survive a
// cross-device merge (lib/sync.ts) the same way every other field edit
// already does.
export async function reorderSession(id: string, sortOrder: number): Promise<void> {
  const session = await loadSessionById(id);
  if (!session) return;
  await saveSession({ ...session, sortOrder, updatedAt: Date.now() });
}

export async function listSessions(): Promise<LectureSessionSummary[]> {
  const db = await openDb();
  return new Promise<LectureSessionSummary[]>((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readonly");
    const store = tx.objectStore(SESSION_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const rows = request.result as LectureSession[];
      const summaries = rows.filter((row) => !row.deletedAt).map(toSummary).sort(compareBySortOrder);
      resolve(summaries);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

// Trash view's own listing — the mirror image of listSessions() above.
export async function listDeletedSessions(): Promise<LectureSessionSummary[]> {
  const db = await openDb();
  return new Promise<LectureSessionSummary[]>((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readonly");
    const store = tx.objectStore(SESSION_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const rows = request.result as LectureSession[];
      const summaries = rows
        .filter((row) => !!row.deletedAt)
        .map(toSummary)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
      resolve(summaries);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

// Full records, unlike listSessions()'s summaries — needed wherever the
// complete aiResult must round-trip somewhere else (e.g. cloud sync).
export async function loadAllSessions(): Promise<LectureSession[]> {
  const db = await openDb();
  return new Promise<LectureSession[]>((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readonly");
    const store = tx.objectStore(SESSION_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as LectureSession[]);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function listAllChecklistItems(): Promise<ChecklistFeedItem[]> {
  const db = await openDb();
  return new Promise<ChecklistFeedItem[]>((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readonly");
    const store = tx.objectStore(SESSION_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const rows = request.result as LectureSession[];
      const items: ChecklistFeedItem[] = [];
      for (const row of rows) {
        if (!row.aiResult || row.deletedAt) continue;
        for (const item of row.aiResult.checklist) {
          items.push({
            ...item,
            sessionId: row.id,
            sessionTitle: row.title,
            category: row.category,
          });
        }
      }
      resolve(items);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function toggleSessionChecklistItem(sessionId: string, itemId: string): Promise<void> {
  const session = await loadSessionById(sessionId);
  if (!session || !session.aiResult) return;

  const updated: LectureSession = {
    ...session,
    updatedAt: Date.now(),
    aiResult: {
      ...session.aiResult,
      checklist: session.aiResult.checklist.map((item) =>
        item.id === itemId ? { ...item, done: !item.done } : item,
      ),
    },
  };
  await saveSession(updated);
}

export async function saveCategories(categories: string[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CATEGORY_STORE, "readwrite");
    const store = tx.objectStore(CATEGORY_STORE);
    store.clear();
    for (const name of categories) {
      store.put({ name });
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveSlideImages(sessionId: string, images: SlideImage[]): Promise<void> {
  await runTransaction(SLIDE_IMAGE_STORE, "readwrite", (store) => store.put({ sessionId, images }));
}

export async function loadSlideImages(sessionId: string): Promise<SlideImage[]> {
  const result = await runTransaction<{ sessionId: string; images: SlideImage[] } | undefined>(
    SLIDE_IMAGE_STORE,
    "readonly",
    (store) => store.get(sessionId),
  );
  return result?.images ?? [];
}

export async function deleteSlideImages(sessionId: string): Promise<void> {
  await runTransaction(SLIDE_IMAGE_STORE, "readwrite", (store) => store.delete(sessionId));
}

// Caches the currently-selected/recorded audio Blob for a session so a
// refresh or a backgrounded-tab kill mid-analysis doesn't force the user to
// re-select the file (see components/RecordingDetailView.tsx's mount
// recovery effect and ReattachAudioPrompt, which this is meant to make
// unnecessary in the common case). Overwrites any previous entry for the
// same session — there's only ever one "current" audio per session.
export async function cacheAudioBlob(sessionId: string, audio: SessionAudio): Promise<void> {
  await runTransaction(AUDIO_CACHE_STORE, "readwrite", (store) =>
    store.put({ sessionId, audio, cachedAt: Date.now() }),
  );
}

export async function loadCachedAudioBlob(sessionId: string): Promise<SessionAudio | null> {
  const result = await runTransaction<{ sessionId: string; audio: SessionAudio; cachedAt: number } | undefined>(
    AUDIO_CACHE_STORE,
    "readonly",
    (store) => store.get(sessionId),
  );
  return result?.audio ?? null;
}

// Called once analysis fully completes (the cache's whole purpose is
// protecting an in-progress analysis, not permanent storage — see
// AUDIO_CACHE_STORE above) and from permanentlyDeleteSession above, so a
// deleted session's cached audio never lingers as an orphaned IndexedDB
// entry.
export async function deleteCachedAudioBlob(sessionId: string): Promise<void> {
  await runTransaction(AUDIO_CACHE_STORE, "readwrite", (store) => store.delete(sessionId));
}

// Renames a category everywhere it's referenced — category names are the
// only identity a category has in this app (no separate id/row), so a
// rename has to cascade to every session currently filed under oldName,
// not just the categories list itself. Bumps each affected session's
// updatedAt so the rename wins on cross-device merge the same way any other
// field edit already does (see lib/sync.ts). If newName collides with an
// existing category, the two simply merge (oldName's sessions join it)
// rather than erroring.
export async function renameCategory(oldName: string, newName: string): Promise<void> {
  const [allSessions, existingCategories] = await Promise.all([loadAllSessions(), loadCategories()]);
  const now = Date.now();
  const affected = allSessions.filter((session) => session.category === oldName);
  await Promise.all(affected.map((session) => saveSession({ ...session, category: newName, updatedAt: now })));

  const withoutOld = existingCategories.filter((name) => name !== oldName);
  const nextCategories = withoutOld.includes(newName) ? withoutOld : [...withoutOld, newName];
  await saveCategories(nextCategories);
}

export async function loadCategories(): Promise<string[]> {
  const db = await openDb();
  return new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(CATEGORY_STORE, "readonly");
    const store = tx.objectStore(CATEGORY_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const rows = request.result as Array<{ name: string }>;
      resolve(rows.map((row) => row.name));
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

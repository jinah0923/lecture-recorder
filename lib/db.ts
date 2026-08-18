import type { ChecklistFeedItem, LectureSession, LectureSessionSummary } from "@/lib/types";

const DB_NAME = "lecture-recorder";
const DB_VERSION = 1;
const SESSION_STORE = "session";
const CATEGORY_STORE = "categories";

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

export async function deleteSession(id: string): Promise<void> {
  await runTransaction(SESSION_STORE, "readwrite", (store) => store.delete(id));
}

export async function listSessions(): Promise<LectureSessionSummary[]> {
  const db = await openDb();
  return new Promise<LectureSessionSummary[]>((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readonly");
    const store = tx.objectStore(SESSION_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const rows = request.result as LectureSession[];
      const summaries = rows
        .map((row) => ({
          id: row.id,
          title: row.title,
          category: row.category,
          updatedAt: row.updatedAt,
          durationMs: row.durationMs ?? 0,
          hasAiResult: Boolean(row.aiResult),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(summaries);
    };
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
        if (!row.aiResult) continue;
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

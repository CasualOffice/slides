// IndexedDB-backed recent decks. Stores the raw .pptx bytes so File →
// Recent can reopen a deck without a remote backend. Browsers give us
// plenty of quota (~50 MB+ before prompting on most engines), more than
// enough for the 10-entry cap.
//
// Schema is intentionally flat — a single object store keyed on a
// generated `id`. No indexes; we read all rows and sort in memory. The
// row count cap (10) keeps that cheap.
//
// MIT-licensed; no external IDB wrapper used to keep the dep list lean.

const DB_NAME = 'casual-slides';
const DB_VERSION = 1;
const STORE = 'recent';
const MAX_ENTRIES = 10;

export interface RecentMeta {
  id: string;
  name: string;
  size: number;
  openedAt: number; // epoch ms
  /** Pinned entries sort to the top and survive the 10-row trim. */
  pinned?: boolean;
}

interface RecentRow extends RecentMeta {
  bytes: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Sorted pinned-first, then newest-first within each group.
export async function listRecents(): Promise<RecentMeta[]> {
  const db = await openDb();
  try {
    const rows = await awaitRequest<RecentRow[]>(tx(db, 'readonly').getAll());
    return rows
      .map(({ id, name, size, openedAt, pinned }) => ({ id, name, size, openedAt, pinned: !!pinned }))
      .sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return b.openedAt - a.openedAt;
      });
  } finally {
    db.close();
  }
}

export async function loadRecent(id: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  try {
    const row = await awaitRequest<RecentRow | undefined>(tx(db, 'readonly').get(id));
    return row?.bytes ?? null;
  } finally {
    db.close();
  }
}

// Adds an entry and trims the store back to MAX_ENTRIES. Returns the new
// row's id so callers can correlate.
//
// De-dup by `name + size`: if you re-open the same file, we replace the
// existing row (refreshing its openedAt) instead of stacking duplicates.
export async function addRecent(name: string, bytes: ArrayBuffer): Promise<string> {
  const db = await openDb();
  try {
    const store = tx(db, 'readwrite');
    const all = await awaitRequest<RecentRow[]>(store.getAll());
    const dup = all.find((r) => r.name === name && r.size === bytes.byteLength);
    const id = dup?.id ?? makeId();
    // Preserve the pinned flag when re-saving an existing entry.
    const row: RecentRow = {
      id,
      name,
      size: bytes.byteLength,
      openedAt: Date.now(),
      pinned: !!dup?.pinned,
      bytes,
    };
    await awaitRequest(tx(db, 'readwrite').put(row));

    // Re-read after the put, then drop the oldest UNPINNED rows until
    // we're under cap. Pinned rows are sticky — the user explicitly
    // marked them and shouldn't lose them to age-out.
    const after = await awaitRequest<RecentRow[]>(tx(db, 'readonly').getAll());
    const unpinned = after.filter((r) => !r.pinned).sort((a, b) => b.openedAt - a.openedAt);
    const overflow = unpinned.slice(MAX_ENTRIES);
    if (overflow.length) {
      const trimStore = tx(db, 'readwrite');
      await Promise.all(overflow.map((r) => awaitRequest(trimStore.delete(r.id))));
    }
    return id;
  } finally {
    db.close();
  }
}

// Toggle the pinned flag on an existing entry. No-op if the entry has
// been evicted (returns false), so callers can refresh the list and
// surface "entry no longer available" without crashing.
export async function setRecentPinned(id: string, pinned: boolean): Promise<boolean> {
  const db = await openDb();
  try {
    const row = await awaitRequest<RecentRow | undefined>(tx(db, 'readonly').get(id));
    if (!row) return false;
    row.pinned = pinned;
    await awaitRequest(tx(db, 'readwrite').put(row));
    return true;
  } finally {
    db.close();
  }
}

export async function removeRecent(id: string): Promise<void> {
  const db = await openDb();
  try {
    await awaitRequest(tx(db, 'readwrite').delete(id));
  } finally {
    db.close();
  }
}

export async function clearRecents(): Promise<void> {
  const db = await openDb();
  try {
    await awaitRequest(tx(db, 'readwrite').clear());
  } finally {
    db.close();
  }
}

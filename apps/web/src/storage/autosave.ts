import type { ISlideData } from '@univerjs/slides';

// IndexedDB-backed autosave for the current working deck. Distinct from
// recent-files.ts (which stores opened .pptx blobs) — this one persists
// the live snapshot mid-edit so a tab crash or accidental close doesn't
// destroy unsaved work.
//
// Schema: single row at key 'current' in a one-store DB. We do NOT keep
// history — the cheap, predictable "last saved snapshot" model is enough
// for crash recovery. Undo/redo lives in Univer.

const DB_NAME = 'casual-slides-autosave';
const DB_VERSION = 1;
const STORE = 'autosave';
const KEY = 'current';

export interface AutosaveRecord {
  key: string;
  snapshot: ISlideData;
  fileName: string;
  savedAt: number; // epoch ms
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
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

export async function saveAutosave(snapshot: ISlideData, fileName: string): Promise<void> {
  try {
    const db = await openDb();
    const row: AutosaveRecord = {
      key: KEY,
      // Structured-clone the snapshot so we don't accidentally store a
      // live reference Univer mutates afterwards.
      snapshot: JSON.parse(JSON.stringify(snapshot)) as ISlideData,
      fileName,
      savedAt: Date.now(),
    };
    await awaitRequest(tx(db, 'readwrite').put(row));
    db.close();
  } catch (e) {
    // Quota / private-mode failures are non-fatal. Surface to the
    // console so a dev can see why the recovery banner won't appear,
    // but don't tell the user — the foreground save path is untouched.
    // eslint-disable-next-line no-console
    console.warn('[autosave] save failed', e);
  }
}

export async function loadAutosave(): Promise<AutosaveRecord | null> {
  try {
    const db = await openDb();
    const row = await awaitRequest(tx(db, 'readonly').get(KEY));
    db.close();
    return (row as AutosaveRecord | undefined) ?? null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[autosave] load failed', e);
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    const db = await openDb();
    await awaitRequest(tx(db, 'readwrite').delete(KEY));
    db.close();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[autosave] clear failed', e);
  }
}

// Reset the fake-indexeddb instance between tests so a leftover record
// from one spec doesn't bleed into the next. fake-indexeddb exposes a
// reset on its `FDBFactory` instance; calling it wipes every database
// without forcing each spec to know the DB names.

import { IDBFactory } from 'fake-indexeddb';

export function resetIndexedDB(): void {
  // The `indexedDB` global is the FDBFactory installed by
  // `fake-indexeddb/auto`. Reassigning to a fresh instance gives every
  // test a clean slate.
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
}

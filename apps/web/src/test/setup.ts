// Vitest setup. Polyfills + globals shared across every spec.

// fake-indexeddb installs `indexedDB`, `IDBKeyRange`, etc. on globalThis,
// matching browser semantics closely enough for the autosave roundtrip
// tests. Each spec file resets the database between tests via the helper
// in `src/test/idb-reset.ts`.
import 'fake-indexeddb/auto';

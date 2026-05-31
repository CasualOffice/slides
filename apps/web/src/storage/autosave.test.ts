import type { ISlideData } from '@univerjs/slides';
import { beforeEach, describe, expect, test } from 'vitest';
import { resetIndexedDB } from '../test/idb-reset';
import { clearAutosave, loadAutosave, saveAutosave } from './autosave';

// Minimal valid-shape ISlideData stub. Type checks pass with `as` because
// we only round-trip the JSON shape — the storage layer doesn't inspect
// the body, it just JSON-clones and persists.
function makeSnapshot(idSuffix: string): ISlideData {
  return {
    id: `test-deck-${idSuffix}`,
    title: `Test deck ${idSuffix}`,
    body: {
      pageOrder: ['p1'],
      pages: { p1: { id: 'p1' } },
    },
    rev: 0,
  } as unknown as ISlideData;
}

describe('storage/autosave', () => {
  beforeEach(() => {
    resetIndexedDB();
  });

  test('loadAutosave returns null when no record exists', async () => {
    expect(await loadAutosave()).toBeNull();
  });

  test('saveAutosave + loadAutosave round-trips the snapshot', async () => {
    const snapshot = makeSnapshot('a');
    await saveAutosave(snapshot, 'Foo.pptx');

    const record = await loadAutosave();
    expect(record).not.toBeNull();
    expect(record?.fileName).toBe('Foo.pptx');
    expect(record?.snapshot.id).toBe(snapshot.id);
    expect(record?.snapshot.title).toBe(snapshot.title);
    // savedAt is stamped at write time — should be within the last few
    // hundred ms.
    expect(record?.savedAt).toBeGreaterThan(Date.now() - 2_000);
    expect(record?.savedAt).toBeLessThanOrEqual(Date.now());
  });

  test('saveAutosave overwrites the previous record (single-row store)', async () => {
    await saveAutosave(makeSnapshot('first'), 'First.pptx');
    await saveAutosave(makeSnapshot('second'), 'Second.pptx');

    const record = await loadAutosave();
    expect(record?.fileName).toBe('Second.pptx');
    expect(record?.snapshot.id).toBe('test-deck-second');
  });

  test('clearAutosave wipes the record', async () => {
    await saveAutosave(makeSnapshot('toClear'), 'Doomed.pptx');
    expect(await loadAutosave()).not.toBeNull();

    await clearAutosave();
    expect(await loadAutosave()).toBeNull();
  });

  test('saveAutosave deep-clones the snapshot (no live reference held)', async () => {
    const snapshot = makeSnapshot('clone');
    await saveAutosave(snapshot, 'Clone.pptx');

    // Mutate the original in place. If autosave held a reference instead
    // of a clone, the next loadAutosave would observe the mutation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (snapshot as any).title = 'MUTATED AFTER SAVE';

    const record = await loadAutosave();
    expect(record?.snapshot.title).toBe('Test deck clone');
  });
});

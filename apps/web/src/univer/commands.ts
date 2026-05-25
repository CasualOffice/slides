import type { Univer } from '@univerjs/core';
import { ICommandService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';

// Thin façade over the live Univer instance for ribbon/status-bar dispatches.
// Reads `window.univer` (set by UniverSlide on mount) so any React component
// can call dispatchSlideCommand without prop drilling. Returns false if the
// Univer instance isn't ready yet (initial render before useEffect lands).

interface Win {
  univer?: Univer;
}

function getUniver(): Univer | null {
  return ((globalThis as Win).univer ?? null) as Univer | null;
}

export function getFocusedSlideUnitId(): string | null {
  const univer = getUniver();
  if (!univer) return null;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  return instances.getCurrentUnitOfType(UniverInstanceType.UNIVER_SLIDE)?.getUnitId() ?? null;
}

// Dispatch a Univer command. The unitId is auto-supplied from the focused
// slide unit if the caller doesn't pass one — convenient for ribbon buttons
// that don't track unit context themselves.
export async function dispatchSlideCommand<T extends Record<string, unknown>>(
  id: string,
  params?: T,
): Promise<boolean> {
  // Casual-Slides-local commands are handled here, not via Univer's command
  // bus. Keeps small UI verbs (print, slideshow, fit-to-window) out of the
  // collab broadcast envelope.
  if (id === 'casual-slides.command.print') {
    if (typeof window !== 'undefined') window.print();
    return true;
  }

  const univer = getUniver();
  if (!univer) return false;
  const cs = univer.__getInjector().get(ICommandService);
  // univer.command.undo / .redo don't take a unitId param; only auto-supply
  // for slide.* commands that need one.
  const needsUnitId = id.startsWith('slide.');
  const unitId = needsUnitId ? getFocusedSlideUnitId() : null;
  const merged = unitId ? { unitId, ...(params ?? {}) } : params;
  try {
    return await cs.executeCommand(id, merged);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[dispatchSlideCommand] ${id} failed:`, err);
    return false;
  }
}

// Selection bridge — a tiny module-level store of the currently-selected
// slide element so UI surfaces OUTSIDE the Univer DI scope (the Toolbar's
// fill/border colour pickers) can target the same shape the FormatPane is
// editing.
//
// Why a module store and not React context / Univer state:
//   - The Toolbar and the FormatPaneProvider are mounted as independent
//     islands next to <App /> in main.tsx — no shared prop tree.
//   - Univer v0.24.0 has no public "currently-selected element" service
//     reachable from outside the slides-ui DI scope. The FormatPane already
//     derives the selection from the canvas-view Transformer events; rather
//     than duplicate that subscription chain in the Toolbar, the FormatPane
//     is the single source of truth and PUSHES the selection here.
//
// Shape of the contract:
//   - `setSelectedElement(sel)` is called by whoever knows the selection
//     (the FormatPaneProvider, on every transformer create/clear event).
//   - `getSelectedElement()` is a synchronous read for imperative handlers
//     (the Toolbar's applyFillColor / applyBorderColor).
//   - `subscribeSelection(cb)` lets React components re-render when the
//     selection changes (the Toolbar disables its fill/border buttons when
//     nothing is selected). Returns an unsubscribe fn.

export interface SelectedElement {
  /** Page (slide) id the element lives on. */
  pageId: string;
  /** Element id — the key into `page.pageElements`. */
  elementId: string;
}

let current: SelectedElement | null = null;
const listeners = new Set<() => void>();

// Last fallback result, cached to keep reference identity across calls
// (useSyncExternalStore requires reference-equal snapshots when nothing
// changed, otherwise it re-renders every tick and crashes the Toolbar
// with "Maximum update depth exceeded").
let lastFallback: SelectedElement | null = null;
function sameSel(
  a: SelectedElement | null,
  b: SelectedElement | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.pageId === b.pageId && a.elementId === b.elementId;
}

// Read transformer state directly as a fallback. FormatPane's mirror is
// the fast path (no cross-DI lookup, no error catching) but if it hasn't
// wired yet — early in the React mount cycle, or after a model swap where
// the previous wire targeted a now-stale pageId — fall back to a live
// dip into the transformer's selectedObjectMap. The transformer is the
// source of truth; the module cache is just a read-side optimisation.
function readTransformerSelection(): SelectedElement | null {
  if (typeof window === 'undefined') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const univer = w.univer;
    if (!univer || typeof univer.__getInjector !== 'function') return null;
    const inj = univer.__getInjector();
    const instSrv = inj.get(w.__casualSlides__IUniverInstanceService);
    const renderManager = inj.get(w.__casualSlides__IRenderManagerService);
    if (!instSrv || !renderManager) return null;
    // UNIVER_SLIDE === 3
    const unit = instSrv.getCurrentUnitOfType?.(3);
    if (!unit) return null;
    const unitId = unit.getUnitId?.();
    const render = renderManager.getRenderById?.(unitId);
    const slide = render?.mainComponent;
    if (!slide || typeof slide.getSubScenes !== 'function') return null;
    const subScenes = slide.getSubScenes();
    const activeId = unit.getActivePage?.()?.id || unit.getPageOrder?.()?.[0];
    // Try the active page first; if its scene has no selection (or no
    // scene), walk the rest of the pages — some user actions (e.g.
    // double-click on a sub-page from the rail) can leave the selection
    // attached to a different page's transformer than activePage$ thinks.
    const pageIds = [activeId, ...(unit.getPageOrder?.() ?? [])].filter(
      (id: string | undefined): id is string => typeof id === 'string',
    );
    const seen = new Set<string>();
    for (const pageId of pageIds) {
      if (seen.has(pageId)) continue;
      seen.add(pageId);
      const scene = subScenes.get(pageId);
      if (!scene) continue;
      const transformer = scene.getTransformer?.();
      if (!transformer) continue;
      const map = transformer.getSelectedObjectMap?.();
      if (!map || map.size === 0) continue;
      const first = map.values().next().value;
      const oKey = first?.oKey;
      if (!oKey) continue;
      return { pageId, elementId: oKey };
    }
    return null;
  } catch {
    return null;
  }
}

export function getSelectedElement(): SelectedElement | null {
  // FormatPane-mirrored value wins when present; otherwise live-read from
  // the transformer so Ctrl+C / Ctrl+V / Ctrl+D / Ctrl+X work even when
  // the mirror hasn't been wired yet (boot race) or got stuck on a stale
  // pageId (model swap). Cache the fallback to maintain reference identity
  // for useSyncExternalStore consumers — re-reading must return the SAME
  // object when nothing changed or React rerenders forever.
  if (current) return current;
  const fresh = readTransformerSelection();
  if (sameSel(fresh, lastFallback)) return lastFallback;
  lastFallback = fresh;
  return fresh;
}

// Probe hook for Playwright diagnostics. Returns the resolved selection
// (cache OR transformer fallback) so __diagnostic__ specs see exactly
// what handlers see.
if (typeof window !== 'undefined') {
  (window as unknown as { __casualSlides_getSelection?: () => SelectedElement | null })
    .__casualSlides_getSelection = () => getSelectedElement();
}

export function setSelectedElement(sel: SelectedElement | null): void {
  // Skip the notify when nothing actually changed — avoids redundant
  // re-renders on every transformer `changing$` tick during a drag.
  if (current === sel) return;
  if (
    current &&
    sel &&
    current.pageId === sel.pageId &&
    current.elementId === sel.elementId
  ) {
    return;
  }
  current = sel;
  for (const cb of listeners) cb();
}

export function subscribeSelection(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

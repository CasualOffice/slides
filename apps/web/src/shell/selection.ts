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

export function getSelectedElement(): SelectedElement | null {
  return current;
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

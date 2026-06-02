import type { DocumentDataModel, IAccessor, Univer } from '@univerjs/core';
import {
  BooleanNumber,
  CommandType,
  ICommandService,
  IUndoRedoService,
  IUniverInstanceService,
  NamedStyleType,
  PluginService,
  SpacingRule,
  UpdateDocsAttributeType,
  UniverInstanceType,
} from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { DocSelectionManagerService } from '@univerjs/docs';
import { CanvasView } from '@univerjs/slides-ui';
import { printDeck } from '../shell/download-slide';
import { getSelectedElement, setSelectedElement } from '../shell/selection';

// Thin façade over the live Univer instance for ribbon/status-bar dispatches.
// Reads `window.univer` (set by UniverSlide on mount) so any React component
// can call dispatchSlideCommand without prop drilling. Returns false if the
// Univer instance isn't ready yet (initial render before useEffect lands).

interface Win {
  univer?: Univer;
}

// Fire a transient status message into the TitleBar pill. App.tsx listens
// for `cs:status` and pushes the message through setStatus(); the existing
// 3.5 s auto-dismiss handles cleanup. Use this to surface a "you did X"
// confirmation for actions that otherwise feel silent (duplicate slide,
// bring forward, center on slide, …).
function notify(message: string): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cs:status', { detail: { message } }));
  }
}

// ─────────────────────────────────────────────────── undo for direct writes
//
// Several of our slide commands (duplicate, move, center, delete, z-order)
// mutate the SlideDataModel snapshot directly because Univer Slides v0.24.0
// doesn't expose a typed mutation for those fields. Direct writes are
// invisible to Univer's command bus, which means Ctrl+Z doesn't see them.
//
// Workaround: register one generic `cs.mut.replace-body` mutation that
// swaps `snapshot.body` for a snapshot passed in `params`. Wrap each
// direct-write helper in `withUndo()` — it takes a body clone before the
// action, runs the action, takes a body clone after, then pushes both
// onto Univer's IUndoRedoService stack. Ctrl+Z restores the pre-write
// body; Ctrl+Y restores the post-write body.
//
// Caveats:
//   • Whole-body clone per action — fine for the 10-100 slide sizes we
//     target; would need a finer-grained mutation for huge decks.
//   • TODO(collab): same caveat as the underlying direct writes — the
//     replace-body mutation isn't routed through `onMutationExecutedForCollab`
//     so peers won't see undo replay.

let replaceBodyRegistered = false;
const REPLACE_BODY_MUTATION_ID = 'cs.mut.replace-body';

function ensureReplaceBodyMutation(univer: Univer): void {
  if (replaceBodyRegistered) return;
  const cs = univer.__getInjector().get(ICommandService);
  cs.registerCommand({
    type: CommandType.MUTATION,
    id: REPLACE_BODY_MUTATION_ID,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler(accessor: IAccessor, params?: { body?: any }) {
      if (!params?.body) return false;
      const instances = accessor.get(IUniverInstanceService);
      const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
      if (!model) return false;
      const snap = model.getSnapshot();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (snap as any).body = structuredClone(params.body);
      model.incrementRev();
      const active = model.getActivePage();
      if (active) model.setActivePage(active);
      return true;
    },
  });
  replaceBodyRegistered = true;
}

// Run a direct-snapshot action and push an undo/redo entry onto Univer's
// stack. The action must return `true` for the write to be considered
// committed; returning `false` (no-op, validation failed, etc.) skips the
// undo entry so the user's history stays clean.
function withUndo(action: () => boolean): boolean {
  const univer = getUniver();
  if (!univer) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  ensureReplaceBodyMutation(univer);
  const unitId = model.getUnitId();
  const before = structuredClone(model.getSnapshot().body);
  let ok = false;
  try {
    ok = action();
  } catch {
    ok = false;
  }
  if (!ok) return false;
  const after = structuredClone(model.getSnapshot().body);
  try {
    const undoService = univer.__getInjector().get(IUndoRedoService);
    undoService.pushUndoRedo({
      unitID: unitId,
      undoMutations: [{ id: REPLACE_BODY_MUTATION_ID, params: { body: before } }],
      redoMutations: [{ id: REPLACE_BODY_MUTATION_ID, params: { body: after } }],
    });
  } catch {
    // If pushUndoRedo fails (service not ready / unit gone), the snapshot
    // change still landed — just no undo entry. Better than crashing.
  }
  return true;
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
  if (id === 'casual-slides.command.z-order') {
    const dir = (params as { direction?: ZOrderDirection } | undefined)?.direction;
    if (!dir) return false;
    return applyZOrder(dir);
  }
  if (id === 'casual-slides.command.center-on-slide') {
    const axis = (params as { axis?: CenterAxis } | undefined)?.axis ?? 'both';
    return centerSelectionOnSlide(axis);
  }
  if (id === 'casual-slides.command.delete-element') {
    return deleteSelectedElement();
  }
  if (id === 'casual-slides.command.nudge-element') {
    const p = params as { dx?: number; dy?: number } | undefined;
    return nudgeSelectedElement(p?.dx ?? 0, p?.dy ?? 0);
  }
  if (id === 'casual-slides.command.copy-element') {
    return copySelectedElement();
  }
  if (id === 'casual-slides.command.paste-element') {
    return pasteElement();
  }
  if (id === 'casual-slides.command.duplicate-element') {
    return duplicateSelectedElement();
  }
  if (id === 'casual-slides.command.clear-selection') {
    return clearCanvasSelection();
  }
  if (id === 'casual-slides.command.move-active-slide') {
    const dir = (params as { direction?: 'up' | 'down' } | undefined)?.direction;
    if (dir !== 'up' && dir !== 'down') return false;
    return moveActiveSlide(dir === 'up' ? -1 : 1);
  }
  if (id === 'casual-slides.command.insert-link') {
    // Lazy-init the docs-hyper-link plugin pair on first invocation —
    // they declare `type = UNIVER_DOC` and so otherwise stay dormant
    // in a slides app. Once started, the operation registers globally
    // and subsequent clicks dispatch instantly.
    const univer = getUniver();
    if (!univer) return false;
    try {
      univer
        .__getInjector()
        .get(PluginService)
        .startPluginsForType(UniverInstanceType.UNIVER_DOC);
    } catch {
      /* already started — that's fine */
    }
    const cs = univer.__getInjector().get(ICommandService);
    try {
      return await cs.executeCommand('doc.operation.show-hyper-link-edit-popup');
    } catch {
      return false;
    }
  }
  if (id === 'slide.command.duplicate-slide') {
    // Univer v0.24.0 ships no built-in duplicate-page mutation. We clone
    // the target page on the snapshot directly — same TODO(collab) caveat
    // as reorderPage in SlideContextMenu (not collab-safe until a real
    // mutation lands in the fork). The accepted param is `pageId`; if
    // omitted we duplicate the active page.
    const targetId = (params as { pageId?: string } | undefined)?.pageId;
    return duplicateSlide(targetId);
  }
  if (id === 'casual-slides.command.print') {
    // Real slide-by-slide print. Pulls the live deck snapshot and routes
    // through the same offscreen-SlideTile rasterizer the PNG/PDF
    // exports use. The previous `window.print()` printed the editor
    // viewport (toolbar, slide panel, etc.) — useless for a deck print.
    const univer = getUniver();
    if (!univer) return false;
    try {
      const instances = univer.__getInjector().get(IUniverInstanceService);
      const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
      if (!model) return false;
      const snap = model.getSnapshot();
      const pageSize = {
        width: snap.pageSize?.width ?? 960,
        height: snap.pageSize?.height ?? 540,
      };
      const order = snap.body?.pageOrder ?? [];
      const pageMap = snap.body?.pages ?? {};
      const pages = order.map((pid) => pageMap[pid]).filter((p): p is NonNullable<typeof p> => !!p);
      if (!pages.length) return false;
      await printDeck(pages, pageSize);
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[casual-slides.command.print] failed:', err);
      return false;
    }
  }

  const univer = getUniver();
  if (!univer) return false;
  const cs = univer.__getInjector().get(ICommandService);
  // univer.command.undo / .redo don't take a unitId param; only auto-supply
  // for slide.* commands that need one. If the caller already provided a
  // unitId in params, that wins.
  const needsUnitId = id.startsWith('slide.');
  const hasUnitId = !!(params && typeof params === 'object' && 'unitId' in params);
  const unitId = needsUnitId && !hasUnitId ? getFocusedSlideUnitId() : null;
  const merged = unitId ? { unitId, ...(params ?? {}) } : params;
  try {
    return await cs.executeCommand(id, merged);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[dispatchSlideCommand] ${id} failed:`, err);
    return false;
  }
}

// ─────────────────────────────────────────────────── text-frame helpers
//
// Text frames in Univer Slides are backed by nested @univerjs/docs doc-units.
// The toolbar talks to whatever doc-unit currently owns the caret — when a
// text box is being edited, `getCurrentUnitOfType(UNIVER_DOC)` resolves to
// that nested unit and `DocSelectionManagerService` reports its selection.
// Both helpers below route through the same `RichTextEditingMutation` path
// the built-in align/list/bold commands use, so they stay collab-safe.

// Line spacing. `doc-paragraph-setting.command` writes the paragraph's
// `lineSpacing` (a line-height multiplier) + `spacingRule`. We mirror the
// official docs-ui paragraph-setting hook: a multiplier preset with
// SpacingRule.AUTO (height grows with content, no hard min/max).
export async function setLineSpacing(multiplier: number): Promise<boolean> {
  return dispatchSlideCommand('doc-paragraph-setting.command', {
    paragraph: { lineSpacing: multiplier, spacingRule: SpacingRule.AUTO },
  });
}

// Clear formatting. docs-ui v0.24.0 ships no single "clear all" command, so
// we compose the two reachable resets that DO exist:
//   1. paragraph level — `doc.command.set-paragraph-named-style` → NORMAL_TEXT
//      drops heading / line-spacing / spacing overrides.
//   2. inline level — `doc.command.update-text` with `coverType: REPLACE`
//      over each selected range wipes the run style (bold / italic /
//      underline / strikethrough / color / background / baseline).
// Both go through RichTextEditingMutation, so undo + collab work unchanged.
export async function clearFormatting(): Promise<boolean> {
  const univer = getUniver();
  if (!univer) return false;
  const injector = univer.__getInjector();
  const instances = injector.get(IUniverInstanceService);
  const doc = instances.getCurrentUnitOfType<DocumentDataModel>(UniverInstanceType.UNIVER_DOC);
  if (!doc) return false;
  const unitId = doc.getUnitId();
  const selection = injector.get(DocSelectionManagerService);
  const ranges = selection.getDocRanges();
  if (!ranges.length) return false;
  const cs = injector.get(ICommandService);

  // 1. Reset paragraph style across the selection (line spacing, heading…).
  let ok = false;
  try {
    ok = await cs.executeCommand('doc.command.set-paragraph-named-style', {
      value: NamedStyleType.NORMAL_TEXT,
      textRanges: ranges,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[clearFormatting] paragraph reset failed:', err);
  }

  // 2. Reset inline run style for every non-collapsed range. A collapsed
  // caret has no run to rewrite — skip it.
  const RESET_TS = {
    bl: BooleanNumber.FALSE,
    it: BooleanNumber.FALSE,
    ul: { s: BooleanNumber.FALSE },
    st: { s: BooleanNumber.FALSE },
    va: null,
    cl: null,
    bg: null,
  };
  for (const range of ranges) {
    const { startOffset, endOffset, segmentId } = range;
    if (startOffset == null || endOffset == null || startOffset === endOffset) continue;
    try {
      const result = await cs.executeCommand('doc.command.update-text', {
        unitId,
        segmentId,
        range: { startOffset, endOffset, collapsed: false },
        textRanges: ranges,
        coverType: UpdateDocsAttributeType.REPLACE,
        updateBody: {
          dataStream: '',
          textRuns: [{ st: 0, ed: endOffset - startOffset, ts: RESET_TS }],
        },
      });
      ok = ok || Boolean(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[clearFormatting] inline reset failed:', err);
    }
  }
  return ok;
}

// Adjust the selected element's z-order on the active slide. Direction
// matches PowerPoint / Google Slides:
//   'forward'  — swap with the element directly above (+1 layer)
//   'backward' — swap with the element directly below (-1 layer)
//   'front'    — jump to max(zIndex)+1, painting on top of everything
//   'back'     — jump to min(zIndex)-1, hiding behind everything
//
// Mutates the snapshot directly + bumps the rev — same TODO(collab)
// caveat as duplicateSlide / reorderPage.
export type ZOrderDirection = 'forward' | 'backward' | 'front' | 'back';

export function applyZOrder(direction: ZOrderDirection): boolean {
  return withUndo(() => _applyZOrder(direction));
}

function _applyZOrder(direction: ZOrderDirection): boolean {
  const univer = getUniver();
  if (!univer) return false;
  const sel = getSelectedElement();
  if (!sel) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  const page = model.getPage(sel.pageId);
  const els = page?.pageElements;
  const target = els?.[sel.elementId];
  if (!els || !target) return false;

  const ids = Object.keys(els);
  if (ids.length < 2) return false;
  const sorted = ids
    .map((id) => ({ id, z: els[id]?.zIndex ?? 0 }))
    .sort((a, b) => a.z - b.z);
  const idx = sorted.findIndex((e) => e.id === sel.elementId);
  if (idx < 0) return false;

  let newZ: number;
  if (direction === 'front') {
    newZ = (sorted[sorted.length - 1]!.z ?? 0) + 1;
  } else if (direction === 'back') {
    newZ = (sorted[0]!.z ?? 0) - 1;
  } else if (direction === 'forward') {
    if (idx === sorted.length - 1) return false; // already on top
    const above = sorted[idx + 1]!;
    // Swap z values with the neighbour so the relative gap survives.
    const targetEl = els[sel.elementId]!;
    const aboveEl = els[above.id]!;
    const tmp = targetEl.zIndex ?? 0;
    targetEl.zIndex = aboveEl.zIndex ?? 0;
    aboveEl.zIndex = tmp;
    model.incrementRev();
    const active = model.getActivePage();
    if (active) model.setActivePage(active);
    notify('Brought forward');
    return true;
  } else {
    if (idx === 0) return false; // already at back
    const below = sorted[idx - 1]!;
    const targetEl = els[sel.elementId]!;
    const belowEl = els[below.id]!;
    const tmp = targetEl.zIndex ?? 0;
    targetEl.zIndex = belowEl.zIndex ?? 0;
    belowEl.zIndex = tmp;
    model.incrementRev();
    const active = model.getActivePage();
    if (active) model.setActivePage(active);
    notify('Sent backward');
    return true;
  }

  target.zIndex = newZ;
  model.incrementRev();
  const active = model.getActivePage();
  if (active) model.setActivePage(active);
  notify(direction === 'front' ? 'Brought to front' : 'Sent to back');
  return true;
}

// Move the active slide up or down in pageOrder. Same swap-and-bump-rev
// pattern as SlideContextMenu.reorderPage (which targets a specific
// pageId from a thumbnail right-click). Returns false if already at the
// boundary.
export function moveActiveSlide(delta: -1 | 1): boolean {
  return withUndo(() => _moveActiveSlide(delta));
}

function _moveActiveSlide(delta: -1 | 1): boolean {
  const univer = getUniver();
  if (!univer) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  const snap = model.getSnapshot();
  const order = snap.body?.pageOrder;
  if (!order) return false;
  const activeId = model.getActivePage()?.id;
  if (!activeId) return false;
  const idx = order.indexOf(activeId);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= order.length) return false;
  [order[idx], order[target]] = [order[target]!, order[idx]!];
  model.incrementRev();
  // Re-anchor the active page to the SLIDE we just moved (now at the
  // target index) so subsequent moves keep operating on the same deck
  // entry. Without this, Univer's getActivePage() walks pageOrder by
  // index and returns whatever's now at the old position — making the
  // next press of the same shortcut act on the wrong slide.
  const moved = model.getPage(activeId);
  if (moved) model.setActivePage(moved);
  notify(delta < 0 ? 'Slide moved up' : 'Slide moved down');
  return true;
}

// Clear the current canvas selection. Walks every render unit + scene
// reachable through IRenderManagerService and calls transformer.clearControls
// on each — Univer's slides plug-in nests one scene per page under the
// slide render unit, so calling clear on just the top scene isn't enough.
// FormatPane's createControl$/clearControl$ subscription receives the
// clearControls notification and pushes the bridge to null, which in turn
// fires the cs:format-pane event so App.tsx restores the canvas zoom.
export function clearCanvasSelection(): boolean {
  const univer = getUniver();
  if (!univer) return false;
  let cleared = false;
  try {
    const injector = univer.__getInjector();
    const instances = injector.get(IUniverInstanceService);
    const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    const unitId = model?.getUnitId();
    if (model && unitId) {
      const canvasView = injector.get(CanvasView);
      const order = model.getSnapshot().body?.pageOrder ?? [];
      for (const pageId of order) {
        try {
          const renderUnit = canvasView.getRenderUnitByPageId(pageId, unitId);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const transformer = renderUnit?.scene?.getTransformer() as any;
          if (transformer && transformer.getSelectedObjectMap().size > 0) {
            // Use clearSelectedObjects (not clearControls): the former
            // clears the internal _selectedObjectMap AND fires
            // clearControl$. The latter only fires the event but leaves
            // the map populated, so FormatPane's subscription guard
            // `if (map.size === 0)` never trips and the pane stays open.
            if (typeof transformer.clearSelectedObjects === 'function') {
              transformer.clearSelectedObjects();
            } else {
              transformer.clearControls();
            }
            cleared = true;
          }
        } catch { /* per-page scene not mounted — ignore */ }
      }
    }
  } catch { /* injector torn down */ }
  if (getSelectedElement()) {
    setSelectedElement(null);
    cleared = true;
  }
  return cleared;
}

// Delete the currently-selected slide element from its page. Returns
// false when no selection is registered, the unit/page/element is gone,
// or Univer isn't ready. Same TODO(collab) caveat as the other direct-
// snapshot mutations.
export function deleteSelectedElement(): boolean {
  return withUndo(() => _deleteSelectedElement());
}

function _deleteSelectedElement(): boolean {
  const univer = getUniver();
  if (!univer) return false;
  const sel = getSelectedElement();
  if (!sel) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  const page = model.getPage(sel.pageId);
  const els = page?.pageElements;
  if (!els || !els[sel.elementId]) return false;
  delete els[sel.elementId];
  model.incrementRev();
  const active = model.getActivePage();
  if (active) model.setActivePage(active);
  notify('Element deleted');
  return true;
}

// Nudge the selected element by (dx, dy) pixels. Routed through
// slide.operation.update-element so the live BaseObject's transform
// refreshes alongside the snapshot (same path NumericFields uses for
// position changes in the Format pane). Without that, the snapshot
// would update but the on-canvas position would stay stale.
export function nudgeSelectedElement(dx: number, dy: number): boolean {
  if (!dx && !dy) return false;
  return withUndo(() => _nudgeSelectedElement(dx, dy));
}

function _nudgeSelectedElement(dx: number, dy: number): boolean {
  const univer = getUniver();
  if (!univer) return false;
  const sel = getSelectedElement();
  if (!sel) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  const page = model.getPage(sel.pageId);
  const el = page?.pageElements?.[sel.elementId];
  if (!el) return false;
  const nextLeft = (el.left ?? 0) + dx;
  const nextTop = (el.top ?? 0) + dy;
  try {
    void univer
      .__getInjector()
      .get(ICommandService)
      .executeCommand('slide.operation.update-element', {
        unitId: model.getUnitId(),
        oKey: sel.elementId,
        props: { left: nextLeft, top: nextTop },
      });
    return true;
  } catch {
    el.left = nextLeft;
    el.top = nextTop;
    model.incrementRev();
    const active = model.getActivePage();
    if (active) model.setActivePage(active);
    return true;
  }
}

// In-memory clipboard for slide elements. Plain object, not the OS
// clipboard — copies between tabs/windows are out of scope for v0.1.
// One slot, last-copy wins. Cleared only when the user copies again.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let elementClipboard: any = null;

// Save a deep clone of the selected element to the in-memory clipboard.
// Returns false when nothing is selected. The original element is left
// alone; only paste actually creates a new element on the canvas.
export function copySelectedElement(): boolean {
  const univer = getUniver();
  if (!univer) return false;
  const sel = getSelectedElement();
  if (!sel) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  const el = model.getPage(sel.pageId)?.pageElements?.[sel.elementId];
  if (!el) return false;
  elementClipboard = structuredClone(el);
  notify('Element copied');
  return true;
}

// Paste a copy of the clipboard element onto the active page, offset by
// (16, 16) so it's visually distinct from the source. Re-ids the clone so
// the transformer treats it as a new object. Direct-snapshot write + rev
// bump — same path duplicateSlide uses for whole-page clones.
// TODO(collab): bypasses the command bus; needs a real insert mutation
// once Univer Slides exposes one.
export function pasteElement(): boolean {
  return withUndo(() => _pasteElement());
}

function _pasteElement(): boolean {
  if (!elementClipboard) return false;
  const univer = getUniver();
  if (!univer) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  const page = model.getActivePage();
  if (!page) return false;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  const newId = `el-${stamp}-${rand}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clone: any = structuredClone(elementClipboard);
  clone.id = newId;
  clone.left = (clone.left ?? 0) + 16;
  clone.top = (clone.top ?? 0) + 16;
  // Bump zIndex above the current max so the paste lands on top.
  const existing = Object.values(page.pageElements ?? {});
  const maxZ = existing.length ? Math.max(...existing.map((e) => e?.zIndex ?? 0)) : 0;
  clone.zIndex = maxZ + 1;
  page.pageElements[newId] = clone;
  model.incrementRev();
  model.setActivePage(page);
  notify('Element pasted');
  return true;
}

// Duplicate-in-place: copy + paste in one step. Doesn't touch the user's
// existing clipboard so a separate Ctrl+C/Ctrl+V workflow stays intact.
export function duplicateSelectedElement(): boolean {
  const univer = getUniver();
  if (!univer) return false;
  const sel = getSelectedElement();
  if (!sel) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  const el = model.getPage(sel.pageId)?.pageElements?.[sel.elementId];
  if (!el) return false;
  const saved = elementClipboard;
  elementClipboard = structuredClone(el);
  const ok = pasteElement();
  elementClipboard = saved;
  return ok;
}

// Center the selected element on the slide. `axis` controls which
// dimensions are centred:
//   'h'    — horizontal only: left = (slide.width - el.width) / 2
//   'v'    — vertical only:   top  = (slide.height - el.height) / 2
//   'both' — both axes
//
// Mutates the snapshot directly + bumps the rev. TODO(collab): no
// fork-side mutation reachable in v0.24.0; this writes element transform
// off the command bus so peers won't see the move.
export type CenterAxis = 'h' | 'v' | 'both';

export function centerSelectionOnSlide(axis: CenterAxis): boolean {
  return withUndo(() => _centerSelectionOnSlide(axis));
}

function _centerSelectionOnSlide(axis: CenterAxis): boolean {
  const univer = getUniver();
  if (!univer) return false;
  const sel = getSelectedElement();
  if (!sel) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  const snap = model.getSnapshot();
  const slideW = snap.pageSize?.width ?? 960;
  const slideH = snap.pageSize?.height ?? 540;
  const page = model.getPage(sel.pageId);
  const el = page?.pageElements?.[sel.elementId];
  if (!el) return false;
  const w = el.width ?? 0;
  const h = el.height ?? 0;
  if (axis === 'h' || axis === 'both') {
    el.left = Math.round((slideW - w) / 2);
  }
  if (axis === 'v' || axis === 'both') {
    el.top = Math.round((slideH - h) / 2);
  }
  model.incrementRev();
  const active = model.getActivePage();
  if (active) model.setActivePage(active);
  notify(axis === 'both' ? 'Centered on slide' : axis === 'h' ? 'Centered horizontally' : 'Centered vertically');
  return true;
}

// Duplicate a slide. Defaults to the active slide if no id is given.
// Deep-clones the source page via structuredClone, rewrites every
// element id (so Univer's transformer + per-page render unit don't see
// duplicate oKeys), inserts the clone into pageOrder right after the
// source, then bumps the rev + re-pings setActivePage so subscribers
// re-read. Returns true on success.
//
// TODO(collab): bypasses the command bus, same caveat as the move-up/
// move-down in SlideContextMenu. Replace with a fork-side
// `slide.mutation.duplicate-page` once it lands.
export function duplicateSlide(sourcePageId?: string): boolean {
  return withUndo(() => _duplicateSlide(sourcePageId));
}

function _duplicateSlide(sourcePageId?: string): boolean {
  const univer = getUniver();
  if (!univer) return false;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  if (!model) return false;
  const snap = model.getSnapshot();
  const order = snap.body?.pageOrder;
  const pages = snap.body?.pages;
  if (!order || !pages) return false;
  const activeId = model.getActivePage()?.id;
  const srcId = sourcePageId ?? activeId ?? order[0];
  if (!srcId) return false;
  const src = pages[srcId];
  if (!src) return false;

  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  const newPageId = `page-${stamp}-${rand}`;
  const clone = structuredClone(src);
  clone.id = newPageId;

  // Re-id every page element + rewrite the pageElements map so the
  // canvas renders the clone as a fresh set of BaseObjects (Univer
  // keys its transformer by oKey — leaving the source ids would make
  // a click on the clone select the source instead). Use a fresh
  // `el-{stamp}-{i}` prefix instead of compounding `oldKey-dup-…`,
  // otherwise re-duplicates get pathological ids like
  // `el-1-title-dup-X-dup-Y-dup-Z` and eventually overflow pptx export
  // id limits.
  const reKeyed: Record<string, (typeof clone.pageElements)[string]> = {};
  let i = 0;
  for (const [, el] of Object.entries(clone.pageElements ?? {})) {
    if (!el) continue;
    const newKey = `el-${stamp}-${rand}-${i++}`;
    el.id = newKey;
    reKeyed[newKey] = el;
  }
  clone.pageElements = reKeyed;

  pages[newPageId] = clone;
  const idx = order.indexOf(srcId);
  order.splice(idx + 1, 0, newPageId);

  model.incrementRev();
  // Move to the clone so the user sees what they just made.
  model.setActivePage(clone);
  notify('Slide duplicated');
  return true;
}

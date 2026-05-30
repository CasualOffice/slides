import type { DocumentDataModel, Univer } from '@univerjs/core';
import {
  BooleanNumber,
  ICommandService,
  IUniverInstanceService,
  NamedStyleType,
  SpacingRule,
  UpdateDocsAttributeType,
  UniverInstanceType,
} from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { DocSelectionManagerService } from '@univerjs/docs';
import { printDeck } from '../shell/download-slide';

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
  // a click on the clone select the source instead).
  const reKeyed: Record<string, (typeof clone.pageElements)[string]> = {};
  for (const [oldKey, el] of Object.entries(clone.pageElements ?? {})) {
    if (!el) continue;
    const newKey = `${oldKey}-dup-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
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
  return true;
}

// Toolbar — Microsoft Office-style tabbed ribbon.
//
// A tab strip (ホーム / 挿入 / デザイン) selects which labeled command groups
// the ribbon body shows. A persistent quick-access group (undo/redo/print)
// and the Slideshow CTA stay visible on every tab. Tab → group mapping:
//   home:   clipboard · slide+layout · font · paragraph · arrange
//   insert: insert
//   design: themes · background+layout
//
// The reused group JSX (group1/groupClipboard/groupInsert/groupSlide/
// groupLayout/groupTheme/groupBackground/groupArrange/group6/group7) is the
// same set of controls the old single-row toolbar dispatched — only the
// layout changed. The ribbon body scrolls horizontally on a narrow window
// instead of collapsing into a "More" popover.
//
// All formatting controls dispatch existing Univer commands (see the
// constants below + univer/commands.ts). Where a command is genuinely
// missing in v0.24.0 (paint format, insert link, vertical-align) the
// control is left OUT entirely rather than rendered as an inert button —
// a dead button reads as broken. We never fake a dispatch.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Univer, IShapeProperties, ITextRun, IDocumentData } from '@univerjs/core';
import { BorderStyleTypes, ICommandService, IUndoRedoService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { PageElementType } from '@univerjs/slides';
import { CanvasView } from '@univerjs/slides-ui';
import { useTranslation } from '../i18n';
import { clearFormatting, dispatchSlideCommand, hasElementClipboard } from '../univer/commands';
import { getAllSelectedElementIds, getSelectedElement, subscribeSelection } from './selection';
import { BackgroundPicker } from './BackgroundPicker';
import { LayoutPicker } from './LayoutPicker';
import { Icon } from './icons';
import { FontFamilyPicker } from './toolbar/FontFamilyPicker';
import { FontSizePicker } from './toolbar/FontSizePicker';
import { ColorPicker } from './toolbar/ColorPicker';
import { AlignPicker, type AlignValue } from './toolbar/AlignPicker';
import { ListPicker, type ListMode } from './toolbar/ListPicker';
import { LineSpacingPicker } from './toolbar/LineSpacingPicker';

// ============================================================ shapes ===

interface ShapeMenuItem {
  id: string;
  labelKey: string;
  icon: string;
  cmd?: string;
  shapeType?: string;
}

// Same catalogue + insert path as the legacy toolbar — we kept the
// dispatch pipeline intact so the renderer/exporter pieces don't need to
// change. Labels go through i18n (`toolbar.shape_*`).
const SHAPES_MENU: ShapeMenuItem[] = [
  { id: 'rect',       labelKey: 'toolbar:shape_rect',       icon: 'rectangle',       cmd: 'slide.command.insert-float-shape.rectangle' },
  { id: 'ellipse',    labelKey: 'toolbar:shape_ellipse',    icon: 'circle',          cmd: 'slide.command.insert-float-shape.ellipse' },
  { id: 'line',       labelKey: 'toolbar:shape_line',       icon: 'horizontal_rule', shapeType: 'line' },
  { id: 'rightArrow', labelKey: 'toolbar:shape_rightArrow', icon: 'arrow_right_alt', shapeType: 'rightArrow' },
  { id: 'leftArrow',  labelKey: 'toolbar:shape_leftArrow',  icon: 'arrow_back',      shapeType: 'leftArrow' },
  { id: 'upArrow',    labelKey: 'toolbar:shape_upArrow',    icon: 'arrow_upward',    shapeType: 'upArrow' },
  { id: 'downArrow',  labelKey: 'toolbar:shape_downArrow',  icon: 'arrow_downward',  shapeType: 'downArrow' },
  { id: 'triangle',   labelKey: 'toolbar:shape_triangle',   icon: 'change_history',  shapeType: 'triangle' },
  { id: 'diamond',    labelKey: 'toolbar:shape_diamond',    icon: 'diamond',         shapeType: 'diamond' },
  { id: 'pentagon',   labelKey: 'toolbar:shape_pentagon',   icon: 'pentagon',        shapeType: 'pentagon' },
  { id: 'hexagon',    labelKey: 'toolbar:shape_hexagon',    icon: 'hexagon',         shapeType: 'hexagon' },
  { id: 'octagon',    labelKey: 'toolbar:shape_octagon',    icon: 'shape_line',      shapeType: 'octagon' },
  { id: 'chevron',    labelKey: 'toolbar:shape_chevron',    icon: 'double_arrow',    shapeType: 'chevron' },
  { id: 'plus',       labelKey: 'toolbar:shape_plus',       icon: 'add',             shapeType: 'plus' },
  { id: 'star5',      labelKey: 'toolbar:shape_star5',      icon: 'star',            shapeType: 'star5' },
];

// Manual `slide.mutation.insert-element` payload for shape types the
// slides-ui plug-in doesn't ship a dedicated command for. Same defaults
// (250×250 rect / 300×24 line) the legacy toolbar used so PPTX export
// round-trips identically.
function insertShapeOfType(shapeType: string): void {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    if (!model) return;
    const unitId = model.getUnitId();
    const activePage = model.getActivePage();
    if (!activePage) return;
    const pageId = activePage.id;
    const existingZ = Object.values(activePage.pageElements ?? {}).reduce(
      (m, e) => Math.max(m, e?.zIndex ?? 0),
      0,
    );
    const id = `manual-shape-${Date.now().toString(36)}`;
    const isLine = shapeType === 'line';
    const element = {
      id,
      zIndex: existingZ + 1,
      left: 378,
      top: 142,
      width: isLine ? 300 : 250,
      height: isLine ? 24 : 250,
      title: '',
      description: '',
      type: 0,
      shape: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        shapeType: shapeType as any,
        text: '',
        shapeProperties: isLine
          ? {
              shapeBackgroundFill: { rgb: 'rgba(0,0,0,0)' },
              outline: { outlineFill: { rgb: 'rgb(31, 41, 55)' }, weight: 2 },
            }
          : {
              shapeBackgroundFill: { rgb: 'rgb(219, 234, 254)' },
              outline: { outlineFill: { rgb: 'rgb(37, 99, 235)' }, weight: 2 },
            },
      },
    };
    void dispatchSlideCommand('slide.mutation.insert-element', {
      unitId,
      pageId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      element: element as any,
    });
    // The insert mutation only writes the model — the live scene object is
    // materialized separately by CanvasView (the official insert operations
    // do the same). Without this the shape doesn't paint until a reload.
    try {
      const canvasView = univer.__getInjector().get(CanvasView);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = canvasView.createObjectToPage(element as any, pageId, unitId);
      if (obj) canvasView.setObjectActiveByPage(obj, pageId, unitId);
    } catch { /* scene not ready — model still has the element, will render on next full refresh */ }
  } catch {
    /* silent — Univer not ready */
  }
}

// Manual `slide.mutation.insert-element` payload for a table. The Univer
// fork already renders tables (TableAdaptor) and round-trips them through
// pptx import/export — only the create path was missing. We mirror
// `insertShapeOfType`: grab the model, active page + next zIndex, centre a
// rows×cols grid and dispatch the insert mutation. Cell text defaults to
// Calibri to match the Office-like deck font.
function insertTableOfSize(rows: number, cols: number): void {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    if (!model) return;
    const unitId = model.getUnitId();
    const activePage = model.getActivePage();
    if (!activePage) return;
    const pageId = activePage.id;
    const existingZ = Object.values(activePage.pageElements ?? {}).reduce((m, e) => Math.max(m, e?.zIndex ?? 0), 0);
    const COL_W = 150;
    const ROW_H = 40;
    const columnWidths = Array.from({ length: cols }, () => COL_W);
    const rowHeights = Array.from({ length: rows }, () => ROW_H);
    const totalW = COL_W * cols;
    const totalH = ROW_H * rows;
    const pageSize = model.getPageSize?.() ?? { width: 960, height: 540 };
    const pageW = pageSize.width ?? 960;
    const pageH = pageSize.height ?? 540;
    const left = Math.round((pageW - totalW) / 2);
    const top = Math.round((pageH - totalH) / 2);
    const border = { outlineFill: { rgb: 'rgb(148, 163, 184)' }, weight: 1 };
    const rowsArr = Array.from({ length: rows }, (_r, r) => ({
      cells: Array.from({ length: cols }, () => ({
        text: { text: '', fs: 14, ff: 'Calibri', cl: { rgb: 'rgb(31, 41, 55)' } },
        fill: { rgb: r === 0 ? 'rgb(241, 245, 249)' : 'rgb(255, 255, 255)' },
        border,
      })),
    }));
    const element = {
      id: `manual-table-${Date.now().toString(36)}`,
      zIndex: existingZ + 1,
      left, top, width: totalW, height: totalH,
      title: '', description: '',
      type: PageElementType.TABLE,
      table: { columnWidths, rowHeights, rows: rowsArr },
    };
    void dispatchSlideCommand('slide.mutation.insert-element', {
      unitId, pageId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      element: element as any,
    });
    // Materialize the live scene object (see insertShapeOfType) so the new
    // table paints immediately instead of only after a reload/slide-switch.
    try {
      const canvasView = univer.__getInjector().get(CanvasView);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = canvasView.createObjectToPage(element as any, pageId, unitId);
      if (obj) canvasView.setObjectActiveByPage(obj, pageId, unitId);
    } catch { /* scene not ready — model still has the element, will render on next full refresh */ }
  } catch { /* silent — Univer not ready */ }
}

// ============================================================ undo/redo ===

function useUndoRedoCounts(): { undos: number; redos: number } {
  const [counts, setCounts] = useState<{ undos: number; redos: number }>({ undos: 0, redos: 0 });
  useEffect(() => {
    let disposed = false;
    let retryHandle: number | null = null;
    let sub: { unsubscribe?: () => void } | undefined;
    const tryWire = () => {
      if (disposed) return;
      retryHandle = null;
      const w = window as unknown as { univer?: Univer };
      const univer = w.univer;
      if (!univer) {
        retryHandle = window.setTimeout(tryWire, 200);
        return;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const svc = univer.__getInjector().get(IUndoRedoService) as any;
        sub = svc?.undoRedoStatus$?.subscribe?.((s: { undos: number; redos: number }) => {
          if (!disposed) setCounts({ undos: s.undos, redos: s.redos });
        });
      } catch {
        retryHandle = window.setTimeout(tryWire, 200);
      }
    };
    tryWire();
    return () => {
      disposed = true;
      if (retryHandle != null) window.clearTimeout(retryHandle);
      sub?.unsubscribe?.();
    };
  }, []);
  return counts;
}

// ============================================================ shape style ===

// Subscribe to the selection bridge so the fill/border colour pickers can
// contextually disable when nothing is selected (Google-Slides UX) and
// re-render when the selection changes.
function useSelectedElement() {
  return useSyncExternalStore(subscribeSelection, getSelectedElement, getSelectedElement);
}

// Mutate the selected shape's shapeProperties and repaint by dispatching
// slide.mutation.update-element. The slides-ui patch (commit 952253f)
// removes + re-creates the live BaseObject from the updated snapshot on
// that mutation, so the canvas picks up the new fill / stroke / shadow
// immediately. A bare in-place snapshot write would land the data on the
// model but leave the cached Rect's fill stale (was the v0.0.x toolbar
// fill / border bug).
function mutateSelectedShape(patch: (sp: IShapeProperties) => void): boolean {
  const targets = getAllSelectedElementIds();
  if (targets.length === 0) return false;
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return false;
  try {
    const model = univer
      .__getInjector()
      .get(IUniverInstanceService)
      .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    if (!model) return false;
    const unitId = model.getUnitId();
    const cs = univer.__getInjector().get(ICommandService);
    let touched = 0;
    for (const sel of targets) {
      const el = model.getPage(sel.pageId)?.pageElements?.[sel.elementId];
      if (!el?.shape) continue;
      const nextSp: IShapeProperties = structuredClone(
        el.shape.shapeProperties ?? ({ shapeBackgroundFill: {} } as IShapeProperties),
      );
      patch(nextSp);
      try {
        void cs.executeCommand('slide.mutation.update-element', {
          unitId,
          pageId: sel.pageId,
          elementId: sel.elementId,
          props: { shape: { shapeProperties: nextSp } },
        });
        touched += 1;
      } catch {
        // Fork-patch not registered — direct snapshot write fallback.
        if (!el.shape.shapeProperties) {
          el.shape.shapeProperties = { shapeBackgroundFill: {} } as IShapeProperties;
        }
        patch(el.shape.shapeProperties);
        touched += 1;
      }
    }
    if (touched === 0) return false;
    model.incrementRev();
    const active = model.getActivePage();
    if (active) model.setActivePage(active);
    return true;
  } catch {
    return false;
  }
}

// Mutate the SELECTED text element's rich text style and repaint by
// dispatching slide.mutation.update-element. Use this when the user has
// a text element selected (transformer handles up) but is NOT inside a
// text-edit session — clicking toolbar Bold/Italic/Font/Size/TextColor
// should style the entire content of the selected text element.
//
// We mirror style fields into BOTH (a) every textRuns[].ts entry inside
// `richText.rich.body` (RichTextAdaptor's preferred read path) AND
// (b) the flat ISlideRichTextProps fields (bl/it/ul/st/ff/fs/cl) for the
// legacy code paths and pptx export. See project_pptx_rich_field_trap.
function mutateSelectedTextStyle(
  patch: (ts: Record<string, unknown>) => void,
  flatPatch?: (flat: Record<string, unknown>) => void,
): boolean {
  const targets = getAllSelectedElementIds();
  if (targets.length === 0) return false;
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return false;
  try {
    const model = univer
      .__getInjector()
      .get(IUniverInstanceService)
      .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    if (!model) return false;
    const unitId = model.getUnitId();
    const cs = univer.__getInjector().get(ICommandService);
    let touched = 0;
    for (const sel of targets) {
      const el = model.getPage(sel.pageId)?.pageElements?.[sel.elementId];
      if (!el?.richText) continue;
      const nextRich = structuredClone(el.richText) as typeof el.richText & {
        rich?: IDocumentData;
      };
      const body = nextRich.rich?.body;
      if (body && Array.isArray(body.textRuns)) {
        const text = body.dataStream ?? '';
        const len = text.length;
        const runs = body.textRuns as ITextRun[];
        if (runs.length === 0) {
          runs.push({ st: 0, ed: Math.max(len - 1, 0), ts: {} });
        }
        for (const r of runs) {
          if (!r.ts) r.ts = {};
          patch(r.ts as unknown as Record<string, unknown>);
        }
      }
      (flatPatch ?? patch)(nextRich as unknown as Record<string, unknown>);
      void cs.executeCommand('slide.mutation.update-element', {
        unitId,
        pageId: sel.pageId,
        elementId: sel.elementId,
        props: { richText: nextRich },
      });
      touched += 1;
    }
    return touched > 0;
  } catch {
    return false;
  }
}

// Is the user currently inside a Univer doc-model text edit session? If
// yes, doc.command.* will route to that doc. If no, doc.command.* silently
// no-ops, so we should style the selected element directly instead.
function isDocEditing(): boolean {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return false;
  try {
    return !!univer
      .__getInjector()
      .get(IUniverInstanceService)
      .getCurrentUnitOfType(UniverInstanceType.UNIVER_DOC);
  } catch {
    return false;
  }
}

// ============================================================ format state ===

// Local mirror of the inline-format toggle state. We can't subscribe to the
// docs-ui selection cleanly from outside the Univer DI scope without adding
// a fork patch, so this is a best-effort snapshot — each format command
// toggles the local flag optimistically. The visual `aria-pressed` state
// gives the user immediate feedback; when the selection moves the next
// keypress in the editor resyncs from Univer's actual run style.
interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  font: string;
  size: number;
  align: AlignValue;
  list: ListMode;
  lineSpacing: number;
  textColor: string | null;
  fillColor: string | null;
  borderColor: string | null;
}

const DEFAULT_FORMAT: FormatState = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  font: 'Calibri',
  size: 18,
  align: 'left',
  list: 'none',
  lineSpacing: 1.15,
  textColor: null,
  fillColor: null,
  borderColor: null,
};

// ============================================================ Toolbar ===

export function Toolbar() {
  const { t } = useTranslation();
  const { undos, redos } = useUndoRedoCounts();
  const rootRef = useRef<HTMLDivElement>(null);
  // Office-style ribbon: a tab strip selects which command groups the ribbon
  // body shows. Quick-access (undo/redo/print) + the Slideshow CTA stay
  // visible on every tab.
  const [activeTab, setActiveTab] = useState<'home' | 'insert' | 'design'>('home');

  const [format, setFormat] = useState<FormatState>(DEFAULT_FORMAT);
  // Fill/border act on the selected shape; disable when nothing is selected.
  const selectedEl = useSelectedElement();
  const hasShapeSelection = !!selectedEl;
  const [bgAnchor, setBgAnchor] = useState<DOMRect | null>(null);
  const [layoutAnchor, setLayoutAnchor] = useState<DOMRect | null>(null);
  // Category dropdowns — "Insert ▾" (text/image/shape/line) and "Slide ▾"
  // (new/layout/theme/background). Keeps the toolbar compact while leaving
  // text formatting flat + always visible.
  const [insertAnchor, setInsertAnchor] = useState<DOMRect | null>(null);
  const [slideAnchor, setSlideAnchor] = useState<DOMRect | null>(null);
  // "Arrange ▾" (z-order · align-to-slide · duplicate/delete) — PowerPoint's
  // [配置] dropdown. Acts on the selected element, so the trigger disables
  // when nothing is selected rather than opening a menu of dead items.
  const [arrangeAnchor, setArrangeAnchor] = useState<DOMRect | null>(null);
  // PowerPoint-style table size grid hover state (rows/cols the pointer is
  // over inside the Insert ▾ popover). null when not hovering the grid.
  const [tableHover, setTableHover] = useState<{ r: number; c: number } | null>(null);

  // Clipboard — Paste enablement mirrors the in-memory element clipboard so
  // the button doesn't read as broken when there's nothing to paste. We flip
  // it true after any copy/cut; the initial value honours a clipboard carried
  // over from a prior editor mount.
  const [canPaste, setCanPaste] = useState<boolean>(() => hasElementClipboard());

  // Format painter — one-shot "copy this element's look, apply to the next
  // one I click". Armed on click after capturing the selected element's text
  // + shape style; the selection-change effect below applies it to the next
  // distinct element, then disarms. Matches PowerPoint's single-use brush
  // (double-click-to-lock is out of scope for v1).
  const [painterArmed, setPainterArmed] = useState(false);
  const paintStyleRef = useRef<{
    text: Record<string, unknown> | null;
    shape: IShapeProperties | null;
    sourceId: string;
  } | null>(null);

  // Reflect the selected element's authored text style in the controls.
  // This is especially important after opening a PPTX with a family that is
  // not in the default deck; the picker keeps and displays that exact name.
  useEffect(() => {
    if (!selectedEl) return;
    try {
      const w = window as unknown as { univer?: Univer };
      const model = w.univer?.__getInjector().get(IUniverInstanceService)
        .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
      const richText = model?.getPage(selectedEl.pageId)?.pageElements?.[selectedEl.elementId]?.richText;
      if (!richText) return;
      const firstRun = richText.rich?.body?.textRuns?.[0]?.ts;
      setFormat((previous) => ({
        ...previous,
        font: firstRun?.ff || richText.ff || previous.font,
        size: firstRun?.fs || richText.fs || previous.size,
        bold: (firstRun?.bl ?? richText.bl) === 1,
        italic: (firstRun?.it ?? richText.it) === 1,
        underline: !!(firstRun?.ul ?? richText.ul),
        strikethrough: !!(firstRun?.st ?? richText.st),
      }));
    } catch {
      /* editor may be remounting after an import */
    }
  }, [selectedEl]);

  // Dismiss the Insert / Slide category popovers on outside click. They are
  // rendered inside the toolbar root, so a click outside rootRef closes them.
  const rootForDismiss = rootRef;
  useEffect(() => {
    if (!insertAnchor && !slideAnchor && !arrangeAnchor) return;
    const handler = (e: MouseEvent) => {
      if (!rootForDismiss.current?.contains(e.target as Node)) {
        setInsertAnchor(null);
        setSlideAnchor(null);
        setArrangeAnchor(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [insertAnchor, slideAnchor, arrangeAnchor, rootForDismiss]);

  // ─────────────────────────────────────────────── format painter
  // Snapshot the selected element's authored style. We read the SAME fields
  // the toolbar writes: run-level text style (ff/fs/bl/it/ul/st/cl) from the
  // first text run, and the shape's fill + outline. Returns false when there's
  // nothing selected to sample.
  function captureSelectedStyle(): boolean {
    const sel = getSelectedElement();
    if (!sel) return false;
    const w = window as unknown as { univer?: Univer };
    const model = w.univer
      ?.__getInjector()
      .get(IUniverInstanceService)
      .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    if (!model) return false;
    const el = model.getPage(sel.pageId)?.pageElements?.[sel.elementId];
    if (!el) return false;

    let text: Record<string, unknown> | null = null;
    const rt = el.richText as (typeof el.richText & { rich?: IDocumentData }) | undefined;
    if (rt) {
      const first = (rt.rich?.body?.textRuns?.[0]?.ts ?? {}) as Record<string, unknown>;
      const flat = rt as unknown as Record<string, unknown>;
      const pick = (k: string) => (first[k] !== undefined ? first[k] : flat[k]);
      text = {};
      for (const key of ['ff', 'fs', 'bl', 'it', 'ul', 'st', 'cl'] as const) {
        const v = pick(key);
        if (v !== undefined && v !== null) text[key] = structuredClone(v);
      }
      if (Object.keys(text).length === 0) text = null;
    }

    const shape = el.shape?.shapeProperties
      ? (structuredClone(el.shape.shapeProperties) as IShapeProperties)
      : null;

    if (!text && !shape) return false;
    paintStyleRef.current = { text, shape, sourceId: sel.elementId };
    return true;
  }

  // Apply the captured style to whatever element is selected NOW. Reuses the
  // same whole-element mutation helpers the manual toolbar buttons use, so the
  // write is collab/undo-consistent with a normal font/fill change.
  function applyCapturedStyle(): boolean {
    const snap = paintStyleRef.current;
    if (!snap) return false;
    let applied = false;
    if (snap.text) {
      const patch = snap.text;
      const ok = mutateSelectedTextStyle((ts) => {
        Object.assign(ts, patch);
      });
      applied = applied || ok;
    }
    if (snap.shape) {
      const src = snap.shape;
      const ok = mutateSelectedShape((sp) => {
        if (src.shapeBackgroundFill) sp.shapeBackgroundFill = structuredClone(src.shapeBackgroundFill);
        if (src.outline) sp.outline = structuredClone(src.outline);
      });
      applied = applied || ok;
    }
    return applied;
  }

  // While the painter is armed, the first selection change to a DIFFERENT
  // element receives the captured style; then we disarm. Clicking back on the
  // source element (or empty canvas) leaves the brush armed.
  useEffect(() => {
    if (!painterArmed) return;
    const snap = paintStyleRef.current;
    if (!snap || !selectedEl) return;
    if (selectedEl.elementId === snap.sourceId) return;
    applyCapturedStyle();
    setPainterArmed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEl, painterArmed]);

  function onPaintFormat() {
    if (painterArmed) {
      setPainterArmed(false);
      return;
    }
    if (captureSelectedStyle()) setPainterArmed(true);
  }

  // Helper for "icon toggle" buttons. If a text doc is being edited,
  // the doc.command.* path runs against the editor (run-level granularity).
  // Otherwise the user has the element selected from the slide canvas —
  // style the whole text element directly so the click actually does
  // something visible instead of silently no-op'ing.
  function toggleFormat(
    key: 'bold' | 'italic' | 'underline' | 'strikethrough',
    cmd: string,
  ) {
    const nextOn = !format[key];
    setFormat((prev) => ({ ...prev, [key]: nextOn }));
    if (isDocEditing()) {
      void dispatchSlideCommand(cmd);
      return;
    }
    // Apply to whole-element textRuns + flat fields.
    const flag = nextOn ? 1 : 0;
    mutateSelectedTextStyle((ts) => {
      if (key === 'bold') ts.bl = flag;
      else if (key === 'italic') ts.it = flag;
      else if (key === 'underline') ts.ul = { s: flag };
      else if (key === 'strikethrough') ts.st = { s: flag };
    });
  }
  function applyFontFamily(font: string) {
    setFormat((p) => ({ ...p, font }));
    if (isDocEditing()) {
      void dispatchSlideCommand('doc.command.set-inline-format-fontfamily', {
        value: font,
      });
      return;
    }
    mutateSelectedTextStyle((ts) => { ts.ff = font; });
  }
  function applyFontSize(size: number) {
    setFormat((p) => ({ ...p, size }));
    if (isDocEditing()) {
      void dispatchSlideCommand('doc.command.set-inline-format-fontsize', {
        value: size,
      });
      return;
    }
    mutateSelectedTextStyle((ts) => { ts.fs = size; });
  }

  // Fill / border target the SELECTED shape via the selection bridge.
  // shapeBackgroundFill → engine-render `fill`; outline → stroke. Both are
  // read by ShapeAdaptor on render, so the snapshot write repaints.
  // TODO(collab): direct snapshot write, not collab-safe.
  function applyFillColor(rgb: string) {
    const ok = mutateSelectedShape((sp) => {
      sp.shapeBackgroundFill = { rgb };
    });
    if (ok) setFormat((p) => ({ ...p, fillColor: rgb }));
  }
  function applyBorderColor(rgb: string) {
    const ok = mutateSelectedShape((sp) => {
      const transparent = /rgba?\([^)]*,\s*0\s*\)/i.test(rgb);
      sp.outline = {
        ...sp.outline,
        outlineFill: { rgb },
        // Give a first-time outline a visible weight; clearing drops it.
        weight: transparent ? 0 : sp.outline?.weight ?? 1,
        dashStyle: transparent
          ? BorderStyleTypes.NONE
          : sp.outline?.dashStyle ?? BorderStyleTypes.THIN,
      };
    });
    if (ok) setFormat((p) => ({ ...p, borderColor: rgb }));
  }
  function applyTextColor(rgb: string) {
    setFormat((p) => ({ ...p, textColor: rgb }));
    if (isDocEditing()) {
      void dispatchSlideCommand('doc.command.set-inline-format-text-color', {
        value: rgb,
      });
      return;
    }
    mutateSelectedTextStyle((ts) => { ts.cl = { rgb }; });
  }

  // ──────────────────────────────────────────────────── render groups
  // Each group is a fragment of reused controls; the ribbon body places
  // them under the active tab and labels them (see `ribbonGroup` below).
  const group1 = (
    <>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:undoShortcut')}
        aria-label={t('toolbar:undo')}
        disabled={undos === 0}
        onClick={() => void dispatchSlideCommand('univer.command.undo')}
      >
        <Icon name="undo" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:redoShortcut')}
        aria-label={t('toolbar:redo')}
        disabled={redos === 0}
        onClick={() => void dispatchSlideCommand('univer.command.redo')}
      >
        <Icon name="redo" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:printShortcut')}
        aria-label={t('toolbar:print')}
        onClick={() => void dispatchSlideCommand('casual-slides.command.print')}
      >
        <Icon name="print" size={18} />
      </button>
    </>
  );

  // Clipboard group — PowerPoint's Home-tab leading cluster: Paste · Cut ·
  // Copy · Format painter. Cut/Copy/Paint act on the selected element; Paste
  // drops the in-memory clipboard element onto the active slide. All dispatch
  // real casual-slides commands (see univer/commands.ts) — no faked buttons.
  const groupClipboard = (
    <>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:pasteShortcut')}
        aria-label={t('toolbar:paste')}
        disabled={!canPaste}
        onClick={() => void dispatchSlideCommand('casual-slides.command.paste-element')}
      >
        <Icon name="content_paste" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:cutShortcut')}
        aria-label={t('toolbar:cut')}
        disabled={!hasShapeSelection}
        onClick={async () => {
          const ok = await dispatchSlideCommand('casual-slides.command.cut-element');
          if (ok) setCanPaste(true);
        }}
      >
        <Icon name="content_cut" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:copyShortcut')}
        aria-label={t('toolbar:copy')}
        disabled={!hasShapeSelection}
        onClick={async () => {
          const ok = await dispatchSlideCommand('casual-slides.command.copy-element');
          if (ok) setCanPaste(true);
        }}
      >
        <Icon name="content_copy" size={18} />
      </button>
      <button
        type="button"
        className={`cs-toolbar2__btn ${painterArmed ? 'is-active' : ''}`}
        title={t('toolbar:paintFormat')}
        aria-label={t('toolbar:paintFormat')}
        aria-pressed={painterArmed}
        disabled={!hasShapeSelection && !painterArmed}
        onClick={onPaintFormat}
      >
        <Icon name="format_paint" size={18} filled={painterArmed} />
      </button>
    </>
  );

  // "Insert ▾" category dropdown trigger.
  const groupInsert = (
    <button
      type="button"
      className="cs-toolbar2__btn cs-toolbar2__btn--labeled"
      title={t('toolbar:group.insert')}
      aria-label={t('toolbar:group.insert')}
      aria-haspopup="menu"
      aria-expanded={!!insertAnchor}
      onClick={(e) => {
        setSlideAnchor(null);
        setInsertAnchor(insertAnchor ? null : e.currentTarget.getBoundingClientRect());
      }}
    >
      <Icon name="text_fields" size={18} />
      <span className="cs-toolbar2__btn-label">{t('toolbar:group.insert')}</span>
      <Icon name="expand_more" size={14} className="cs-toolbar2__caret" />
    </button>
  );

  // "Slide ▾" category dropdown trigger.
  const groupSlide = (
    <button
      type="button"
      className="cs-toolbar2__btn cs-toolbar2__btn--labeled"
      title={t('toolbar:group.slide')}
      aria-label={t('toolbar:group.slide')}
      aria-haspopup="menu"
      aria-expanded={!!slideAnchor}
      onClick={(e) => {
        setInsertAnchor(null);
        setSlideAnchor(slideAnchor ? null : e.currentTarget.getBoundingClientRect());
      }}
    >
      <Icon name="add_to_photos" size={18} />
      <span className="cs-toolbar2__btn-label">{t('toolbar:group.slide')}</span>
      <Icon name="expand_more" size={14} className="cs-toolbar2__caret" />
    </button>
  );

  // Theme / Background / Layout as INLINE toolbar buttons (Audit S2).
  // Promoted out of the Slide ▾ dropdown so users coming from Google
  // Slides see them at first glance. The Slide ▾ dropdown still keeps
  // them for habit-path users. All three reuse the existing picker
  // anchor state (no new state needed).
  const groupTheme = (
    <button
      type="button"
      className="cs-toolbar2__btn cs-toolbar2__btn--labeled"
      title={t('toolbar:theme')}
      aria-label={t('toolbar:theme')}
      onClick={() => {
        setInsertAnchor(null);
        setSlideAnchor(null);
        (window as Window & { __casualSlides_openThemes?: () => void })
          .__casualSlides_openThemes?.();
      }}
    >
      <Icon name="palette" size={18} />
      <span className="cs-toolbar2__btn-label">{t('toolbar:theme')}</span>
    </button>
  );

  const groupBackground = (
    <button
      type="button"
      className="cs-toolbar2__btn cs-toolbar2__btn--labeled"
      title={t('toolbar:background')}
      aria-label={t('toolbar:background')}
      aria-haspopup="dialog"
      aria-expanded={!!bgAnchor}
      onClick={(e) => {
        setInsertAnchor(null);
        setSlideAnchor(null);
        setBgAnchor(bgAnchor ? null : e.currentTarget.getBoundingClientRect());
      }}
    >
      <Icon name="gradient" size={18} />
      <span className="cs-toolbar2__btn-label">{t('toolbar:background')}</span>
    </button>
  );

  const groupLayout = (
    <button
      type="button"
      className="cs-toolbar2__btn cs-toolbar2__btn--labeled"
      title={t('toolbar:layout')}
      aria-label={t('toolbar:layout')}
      aria-haspopup="dialog"
      aria-expanded={!!layoutAnchor}
      onClick={(e) => {
        setInsertAnchor(null);
        setSlideAnchor(null);
        setLayoutAnchor(layoutAnchor ? null : e.currentTarget.getBoundingClientRect());
      }}
    >
      <Icon name="view_module" size={18} />
      <span className="cs-toolbar2__btn-label">{t('toolbar:layout')}</span>
    </button>
  );

  // "Arrange ▾" category dropdown trigger — PowerPoint's [配置] menu. Every
  // item needs a selected element, so the whole trigger disables (with a
  // "select a shape first" hint) rather than opening a menu of no-ops.
  const groupArrange = (
    <button
      type="button"
      className="cs-toolbar2__btn cs-toolbar2__btn--labeled"
      title={hasShapeSelection ? t('toolbar:group.arrange') : t('toolbar:selectShapeFirst')}
      aria-label={t('toolbar:group.arrange')}
      aria-haspopup="menu"
      aria-expanded={!!arrangeAnchor}
      disabled={!hasShapeSelection}
      onClick={(e) => {
        setInsertAnchor(null);
        setSlideAnchor(null);
        setArrangeAnchor(arrangeAnchor ? null : e.currentTarget.getBoundingClientRect());
      }}
    >
      <Icon name="auto_awesome_motion" size={18} />
      <span className="cs-toolbar2__btn-label">{t('toolbar:group.arrange')}</span>
      <Icon name="expand_more" size={14} className="cs-toolbar2__caret" />
    </button>
  );

  const group6 = (
    <>
      <FontFamilyPicker
        value={format.font}
        onChange={applyFontFamily}
      />
      <FontSizePicker
        value={format.size}
        onChange={applyFontSize}
      />
      <button
        type="button"
        className={`cs-toolbar2__btn ${format.bold ? 'is-active' : ''}`}
        title={t('toolbar:boldShortcut')}
        aria-label={t('toolbar:bold')}
        aria-pressed={format.bold}
        onClick={() => toggleFormat('bold', 'doc.command.set-inline-format-bold')}
      >
        <Icon name="bold" size={18} filled={format.bold} />
      </button>
      <button
        type="button"
        className={`cs-toolbar2__btn ${format.italic ? 'is-active' : ''}`}
        title={t('toolbar:italicShortcut')}
        aria-label={t('toolbar:italic')}
        aria-pressed={format.italic}
        onClick={() => toggleFormat('italic', 'doc.command.set-inline-format-italic')}
      >
        <Icon name="italic" size={18} filled={format.italic} />
      </button>
      <button
        type="button"
        className={`cs-toolbar2__btn ${format.underline ? 'is-active' : ''}`}
        title={t('toolbar:underlineShortcut')}
        aria-label={t('toolbar:underline')}
        aria-pressed={format.underline}
        onClick={() => toggleFormat('underline', 'doc.command.set-inline-format-underline')}
      >
        <Icon name="underline" size={18} filled={format.underline} />
      </button>
      <button
        type="button"
        className={`cs-toolbar2__btn ${format.strikethrough ? 'is-active' : ''}`}
        title={t('toolbar:strikethroughShortcut')}
        aria-label={t('toolbar:strikethrough')}
        aria-pressed={format.strikethrough}
        onClick={() => toggleFormat('strikethrough', 'doc.command.set-inline-format-strikethrough')}
      >
        <Icon name="strikethrough" size={18} filled={format.strikethrough} />
      </button>
      <ColorPicker
        scope="text"
        value={format.textColor}
        onPick={applyTextColor}
        icon="format_color_text"
        label={t('toolbar:textColor')}
      />
      <ColorPicker
        scope="fill"
        value={format.fillColor}
        onPick={applyFillColor}
        onClear={() => applyFillColor('rgba(0,0,0,0)')}
        icon="format_color_fill"
        label={t('toolbar:fillColor')}
        disabled={!hasShapeSelection}
        disabledTitle={t('toolbar:selectShapeFirst')}
      />
      <ColorPicker
        scope="border"
        value={format.borderColor}
        onPick={applyBorderColor}
        onClear={() => applyBorderColor('rgba(0,0,0,0)')}
        icon="border_color"
        label={t('toolbar:borderColor')}
        disabled={!hasShapeSelection}
        disabledTitle={t('toolbar:selectShapeFirst')}
      />
    </>
  );

  const group7 = (
    <>
      <AlignPicker
        value={format.align}
        onChange={(align) => setFormat((p) => ({ ...p, align }))}
      />
      <ListPicker
        mode={format.list}
        onChange={(list) => setFormat((p) => ({ ...p, list }))}
      />
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:indentDecrease')}
        aria-label={t('toolbar:indentDecrease')}
        onClick={() =>
          void dispatchSlideCommand('doc.command.change-list-nesting-level', { type: 'decrease' })
        }
      >
        <Icon name="format_indent_decrease" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:indentIncrease')}
        aria-label={t('toolbar:indentIncrease')}
        onClick={() =>
          void dispatchSlideCommand('doc.command.change-list-nesting-level', { type: 'increase' })
        }
      >
        <Icon name="format_indent_increase" size={18} />
      </button>
      {/* Line spacing — writes the paragraph's lineSpacing multiplier via
          `doc-paragraph-setting.command`. */}
      <LineSpacingPicker
        value={format.lineSpacing}
        onChange={(lineSpacing) => setFormat((p) => ({ ...p, lineSpacing }))}
      />
      {/* Clear formatting — resets paragraph (NORMAL_TEXT) + inline run style
          across the selection. Both reachable docs-ui commands; see
          `clearFormatting` in univer/commands.ts. */}
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:clearFormatting')}
        aria-label={t('toolbar:clearFormatting')}
        onClick={() => void clearFormatting()}
      >
        <Icon name="format_clear" size={18} />
      </button>
      {/* Insert link — opens Univer's hyperlink popup over the selected
          text run. Plugin pair `@univerjs/docs-hyper-link[-ui]` registers
          the operation; it no-ops if the caret isn't inside an editable
          text frame with a non-collapsed selection. Ctrl+K shortcut is
          registered by the plugin via `whenDocAndEditorFocused`. */}
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar:insertLinkShortcut')}
        aria-label={t('toolbar:insertLink')}
        onClick={() => void dispatchSlideCommand('casual-slides.command.insert-link')}
      >
        <Icon name="link" size={18} />
      </button>
    </>
  );

  // Wrap a set of reused controls in an Office-style ribbon group: the
  // controls on top, the localized group name underneath (as PowerPoint does).
  const ribbonGroup = (labelKey: string, controls: ReactNode) => (
    <div className="cs-ribbon__group">
      <div className="cs-ribbon__group-controls">{controls}</div>
      <div className="cs-ribbon__group-label">{t(labelKey)}</div>
    </div>
  );
  const sep = <span className="cs-ribbon__group-sep" aria-hidden="true" />;

  const slideshowCta = (
    <button
      type="button"
      className="cs-btn cs-btn--ghost"
      title={t('toolbar:slideshowShortcut')}
      aria-label={t('toolbar:slideshow')}
      onClick={() => {
        const open = (window as Window & { __casualSlides_openSlideshow?: () => void })
          .__casualSlides_openSlideshow;
        open?.();
      }}
    >
      {/* De-saturated to ghost styling — Present is the bottom-right
          status-bar primary path (Audit S3). This stays for users
          who reach for the toolbar end out of habit, but doesn't
          compete for color hierarchy with Save. Audit P4. */}
      <Icon name="play_arrow" size={18} />
      <span>{t('toolbar:slideshow')}</span>
    </button>
  );

  const TABS = ['home', 'insert', 'design'] as const;

  return (
    <div className="cs-toolbar cs-ribbon" ref={rootRef}>
      <div className="cs-ribbon__tabs" role="tablist" aria-label={t('toolbar:group.actions')}>
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`cs-ribbon__tab${activeTab === tab ? ' is-active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {t(`toolbar:ribbon.${tab}`)}
          </button>
        ))}
      </div>

      <div className="cs-ribbon__body" role="toolbar" aria-label={t('toolbar:group.actions')}>
        {/* Persistent quick-access group — visible on every tab. */}
        {ribbonGroup('toolbar:ribbonGroup.quickAccess', group1)}
        {sep}

        {activeTab === 'home' && (
          <>
            {ribbonGroup('toolbar:group.clipboard', groupClipboard)}
            {sep}
            {ribbonGroup('toolbar:group.slide', <>{groupSlide}{groupLayout}</>)}
            {sep}
            {ribbonGroup('toolbar:ribbonGroup.font', group6)}
            {sep}
            {ribbonGroup('toolbar:group.paragraph', group7)}
            {sep}
            {ribbonGroup('toolbar:group.arrange', groupArrange)}
          </>
        )}

        {activeTab === 'insert' && ribbonGroup('toolbar:group.insert', groupInsert)}

        {activeTab === 'design' && (
          <>
            {ribbonGroup('toolbar:ribbonGroup.theme', groupTheme)}
            {sep}
            {ribbonGroup('toolbar:ribbonGroup.background', <>{groupBackground}{groupLayout}</>)}
          </>
        )}

        <div className="cs-toolbar__spacer" />
        {slideshowCta}
      </div>

      {/* Insert ▾ category popover */}
      {insertAnchor && (
        <div
          className="cs-toolbar2__popover cs-toolbar2__popover--insert"
          style={{ top: insertAnchor.bottom + 6, left: insertAnchor.left }}
          role="menu"
          aria-label={t('toolbar:group.insert')}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseLeave={() => setTableHover(null)}
        >
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setInsertAnchor(null); void dispatchSlideCommand('slide.command.add-text'); }}>
            <Icon name="text_fields" size={16} /><span>{t('toolbar:textBox')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setInsertAnchor(null); void dispatchSlideCommand('slide.command.insert-float-image'); }}>
            <Icon name="image" size={16} /><span>{t('toolbar:image')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setInsertAnchor(null); insertShapeOfType('line'); }}>
            <Icon name="horizontal_rule" size={16} /><span>{t('toolbar:line')}</span>
          </button>
          <div className="cs-toolbar2__popover-sep" role="separator" />
          <div className="cs-toolbar2__popover-label">{t('toolbar:shape')}</div>
          <div className="cs-toolbar2__shape-grid">
            {SHAPES_MENU.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="cs-toolbar2__shape-cell"
                title={t(item.labelKey)}
                aria-label={t(item.labelKey)}
                onClick={() => {
                  setInsertAnchor(null);
                  if (item.shapeType) insertShapeOfType(item.shapeType);
                  else if (item.cmd) void dispatchSlideCommand(item.cmd);
                }}
              >
                <Icon name={item.icon} size={18} />
              </button>
            ))}
          </div>
          <div className="cs-toolbar2__popover-sep" role="separator" />
          <div className="cs-toolbar2__popover-label">
            {tableHover ? `${tableHover.r + 1} × ${tableHover.c + 1}` : t('toolbar:table')}
          </div>
          <div
            className="cs-toolbar2__table-grid"
            role="menu"
            aria-label={t('toolbar:table')}
          >
            {Array.from({ length: 6 }, (_row, r) =>
              Array.from({ length: 8 }, (_col, c) => {
                const on = !!tableHover && r <= tableHover.r && c <= tableHover.c;
                return (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    role="menuitem"
                    className={`cs-toolbar2__table-cell${on ? ' is-on' : ''}`}
                    aria-label={`${r + 1} × ${c + 1}`}
                    onMouseEnter={() => setTableHover({ r, c })}
                    onFocus={() => setTableHover({ r, c })}
                    onClick={() => {
                      setInsertAnchor(null);
                      setTableHover(null);
                      insertTableOfSize(r + 1, c + 1);
                    }}
                  />
                );
              }),
            )}
          </div>
        </div>
      )}

      {/* Slide ▾ category popover */}
      {slideAnchor && (
        <div
          className="cs-toolbar2__popover cs-toolbar2__popover--slidecat"
          style={{ top: slideAnchor.bottom + 6, left: slideAnchor.left }}
          role="menu"
          aria-label={t('toolbar:group.slide')}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setSlideAnchor(null); void dispatchSlideCommand('slide.operation.append-slide'); }}>
            <Icon name="add_to_photos" size={16} /><span>{t('toolbar:newSlide')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setSlideAnchor(null); void dispatchSlideCommand('slide.command.duplicate-slide'); }}>
            <Icon name="content_copy" size={16} /><span>{t('toolbar:duplicateSlide')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { const r = slideAnchor; setSlideAnchor(null); setLayoutAnchor(r); }}>
            <Icon name="view_compact" size={16} /><span>{t('toolbar:layout')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setSlideAnchor(null); (window as Window & { __casualSlides_openThemes?: () => void }).__casualSlides_openThemes?.(); }}>
            <Icon name="palette" size={16} /><span>{t('toolbar:theme')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { const r = slideAnchor; setSlideAnchor(null); setBgAnchor(r); }}>
            <Icon name="format_color_fill" size={16} /><span>{t('toolbar:background')}</span>
          </button>
        </div>
      )}

      {/* Arrange ▾ category popover — z-order · align-to-slide · duplicate/delete */}
      {arrangeAnchor && (
        <div
          className="cs-toolbar2__popover cs-toolbar2__popover--slidecat"
          style={{ top: arrangeAnchor.bottom + 6, left: arrangeAnchor.left }}
          role="menu"
          aria-label={t('toolbar:group.arrange')}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setArrangeAnchor(null); void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'front' }); }}>
            <Icon name="flip_to_front" size={16} /><span>{t('toolbar:bringToFront')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setArrangeAnchor(null); void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'forward' }); }}>
            <Icon name="arrow_upward" size={16} /><span>{t('toolbar:bringForward')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setArrangeAnchor(null); void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'backward' }); }}>
            <Icon name="arrow_downward" size={16} /><span>{t('toolbar:sendBackward')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setArrangeAnchor(null); void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'back' }); }}>
            <Icon name="flip_to_back" size={16} /><span>{t('toolbar:sendToBack')}</span>
          </button>
          <div className="cs-toolbar2__popover-sep" role="separator" />
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setArrangeAnchor(null); void dispatchSlideCommand('casual-slides.command.center-on-slide', { axis: 'both' }); }}>
            <Icon name="filter_center_focus" size={16} /><span>{t('toolbar:centerOnSlide')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setArrangeAnchor(null); void dispatchSlideCommand('casual-slides.command.center-on-slide', { axis: 'h' }); }}>
            <Icon name="format_align_center" size={16} /><span>{t('toolbar:alignCenterHorizontal')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setArrangeAnchor(null); void dispatchSlideCommand('casual-slides.command.center-on-slide', { axis: 'v' }); }}>
            <Icon name="vertical_align_center" size={16} /><span>{t('toolbar:alignMiddleVertical')}</span>
          </button>
          <div className="cs-toolbar2__popover-sep" role="separator" />
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setArrangeAnchor(null); void dispatchSlideCommand('casual-slides.command.duplicate-element'); }}>
            <Icon name="content_copy" size={16} /><span>{t('toolbar:duplicate')}</span>
          </button>
          <button type="button" role="menuitem" className="cs-toolbar2__popover-item"
            onClick={() => { setArrangeAnchor(null); void dispatchSlideCommand('casual-slides.command.delete-element'); }}>
            <Icon name="delete" size={16} /><span>{t('toolbar:deleteElement')}</span>
          </button>
        </div>
      )}

      <BackgroundPicker anchorRect={bgAnchor} onClose={() => setBgAnchor(null)} />
      <LayoutPicker anchorRect={layoutAnchor} onClose={() => setLayoutAnchor(null)} />
    </div>
  );
}

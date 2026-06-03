// Toolbar v2 — Google Slides-grade single-row formatting toolbar.
//
// Layout (left to right):
//   Group 1: Undo · Redo · Print · Paint format
//   Group 3: Text box · Image · Shape · Line
//   Group 5: New slide · Layout · Theme · Background
//   Group 6: Font family · Font size · Bold · Italic · Underline · Strikethrough · Text color · Fill color · Border color
//   Group 7: Align · Bullet · Number · Indent- · Indent+ · Line spacing · Clear formatting
//   Group 8: Slideshow CTA (right-aligned)
//
// The row never scrolls horizontally. A ResizeObserver tracks the toolbar
// width — when the natural width of the children exceeds the available
// space, groups 6 + 7 collapse into a single "More" popover so the rest
// stays visible.
//
// All formatting controls dispatch existing Univer commands (see the
// constants below + univer/commands.ts). Where a command is genuinely
// missing in v0.24.0 (paint format, insert link, vertical-align) the
// control is left OUT entirely rather than rendered as an inert button —
// a dead button reads as broken. We never fake a dispatch.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Univer, IShapeProperties, ITextRun, IDocumentData } from '@univerjs/core';
import { BorderStyleTypes, ICommandService, IUndoRedoService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { useTranslation } from '../i18n';
import { clearFormatting, dispatchSlideCommand } from '../univer/commands';
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
import { OverflowPopover } from './toolbar/OverflowPopover';

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
  } catch {
    /* silent — Univer not ready */
  }
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
  font: 'Inter',
  size: 18,
  align: 'left',
  list: 'none',
  lineSpacing: 1.15,
  textColor: null,
  fillColor: null,
  borderColor: null,
};

// ============================================================ resize ===

// Threshold breakdown:
//   - Groups 1+3+5 (icon-only) ≈ 320 px including separators
//   - Group 6 (font+size+B/I/U/S+3 colors) ≈ 440 px
//   - Group 7 (align/list/indent×2/spacing/clear/link) ≈ 260 px
//   - Slideshow CTA + padding ≈ 160 px
// Overflow is detected by measuring the inner row's scrollWidth vs its
// clientWidth — anything that genuinely overflows the available space
// triggers the "More" popover. Estimating from a hardcoded breakpoint is
// brittle: pickers grow with i18n labels, locale, font, etc. Real
// measurement Just Works.
//
// We need two passes per tick:
//   1. Force `overflow=false` so groups 6+7 render inline, then measure.
//   2. If the row's scrollWidth exceeds clientWidth, set `overflow=true`
//      and re-render — the inline groups fold into the More popover.
//
// We add a small hysteresis (8 px) so a borderline width doesn't
// thrash between expanded/collapsed on every resize tick.
function useToolbarOverflow(rootRef: React.RefObject<HTMLDivElement>): boolean {
  const [overflow, setOverflow] = useState(false);

  // Measure on every relevant change. We re-measure after the DOM commits
  // by reading scrollWidth from the inner row element.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const HYSTERESIS = 8;
    const measure = () => {
      const row = el.querySelector('.cs-toolbar2__row') as HTMLElement | null;
      if (!row) return;
      const sw = row.scrollWidth;
      const cw = row.clientWidth;
      setOverflow((prev) => {
        // If inline content exceeds available width → collapse.
        if (!prev && sw > cw + HYSTERESIS) return true;
        // If collapsed and the available width grew enough that all the
        // hidden groups + a margin could fit back, expand again. We
        // approximate the hidden groups as ~430 px (group 6) + ~330 px
        // (group 7) + 26 px of separators = ~786 px. When clientWidth
        // grows back past scrollWidth + 786 + HYSTERESIS, the previously
        // hidden groups should fit inline again.
        if (prev && cw > sw + 786 + HYSTERESIS) return false;
        return prev;
      });
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    const row = el.querySelector('.cs-toolbar2__row');
    if (row) ro.observe(row as Element);
    return () => ro.disconnect();
  }, [rootRef]);

  return overflow;
}

// ============================================================ Toolbar ===

export function Toolbar() {
  const { t } = useTranslation();
  const { undos, redos } = useUndoRedoCounts();
  const rootRef = useRef<HTMLDivElement>(null);
  const overflow = useToolbarOverflow(rootRef);

  const [format, setFormat] = useState<FormatState>(DEFAULT_FORMAT);
  // Fill/border act on the selected shape; disable when nothing is selected.
  const selectedEl = useSelectedElement();
  const hasShapeSelection = !!selectedEl;
  const [bgAnchor, setBgAnchor] = useState<DOMRect | null>(null);
  const [layoutAnchor, setLayoutAnchor] = useState<DOMRect | null>(null);
  const [overflowAnchor, setOverflowAnchor] = useState<DOMRect | null>(null);
  // Category dropdowns — "Insert ▾" (text/image/shape/line) and "Slide ▾"
  // (new/layout/theme/background). Keeps the toolbar compact while leaving
  // text formatting flat + always visible.
  const [insertAnchor, setInsertAnchor] = useState<DOMRect | null>(null);
  const [slideAnchor, setSlideAnchor] = useState<DOMRect | null>(null);

  // Dismiss the Insert / Slide category popovers on outside click. They are
  // rendered inside the toolbar root, so a click outside rootRef closes them.
  const rootForDismiss = rootRef;
  useEffect(() => {
    if (!insertAnchor && !slideAnchor) return;
    const handler = (e: MouseEvent) => {
      if (!rootForDismiss.current?.contains(e.target as Node)) {
        setInsertAnchor(null);
        setSlideAnchor(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [insertAnchor, slideAnchor, rootForDismiss]);

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
  // Each group is wrapped in a fragment so the overflow logic can swap
  // chunks of buttons out cleanly.
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
      {/* Paint format omitted until Univer exposes a copy-format pipe — a
          dead button is worse UX than no button. TODO(univer). */}
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

  return (
    <div className="cs-toolbar" ref={rootRef}>
      <div className="cs-toolbar2__row" role="toolbar" aria-label={t('toolbar:group.actions')}>
        {group1}
        <span className="cs-toolbar__sep" aria-hidden="true" />
        {groupInsert}
        {groupSlide}
        {/* Audit S2 — inline Theme / Background / Layout, promoted out
            of the Slide ▾ dropdown so they're discoverable at a glance. */}
        <span className="cs-toolbar__sep" aria-hidden="true" />
        {groupLayout}
        {groupTheme}
        {groupBackground}
        {/* Character formatting (font / size / B I U S / colours) is ALWAYS
            visible — never hidden behind "More". Only the secondary paragraph
            group (align / list / indent) collapses when space is tight. */}
        <span className="cs-toolbar__sep" aria-hidden="true" />
        {group6}
        {!overflow && (
          <>
            <span className="cs-toolbar__sep" aria-hidden="true" />
            {group7}
          </>
        )}
        {overflow && (
          <>
            <span className="cs-toolbar__sep" aria-hidden="true" />
            <button
              type="button"
              className="cs-toolbar2__btn"
              title={t('toolbar:moreActions')}
              aria-label={t('toolbar:moreActions')}
              aria-haspopup="dialog"
              aria-expanded={!!overflowAnchor}
              onClick={(e) =>
                setOverflowAnchor(overflowAnchor ? null : e.currentTarget.getBoundingClientRect())
              }
            >
              <Icon name="more_vert" size={18} />
            </button>
          </>
        )}
        <div className="cs-toolbar__spacer" />
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
      </div>

      {/* Insert ▾ category popover */}
      {insertAnchor && (
        <div
          className="cs-toolbar2__popover cs-toolbar2__popover--insert"
          style={{ top: insertAnchor.bottom + 6, left: insertAnchor.left }}
          role="menu"
          aria-label={t('toolbar:group.insert')}
          onMouseDown={(e) => e.stopPropagation()}
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

      {overflow && overflowAnchor && (
        <OverflowPopover anchor={overflowAnchor} onClose={() => setOverflowAnchor(null)}>
          {group7}
        </OverflowPopover>
      )}

      <BackgroundPicker anchorRect={bgAnchor} onClose={() => setBgAnchor(null)} />
      <LayoutPicker anchorRect={layoutAnchor} onClose={() => setLayoutAnchor(null)} />
    </div>
  );
}

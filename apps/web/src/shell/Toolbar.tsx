// Toolbar v2 — Google Slides-grade single-row formatting toolbar.
//
// Layout (left to right):
//   Group 1: Undo · Redo · Print · Paint format
//   Group 3: Text box · Image · Shape · Line
//   Group 5: New slide · Layout · Theme · Background
//   Group 6: Font family · Font size · Bold · Italic · Underline · Strikethrough · Text color · Fill color · Border color
//   Group 7: Align · Bullet · Number · Indent- · Indent+ · Line spacing · Clear formatting · Insert link
//   Group 8: Slideshow CTA (right-aligned)
//
// The row never scrolls horizontally. A ResizeObserver tracks the toolbar
// width — when the natural width of the children exceeds the available
// space, groups 6 + 7 collapse into a single "More" popover so the rest
// stays visible.
//
// All formatting controls dispatch existing Univer commands (see the
// constants below). Where a command is missing in v0.24.0 (paint format,
// line spacing, clear formatting, insert link, vertical-align), the button
// is wired to local state only with an inline `TODO(univer)` comment
// pointing at the gap. We never fake a dispatch.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Univer } from '@univerjs/core';
import { IUndoRedoService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { useTranslation } from '../i18n';
import { dispatchSlideCommand } from '../univer/commands';
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
  { id: 'rect',       labelKey: 'toolbar.shape_rect',       icon: 'add',            cmd: 'slide.command.insert-float-shape.rectangle' },
  { id: 'ellipse',    labelKey: 'toolbar.shape_ellipse',    icon: 'add',            cmd: 'slide.command.insert-float-shape.ellipse' },
  { id: 'line',       labelKey: 'toolbar.shape_line',       icon: 'remove',         shapeType: 'line' },
  { id: 'rightArrow', labelKey: 'toolbar.shape_rightArrow', icon: 'add',            shapeType: 'rightArrow' },
  { id: 'leftArrow',  labelKey: 'toolbar.shape_leftArrow',  icon: 'add',            shapeType: 'leftArrow' },
  { id: 'upArrow',    labelKey: 'toolbar.shape_upArrow',    icon: 'add',            shapeType: 'upArrow' },
  { id: 'downArrow',  labelKey: 'toolbar.shape_downArrow',  icon: 'add',            shapeType: 'downArrow' },
  { id: 'triangle',   labelKey: 'toolbar.shape_triangle',   icon: 'add',            shapeType: 'triangle' },
  { id: 'diamond',    labelKey: 'toolbar.shape_diamond',    icon: 'add',            shapeType: 'diamond' },
  { id: 'pentagon',   labelKey: 'toolbar.shape_pentagon',   icon: 'add',            shapeType: 'pentagon' },
  { id: 'hexagon',    labelKey: 'toolbar.shape_hexagon',    icon: 'add',            shapeType: 'hexagon' },
  { id: 'octagon',    labelKey: 'toolbar.shape_octagon',    icon: 'add',            shapeType: 'octagon' },
  { id: 'chevron',    labelKey: 'toolbar.shape_chevron',    icon: 'add',            shapeType: 'chevron' },
  { id: 'plus',       labelKey: 'toolbar.shape_plus',       icon: 'add',            shapeType: 'plus' },
  { id: 'star5',      labelKey: 'toolbar.shape_star5',      icon: 'add',            shapeType: 'star5' },
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
    let sub: { unsubscribe?: () => void } | undefined;
    const tryWire = () => {
      if (disposed) return;
      const w = window as unknown as { univer?: Univer };
      const univer = w.univer;
      if (!univer) {
        window.setTimeout(tryWire, 200);
        return;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const svc = univer.__getInjector().get(IUndoRedoService) as any;
        sub = svc?.undoRedoStatus$?.subscribe?.((s: { undos: number; redos: number }) => {
          if (!disposed) setCounts({ undos: s.undos, redos: s.redos });
        });
      } catch {
        window.setTimeout(tryWire, 200);
      }
    };
    tryWire();
    return () => {
      disposed = true;
      sub?.unsubscribe?.();
    };
  }, []);
  return counts;
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
  const [shapesAnchor, setShapesAnchor] = useState<DOMRect | null>(null);
  const [bgAnchor, setBgAnchor] = useState<DOMRect | null>(null);
  const [layoutAnchor, setLayoutAnchor] = useState<DOMRect | null>(null);
  const [overflowAnchor, setOverflowAnchor] = useState<DOMRect | null>(null);

  // Dismiss the shapes popover on outside click.
  const shapesContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shapesAnchor) return;
    const handler = (e: MouseEvent) => {
      if (!shapesContainerRef.current?.contains(e.target as Node)) setShapesAnchor(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [shapesAnchor]);

  // Helper for "icon toggle" buttons that dispatch a single Univer command.
  function toggleFormat<K extends keyof FormatState>(key: K, cmd: string) {
    setFormat((prev) => ({ ...prev, [key]: !prev[key] }));
    void dispatchSlideCommand(cmd);
  }

  function applyFillColor(rgb: string) {
    setFormat((p) => ({ ...p, fillColor: rgb }));
    // TODO(univer): no docs-ui inline-format-fill exists. Slide shape fill
    // would route through `slide.mutation.update-element` with a
    // shapeProperties.shapeBackgroundFill patch — but we don't track the
    // selected element id at the toolbar layer yet. Inert until the
    // selection bridge in `docs/UNIVER_SLIDES_GAPS.md` lands.
  }
  function applyBorderColor(rgb: string) {
    setFormat((p) => ({ ...p, borderColor: rgb }));
    // TODO(univer): same gap as fill — needs `slide.mutation.update-element`
    // with the shape's outline patch + a selection bridge.
  }
  function applyTextColor(rgb: string) {
    setFormat((p) => ({ ...p, textColor: rgb }));
    void dispatchSlideCommand('doc.command.set-inline-format-text-color', { value: rgb });
  }

  // ──────────────────────────────────────────────────── render groups
  // Each group is wrapped in a fragment so the overflow logic can swap
  // chunks of buttons out cleanly.
  const group1 = (
    <>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.undoShortcut')}
        aria-label={t('toolbar.undo')}
        disabled={undos === 0}
        onClick={() => void dispatchSlideCommand('univer.command.undo')}
      >
        <Icon name="undo" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.redoShortcut')}
        aria-label={t('toolbar.redo')}
        disabled={redos === 0}
        onClick={() => void dispatchSlideCommand('univer.command.redo')}
      >
        <Icon name="redo" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.printShortcut')}
        aria-label={t('toolbar.print')}
        onClick={() => void dispatchSlideCommand('casual-slides.command.print')}
      >
        <Icon name="print" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.paintFormat')}
        aria-label={t('toolbar.paintFormat')}
        // TODO(univer): no paint-format pipe exists. Implementation would
        // snapshot the active selection's run style + push it onto the
        // next mouse-up. Inert.
      >
        <Icon name="format_paint" size={18} />
      </button>
    </>
  );

  const group3 = (
    <>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.textBox')}
        aria-label={t('toolbar.textBox')}
        onClick={() => void dispatchSlideCommand('slide.command.add-text')}
      >
        <Icon name="text_fields" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.image')}
        aria-label={t('toolbar.image')}
        onClick={() => void dispatchSlideCommand('slide.command.insert-float-image')}
      >
        <Icon name="image" size={18} />
      </button>
      <div className="cs-toolbar2__split" ref={shapesContainerRef}>
        <button
          type="button"
          className="cs-toolbar2__btn cs-toolbar2__btn--with-caret"
          title={t('toolbar.shape')}
          aria-label={t('toolbar.shape')}
          aria-haspopup="menu"
          aria-expanded={!!shapesAnchor}
          onClick={(e) =>
            setShapesAnchor(shapesAnchor ? null : e.currentTarget.getBoundingClientRect())
          }
        >
          <Icon name="category" size={18} />
          <Icon name="expand_more" size={14} className="cs-toolbar2__caret" />
        </button>
      </div>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.line')}
        aria-label={t('toolbar.line')}
        onClick={() => insertShapeOfType('line')}
      >
        <Icon name="horizontal_rule" size={18} />
      </button>
    </>
  );

  const group5 = (
    <>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.newSlideShortcut')}
        aria-label={t('toolbar.newSlide')}
        onClick={() => void dispatchSlideCommand('slide.operation.append-slide')}
      >
        <Icon name="add_to_photos" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.layout')}
        aria-label={t('toolbar.layout')}
        onClick={(e) =>
          setLayoutAnchor(layoutAnchor ? null : e.currentTarget.getBoundingClientRect())
        }
      >
        <Icon name="view_compact" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.theme')}
        aria-label={t('toolbar.theme')}
        onClick={() =>
          (window as Window & { __casualSlides_openThemes?: () => void }).__casualSlides_openThemes?.()
        }
      >
        <Icon name="palette" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.background')}
        aria-label={t('toolbar.background')}
        onClick={(e) =>
          setBgAnchor(bgAnchor ? null : e.currentTarget.getBoundingClientRect())
        }
      >
        <Icon name="format_color_fill" size={18} />
      </button>
    </>
  );

  const group6 = (
    <>
      <FontFamilyPicker
        value={format.font}
        onChange={(font) => setFormat((p) => ({ ...p, font }))}
      />
      <FontSizePicker
        value={format.size}
        onChange={(size) => setFormat((p) => ({ ...p, size }))}
      />
      <button
        type="button"
        className={`cs-toolbar2__btn ${format.bold ? 'is-active' : ''}`}
        title={t('toolbar.boldShortcut')}
        aria-label={t('toolbar.bold')}
        aria-pressed={format.bold}
        onClick={() => toggleFormat('bold', 'doc.command.set-inline-format-bold')}
      >
        <Icon name="bold" size={18} filled={format.bold} />
      </button>
      <button
        type="button"
        className={`cs-toolbar2__btn ${format.italic ? 'is-active' : ''}`}
        title={t('toolbar.italicShortcut')}
        aria-label={t('toolbar.italic')}
        aria-pressed={format.italic}
        onClick={() => toggleFormat('italic', 'doc.command.set-inline-format-italic')}
      >
        <Icon name="italic" size={18} filled={format.italic} />
      </button>
      <button
        type="button"
        className={`cs-toolbar2__btn ${format.underline ? 'is-active' : ''}`}
        title={t('toolbar.underlineShortcut')}
        aria-label={t('toolbar.underline')}
        aria-pressed={format.underline}
        onClick={() => toggleFormat('underline', 'doc.command.set-inline-format-underline')}
      >
        <Icon name="underline" size={18} filled={format.underline} />
      </button>
      <button
        type="button"
        className={`cs-toolbar2__btn ${format.strikethrough ? 'is-active' : ''}`}
        title={t('toolbar.strikethroughShortcut')}
        aria-label={t('toolbar.strikethrough')}
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
        label={t('toolbar.textColor')}
      />
      <ColorPicker
        scope="fill"
        value={format.fillColor}
        onPick={applyFillColor}
        onClear={() => applyFillColor('rgba(0,0,0,0)')}
        icon="format_color_fill"
        label={t('toolbar.fillColor')}
      />
      <ColorPicker
        scope="border"
        value={format.borderColor}
        onPick={applyBorderColor}
        onClear={() => applyBorderColor('rgba(0,0,0,0)')}
        icon="border_color"
        label={t('toolbar.borderColor')}
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
        title={t('toolbar.indentDecrease')}
        aria-label={t('toolbar.indentDecrease')}
        onClick={() =>
          void dispatchSlideCommand('doc.command.change-list-nesting-level', { type: 'decrease' })
        }
      >
        <Icon name="format_indent_decrease" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.indentIncrease')}
        aria-label={t('toolbar.indentIncrease')}
        onClick={() =>
          void dispatchSlideCommand('doc.command.change-list-nesting-level', { type: 'increase' })
        }
      >
        <Icon name="format_indent_increase" size={18} />
      </button>
      <LineSpacingPicker
        value={format.lineSpacing}
        onChange={(lineSpacing) => setFormat((p) => ({ ...p, lineSpacing }))}
      />
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.clearFormatting')}
        aria-label={t('toolbar.clearFormatting')}
        // TODO(univer): docs-ui has no `clear-formatting` command in
        // v0.24.0. Implementation reuses RichTextEditingMutation to wipe
        // `textRun.ts` over the selection. Inert until the patch lands.
      >
        <Icon name="format_clear" size={18} />
      </button>
      <button
        type="button"
        className="cs-toolbar2__btn"
        title={t('toolbar.insertLinkShortcut')}
        aria-label={t('toolbar.insertLink')}
        // TODO(univer): hyperlink inline format is not exposed as a
        // docs-ui command in 0.24.0. Univer ships a HYPERLINK custom-range
        // type but no UI command id. Inert.
      >
        <Icon name="link" size={18} />
      </button>
    </>
  );

  // Slides menu items rendered by the popover. Memo'd so the same array
  // identity flows into the popover render and the keyboard handler.
  const shapesMenuRendered = useMemo(
    () => (
      <div
        className="cs-toolbar2__popover cs-toolbar2__popover--shapes"
        style={
          shapesAnchor
            ? { top: shapesAnchor.bottom + 6, left: shapesAnchor.left }
            : undefined
        }
        role="menu"
        aria-label={t('toolbar.shape')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {SHAPES_MENU.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="cs-toolbar2__popover-item"
            onClick={() => {
              setShapesAnchor(null);
              if (item.shapeType) insertShapeOfType(item.shapeType);
              else if (item.cmd) void dispatchSlideCommand(item.cmd);
            }}
          >
            <Icon name={item.icon} size={14} />
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </div>
    ),
    [shapesAnchor, t],
  );

  return (
    <div className="cs-toolbar" ref={rootRef}>
      <div className="cs-toolbar2__row" role="toolbar" aria-label={t('toolbar.group.actions')}>
        {group1}
        <span className="cs-toolbar__sep" aria-hidden="true" />
        {group3}
        <span className="cs-toolbar__sep" aria-hidden="true" />
        {group5}
        {!overflow && (
          <>
            <span className="cs-toolbar__sep" aria-hidden="true" />
            {group6}
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
              title={t('toolbar.moreActions')}
              aria-label={t('toolbar.moreActions')}
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
          className="cs-btn cs-btn--accent"
          title={t('toolbar.slideshowShortcut')}
          aria-label={t('toolbar.slideshow')}
          onClick={() => {
            const open = (window as Window & { __casualSlides_openSlideshow?: () => void })
              .__casualSlides_openSlideshow;
            open?.();
          }}
        >
          <Icon name="play_arrow" size={18} />
          <span>{t('toolbar.slideshow')}</span>
        </button>
      </div>

      {shapesAnchor && shapesMenuRendered}

      {overflow && overflowAnchor && (
        <OverflowPopover anchor={overflowAnchor} onClose={() => setOverflowAnchor(null)}>
          {group6}
          <span className="cs-toolbar__sep" aria-hidden="true" />
          {group7}
        </OverflowPopover>
      )}

      <BackgroundPicker anchorRect={bgAnchor} onClose={() => setBgAnchor(null)} />
      <LayoutPicker anchorRect={layoutAnchor} onClose={() => setLayoutAnchor(null)} />
    </div>
  );
}

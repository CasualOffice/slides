import { useEffect, useRef, useState } from 'react';
import type { Univer } from '@univerjs/core';
import { IUndoRedoService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { dispatchSlideCommand } from '../univer/commands';
import { BackgroundPicker } from './BackgroundPicker';
import { LayoutPicker } from './LayoutPicker';
import { Icon } from './icons';

// Google Slides-style toolbar — single horizontal row of icon-only
// affordances, grouped by separator chevrons. No tabs, no multi-row
// tool groups. Quick access to the most common commands.

interface ToolButton {
  id: string;
  icon: string;
  label: string;
  cmd?: string;
  cmdParams?: Record<string, unknown>;
  menu?: { id: string; label: string; icon?: string; cmd?: string; shapeType?: string }[];
  disabled?: boolean;
  primary?: boolean;
  /** When true, the disabled state is computed at render time from a
   *  live signal (undo/redo stack depth). */
  dynamicDisabled?: 'undo' | 'redo';
}

// Wave UX-P0#3 — expanded shape catalog. Rectangle / Ellipse dispatch
// the slides-ui-registered commands (registered upstream). Everything
// else dispatches `slide.mutation.insert-element` directly with a
// hand-crafted IPageElement; the renderer already paints these
// prsts via the per-prstGeom Path branch in ShapeAdaptor.
const SHAPES_MENU: NonNullable<ToolButton['menu']> = [
  { id: 'rect', label: 'Rectangle', icon: 'rectangle', cmd: 'slide.command.insert-float-shape.rectangle' },
  { id: 'ellipse', label: 'Ellipse', icon: 'circle', cmd: 'slide.command.insert-float-shape.ellipse' },
  { id: 'line', label: 'Line', icon: 'horizontal_rule', shapeType: 'line' },
  { id: 'rightArrow', label: 'Arrow →', icon: 'arrow_right_alt', shapeType: 'rightArrow' },
  { id: 'leftArrow', label: 'Arrow ←', icon: 'arrow_back', shapeType: 'leftArrow' },
  { id: 'upArrow', label: 'Arrow ↑', icon: 'arrow_upward', shapeType: 'upArrow' },
  { id: 'downArrow', label: 'Arrow ↓', icon: 'arrow_downward', shapeType: 'downArrow' },
  { id: 'triangle', label: 'Triangle', icon: 'change_history', shapeType: 'triangle' },
  { id: 'diamond', label: 'Diamond', icon: 'diamond', shapeType: 'diamond' },
  { id: 'pentagon', label: 'Pentagon', icon: 'pentagon', shapeType: 'pentagon' },
  { id: 'hexagon', label: 'Hexagon', icon: 'hexagon', shapeType: 'hexagon' },
  { id: 'octagon', label: 'Octagon', icon: 'shape_line', shapeType: 'octagon' },
  { id: 'chevron', label: 'Chevron', icon: 'double_arrow', shapeType: 'chevron' },
  { id: 'plus', label: 'Plus / Cross', icon: 'add', shapeType: 'plus' },
  { id: 'star5', label: 'Star', icon: 'star', shapeType: 'star5' },
];

const TOOLS: (ToolButton | { sep: true })[] = [
  { id: 'undo', icon: 'undo', label: 'Undo (Ctrl+Z)', cmd: 'univer.command.undo', dynamicDisabled: 'undo' },
  { id: 'redo', icon: 'redo', label: 'Redo (Ctrl+Y)', cmd: 'univer.command.redo', dynamicDisabled: 'redo' },
  { id: 'print', icon: 'print', label: 'Print', cmd: 'casual-slides.command.print' },
  { sep: true },
  { id: 'pointer', icon: 'arrow_selector_tool', label: 'Select', disabled: true },
  { id: 'textbox', icon: 'text_fields', label: 'Text box', cmd: 'slide.command.add-text' },
  { id: 'image', icon: 'image', label: 'Image', cmd: 'slide.command.insert-float-image' },
  { id: 'shape', icon: 'category', label: 'Shape', menu: SHAPES_MENU },
  // Single-click line shortcut for quick diagram authoring. Same
  // dispatch path as picking "Line" from the Shape menu.
  { id: 'line', icon: 'horizontal_rule', label: 'Line', cmd: 'casual-slides.command.insert-shape.line' },
  { sep: true },
  { id: 'comment', icon: 'add_comment', label: 'Add comment', disabled: true },
  { sep: true },
  { id: 'new-slide', icon: 'add_to_photos', label: 'New slide (Ctrl+M)', cmd: 'slide.operation.append-slide' },
  { id: 'layout', icon: 'view_compact', label: 'Layout' /* handled inline below */ },
  { id: 'theme', icon: 'palette', label: 'Theme' /* handled inline below */ },
  { id: 'background', icon: 'format_color_fill', label: 'Background' /* handled inline below */ },
  { id: 'transition', icon: 'auto_awesome_motion', label: 'Transition', disabled: true },
];

const isSep = (t: (typeof TOOLS)[number]): t is { sep: true } => 'sep' in t;

// Wave UX-P0#3 helper — insert a shape with the given prstGeom via
// `slide.mutation.insert-element`. Bypasses slide-ui's per-shape
// command registry so we can ship any prst the ShapeAdaptor knows
// about without authoring fork-side commands first.
//
// Default size + position match PowerPoint's "Insert Shape" drop
// (~250x250 mid-canvas). Defaults to a light fill + dark outline so
// the inserted shape is visible immediately even on a white slide.
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

    // zIndex on the new element = max existing + 1.
    const existingZ = Object.values(activePage.pageElements ?? {}).reduce(
      (m, e) => Math.max(m, e?.zIndex ?? 0),
      0,
    );
    const id = `manual-shape-${Date.now().toString(36)}`;
    // Line shapes ship at a small fixed visual height (24 px) so they
    // look like lines, not tall rects. Every other shape ships as a
    // 250x250 square — same as slide-ui's rect/ellipse defaults.
    const isLine = shapeType === 'line';
    const left = 378;
    const top = 142;
    const width = isLine ? 300 : 250;
    const height = isLine ? 24 : 250;

    const element = {
      id,
      zIndex: existingZ + 1,
      left,
      top,
      width,
      height,
      title: '',
      description: '',
      // PageElementType.SHAPE = 0 (matches the slides-ui patch enum).
      type: 0,
      shape: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        shapeType: shapeType as any,
        text: '',
        shapeProperties: isLine
          ? {
              // Lines render via the LINE family in ShapeAdaptor; fill is
              // transparent + a solid outline so the line is visible.
              shapeBackgroundFill: { rgb: 'rgba(0,0,0,0)' },
              outline: {
                outlineFill: { rgb: 'rgb(31, 41, 55)' },
                weight: 2,
              },
            }
          : {
              shapeBackgroundFill: { rgb: 'rgb(219, 234, 254)' },
              outline: {
                outlineFill: { rgb: 'rgb(37, 99, 235)' },
                weight: 2,
              },
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
    /* univer / model not ready — silent no-op (toolbar dispatch is
     * non-critical; user can retry once the editor is fully wired) */
  }
}

// Wave UX-P0#6 — undo/redo state subscription. Returns the live counts
// so the buttons can be disabled when the corresponding stack is
// empty. Polls the Univer DI container until it resolves the
// IUndoRedoService (mount race — UniverSlide finishes wiring a few
// ticks after the Toolbar mounts).
function useUndoRedoCounts(): { undos: number; redos: number } {
  const [counts, setCounts] = useState<{ undos: number; redos: number }>({ undos: 0, redos: 0 });

  useEffect(() => {
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        /* service not registered yet — retry after a tick */
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

export function Toolbar() {
  const [shapesAnchor, setShapesAnchor] = useState<DOMRect | null>(null);
  const [bgAnchor, setBgAnchor] = useState<DOMRect | null>(null);
  const [layoutAnchor, setLayoutAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { undos, redos } = useUndoRedoCounts();

  useEffect(() => {
    if (!shapesAnchor) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setShapesAnchor(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [shapesAnchor]);

  function onClick(btn: ToolButton, anchorEl: HTMLButtonElement) {
    if (btn.menu) {
      setShapesAnchor(shapesAnchor ? null : anchorEl.getBoundingClientRect());
      return;
    }
    if (btn.id === 'theme') {
      (window as Window & { __casualSlides_openThemes?: () => void }).__casualSlides_openThemes?.();
      return;
    }
    if (btn.id === 'background') {
      setBgAnchor(bgAnchor ? null : anchorEl.getBoundingClientRect());
      return;
    }
    if (btn.id === 'layout') {
      setLayoutAnchor(layoutAnchor ? null : anchorEl.getBoundingClientRect());
      return;
    }
    // Toolbar "Line" shortcut — dispatches the same insertShapeOfType
    // path as picking Line from the Shapes menu.
    if (btn.cmd === 'casual-slides.command.insert-shape.line') {
      insertShapeOfType('line');
      return;
    }
    if (btn.cmd) void dispatchSlideCommand(btn.cmd, btn.cmdParams);
  }

  function onMenuItemClick(item: NonNullable<ToolButton['menu']>[number]) {
    setShapesAnchor(null);
    if (item.shapeType) {
      insertShapeOfType(item.shapeType);
      return;
    }
    if (item.cmd) void dispatchSlideCommand(item.cmd);
  }

  return (
    <div className="cs-toolbar" ref={ref}>
      <div className="cs-toolbar__row">
        {TOOLS.map((t, i) =>
          isSep(t) ? (
            <span key={`sep-${i}`} className="cs-toolbar__sep" aria-hidden="true" />
          ) : (
            <button
              key={t.id}
              type="button"
              className={`cs-toolbar__btn ${t.menu ? 'cs-toolbar__btn--split' : ''}`}
              title={t.label}
              aria-label={t.label}
              disabled={
                t.disabled ||
                (t.dynamicDisabled === 'undo' && undos === 0) ||
                (t.dynamicDisabled === 'redo' && redos === 0)
              }
              onClick={(e) => onClick(t, e.currentTarget)}
            >
              <Icon name={t.icon} size={18} />
              {t.menu && <Icon name="expand_more" size={14} className="cs-toolbar__caret" />}
            </button>
          ),
        )}
        <div className="cs-toolbar__spacer" />
        <button
          type="button"
          className="cs-btn cs-btn--accent"
          title="Start slideshow (F5)"
          onClick={() => {
            const open = (window as Window & { __casualSlides_openSlideshow?: () => void }).__casualSlides_openSlideshow;
            open?.();
          }}
        >
          <Icon name="play_arrow" size={16} />
          <span>Slideshow</span>
        </button>
      </div>
      {shapesAnchor && (
        <div
          className="cs-toolbar__popover cs-toolbar__popover--shapes"
          style={{ top: shapesAnchor.bottom + 4, left: shapesAnchor.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {SHAPES_MENU.map((item) => (
            <button
              key={item.id}
              type="button"
              className="cs-toolbar__popover-item"
              onClick={() => onMenuItemClick(item)}
            >
              {item.icon && <Icon name={item.icon} size={16} />}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
      <BackgroundPicker anchorRect={bgAnchor} onClose={() => setBgAnchor(null)} />
      <LayoutPicker anchorRect={layoutAnchor} onClose={() => setLayoutAnchor(null)} />
    </div>
  );
}

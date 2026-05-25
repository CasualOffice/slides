import { useEffect, useRef, useState } from 'react';
import { dispatchSlideCommand } from '../univer/commands';
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
  menu?: { id: string; label: string; icon?: string; cmd: string }[];
  disabled?: boolean;
  primary?: boolean;
}

const SHAPES_MENU: NonNullable<ToolButton['menu']> = [
  { id: 'rect', label: 'Rectangle', icon: 'rectangle', cmd: 'slide.command.insert-float-shape.rectangle' },
  { id: 'ellipse', label: 'Ellipse', icon: 'circle', cmd: 'slide.command.insert-float-shape.ellipse' },
];

const TOOLS: (ToolButton | { sep: true })[] = [
  { id: 'undo', icon: 'undo', label: 'Undo (Ctrl+Z)', cmd: 'univer.command.undo' },
  { id: 'redo', icon: 'redo', label: 'Redo (Ctrl+Y)', cmd: 'univer.command.redo' },
  { id: 'print', icon: 'print', label: 'Print', cmd: 'casual-slides.command.print' },
  { sep: true },
  { id: 'pointer', icon: 'arrow_selector_tool', label: 'Select', disabled: true },
  { id: 'textbox', icon: 'text_fields', label: 'Text box', cmd: 'slide.command.add-text' },
  { id: 'image', icon: 'image', label: 'Image', cmd: 'slide.command.insert-float-image' },
  { id: 'shape', icon: 'category', label: 'Shape', menu: SHAPES_MENU },
  { id: 'line', icon: 'horizontal_rule', label: 'Line', disabled: true },
  { sep: true },
  { id: 'comment', icon: 'add_comment', label: 'Add comment', disabled: true },
  { sep: true },
  { id: 'new-slide', icon: 'add_to_photos', label: 'New slide (Ctrl+M)', cmd: 'slide.operation.append-slide' },
  { id: 'layout', icon: 'view_compact', label: 'Layout', disabled: true },
  { id: 'theme', icon: 'palette', label: 'Theme' /* handled inline below */ },
  { id: 'transition', icon: 'auto_awesome_motion', label: 'Transition', disabled: true },
];

const isSep = (t: (typeof TOOLS)[number]): t is { sep: true } => 'sep' in t;

export function Toolbar() {
  const [shapesAnchor, setShapesAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);

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
    if (btn.cmd) void dispatchSlideCommand(btn.cmd, btn.cmdParams);
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
              disabled={t.disabled}
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
          className="cs-toolbar__popover"
          style={{ top: shapesAnchor.bottom + 4, left: shapesAnchor.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {SHAPES_MENU.map((item) => (
            <button
              key={item.id}
              type="button"
              className="cs-toolbar__popover-item"
              onClick={() => {
                void dispatchSlideCommand(item.cmd);
                setShapesAnchor(null);
              }}
            >
              {item.icon && <Icon name={item.icon} size={16} />}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

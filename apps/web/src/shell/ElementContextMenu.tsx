import { useCallback, useEffect, useRef, useState } from 'react';
import { dispatchSlideCommand, hasElementClipboard } from '../univer/commands';
import { getSelectedElement } from './selection';
import { Icon } from './icons';
import { useTranslation } from '../i18n';

// Right-click context menu on a selected slide element.
// Standard PowerPoint / Google Slides affordance — currently the only
// way to reach z-order / center / duplicate / delete besides hunting
// in the toolbar.
//
// We don't bind directly to the canvas (Univer owns it); instead we
// listen for `contextmenu` globally and show the menu only when:
//   1. the click landed inside .cs-workspace (not the slide rail or
//      toolbar — those have their own menus / pickers), AND
//   2. an element is currently selected on the canvas.
// The second condition keeps the menu hidden when the user is just
// right-clicking empty canvas to see "Paste" — that's a polish item
// for v0.2 (would need to remember an in-app clipboard slot the user
// could view from an empty-canvas right-click).

interface MenuState {
  x: number;
  y: number;
  // When true, no element was under the right-click — show only paste.
  // Used to support the standard "right-click empty canvas → Paste" UX.
  emptyCanvas: boolean;
}

function inWorkspace(el: HTMLElement | null): boolean {
  let cur: HTMLElement | null = el;
  for (let i = 0; cur && i < 12; i += 1) {
    if (cur.classList?.contains('cs-workspace')) return true;
    cur = cur.parentElement;
  }
  return false;
}

function clampToViewport(x: number, y: number, w: number, h: number) {
  const pad = 8;
  const maxX = window.innerWidth - w - pad;
  const maxY = window.innerHeight - h - pad;
  return { x: Math.max(pad, Math.min(x, maxX)), y: Math.max(pad, Math.min(y, maxY)) };
}

export function ElementContextMenu() {
  const { t } = useTranslation('dialogs');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!inWorkspace(target)) return;
      const hasSel = !!getSelectedElement();
      // Show the menu either way — with full options when an element is
      // selected, or with just Paste when right-clicking empty canvas
      // and the clipboard is populated. Skip entirely otherwise so the
      // browser-default menu doesn't get suppressed for no UI gain.
      if (!hasSel && !hasElementClipboard()) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, emptyCanvas: !hasSel });
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!menu) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // Clamp into viewport after mount.
  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const { x, y } = clampToViewport(menu.x, menu.y, rect.width, rect.height);
    if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu?.x, menu?.y]);

  const fire = useCallback(async (cmd: string, params?: Record<string, unknown>) => {
    setMenu(null);
    await dispatchSlideCommand(cmd, params);
  }, []);

  if (!menu) return null;

  // Empty-canvas right-click: just offer Paste. Standard PowerPoint UX
  // when there's clipboard content and the user wants to drop it on
  // an empty slide area.
  if (menu.emptyCanvas) {
    return (
      <ul
        ref={menuRef}
        className="cs-slide-context"
        data-testid="element-context-menu"
        style={{ top: menu.y, left: menu.x }}
        role="menu"
      >
        <li>
          <button
            type="button"
            className="cs-slide-context__item"
            onClick={() => void fire('casual-slides.command.paste-element')}
          >
            <Icon name="content_paste" size={14} />
            <span>{t('elementContext.paste')}</span>
            <span className="cs-slide-context__shortcut">{t('elementContext.shortcut.paste')}</span>
          </button>
        </li>
      </ul>
    );
  }

  return (
    <ul
      ref={menuRef}
      className="cs-slide-context"
      data-testid="element-context-menu"
      style={{ top: menu.y, left: menu.x }}
      role="menu"
    >
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={async () => {
            setMenu(null);
            await dispatchSlideCommand('casual-slides.command.copy-element');
            await dispatchSlideCommand('casual-slides.command.delete-element');
          }}
        >
          <Icon name="content_cut" size={14} />
          <span>{t('elementContext.cut')}</span>
          <span className="cs-slide-context__shortcut">{t('elementContext.shortcut.cut')}</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('casual-slides.command.copy-element')}
        >
          <Icon name="content_copy" size={14} />
          <span>{t('elementContext.copy')}</span>
          <span className="cs-slide-context__shortcut">{t('elementContext.shortcut.copy')}</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('casual-slides.command.paste-element')}
        >
          <Icon name="content_paste" size={14} />
          <span>{t('elementContext.paste')}</span>
          <span className="cs-slide-context__shortcut">{t('elementContext.shortcut.paste')}</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('casual-slides.command.duplicate-element')}
        >
          <Icon name="library_add" size={14} />
          <span>{t('elementContext.duplicate')}</span>
          <span className="cs-slide-context__shortcut">{t('elementContext.shortcut.duplicate')}</span>
        </button>
      </li>
      <li className="cs-slide-context__sep" role="separator" />
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('casual-slides.command.z-order', { direction: 'forward' })}
        >
          <Icon name="flip_to_front" size={14} />
          <span>{t('elementContext.bringForward')}</span>
          <span className="cs-slide-context__shortcut">{t('elementContext.shortcut.bringForward')}</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('casual-slides.command.z-order', { direction: 'backward' })}
        >
          <Icon name="flip_to_back" size={14} />
          <span>{t('elementContext.sendBackward')}</span>
          <span className="cs-slide-context__shortcut">{t('elementContext.shortcut.sendBackward')}</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('casual-slides.command.z-order', { direction: 'front' })}
        >
          <Icon name="vertical_align_top" size={14} />
          <span>{t('elementContext.bringToFront')}</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('casual-slides.command.z-order', { direction: 'back' })}
        >
          <Icon name="vertical_align_bottom" size={14} />
          <span>{t('elementContext.sendToBack')}</span>
        </button>
      </li>
      <li className="cs-slide-context__sep" role="separator" />
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('casual-slides.command.center-on-slide', { axis: 'both' })}
        >
          <Icon name="center_focus_strong" size={14} />
          <span>{t('elementContext.center')}</span>
        </button>
      </li>
      <li className="cs-slide-context__sep" role="separator" />
      <li>
        <button
          type="button"
          className="cs-slide-context__item cs-slide-context__item--danger"
          onClick={() => void fire('casual-slides.command.delete-element')}
        >
          <Icon name="delete" size={14} />
          <span>{t('elementContext.delete')}</span>
          <span className="cs-slide-context__shortcut">{t('elementContext.shortcut.delete')}</span>
        </button>
      </li>
    </ul>
  );
}

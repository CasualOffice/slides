import { useCallback, useEffect, useRef, useState } from 'react';
import type { Univer } from '@univerjs/core';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { dispatchSlideCommand } from '../univer/commands';
import { Icon } from './icons';

// Right-click context menu on slide thumbnails in the left rail.
// Standard PowerPoint / Google Slides affordance.
//
// The slide-bar is rendered by Univer's slides-ui plugin (we don't own
// that DOM). Each thumbnail lives in a div that has a sibling <span>
// holding the 1-based slide index. We delegate the contextmenu listener
// on document, walk up from e.target to find the wrapper, and resolve
// the page id via the model's pageOrder.

interface MenuState {
  x: number;
  y: number;
  pageId: string;
  pageIndex: number;
}

function getModel(): SlideDataModel | null {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return null;
  try {
    return univer.__getInjector().get(IUniverInstanceService)
      .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE) ?? null;
  } catch {
    return null;
  }
}

// Walk up from `el` looking for an ancestor whose previous-sibling is a
// <span> whose text content is a plain integer (the slide number label).
// Returns the 1-based slide index, or null if no match.
function resolveSlideIndex(el: HTMLElement | null): number | null {
  let cur: HTMLElement | null = el;
  for (let i = 0; cur && i < 6; i += 1) {
    const prev = cur.previousElementSibling as HTMLElement | null;
    if (prev && prev.tagName === 'SPAN') {
      const text = (prev.textContent ?? '').trim();
      if (/^\d+$/.test(text)) return parseInt(text, 10);
    }
    cur = cur.parentElement;
  }
  return null;
}

// Confirm the right-click is over a left-sidebar thumbnail by checking
// for the data-u-comp="left-sidebar" ancestor. Without this, right-
// clicking anywhere on the page (e.g. the canvas) would pop the menu.
function inLeftSidebar(el: HTMLElement | null): boolean {
  let cur: HTMLElement | null = el;
  for (let i = 0; cur && i < 12; i += 1) {
    if (cur.getAttribute('data-u-comp') === 'left-sidebar') return true;
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

export function SlideContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  // Listen for contextmenu globally; pop our menu when it lands on a
  // thumbnail and suppress the default browser menu.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!inLeftSidebar(target)) return;
      const idx = resolveSlideIndex(target);
      if (!idx) return;
      const model = getModel();
      if (!model) return;
      const order = model.getPageOrder();
      if (!order) return;
      const pageId = order[idx - 1];
      if (!pageId) return;
      e.preventDefault();
      // Position will be clamped after the menu mounts (we know its size).
      setMenu({ x: e.clientX, y: e.clientY, pageId, pageIndex: idx });
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  // Close on outside click + Escape. Don't trap focus; let the user keep
  // typing if a text frame had focus.
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

  // After the menu mounts, clamp its position so it stays in the
  // viewport (right-click near the bottom shouldn't overflow off the
  // edge).
  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const { x, y } = clampToViewport(menu.x, menu.y, rect.width, rect.height);
    if (x !== menu.x || y !== menu.y) {
      setMenu({ ...menu, x, y });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu?.pageId, menu?.pageIndex]);

  const fire = useCallback(async (cmd: string, params?: Record<string, unknown>) => {
    setMenu(null);
    await dispatchSlideCommand(cmd, params);
  }, []);

  if (!menu) return null;

  return (
    <ul
      ref={menuRef}
      className="cs-slide-context"
      data-testid="slide-context-menu"
      style={{ top: menu.y, left: menu.x }}
      role="menu"
    >
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('slide.operation.append-slide')}
        >
          <Icon name="add_to_photos" size={14} />
          <span>New slide</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={() => void fire('slide.command.duplicate-slide', { pageId: menu.pageId })}
        >
          <Icon name="content_copy" size={14} />
          <span>Duplicate slide</span>
          <span className="cs-slide-context__shortcut">Ctrl+D</span>
        </button>
      </li>
      <li className="cs-slide-context__sep" role="separator" />
      <li>
        <button
          type="button"
          className="cs-slide-context__item cs-slide-context__item--danger"
          onClick={() => void fire('slide.command.delete-slide', { pageId: menu.pageId })}
        >
          <Icon name="delete" size={14} />
          <span>Delete slide</span>
          <span className="cs-slide-context__shortcut">⇧ Del</span>
        </button>
      </li>
    </ul>
  );
}

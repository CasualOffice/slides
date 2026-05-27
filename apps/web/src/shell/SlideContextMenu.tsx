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
  total: number;
  isHidden: boolean;
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

// Reorder pageOrder by swapping the entry at `idx` with `idx + delta`.
// Univer Slides v0.24.0 ships no built-in move-page mutation, so this
// hits the snapshot directly. Bumps the rev + re-pings setActivePage so
// the SlideSideBar React subscriber re-reads pageOrder.
//
// TODO(collab): not collab-safe — bypasses the command bus, so peers
// won't see the reorder. Replace with a `slide.mutation.move-page`
// command once we land it in the fork (tracked in UNIVER_SLIDES_GAPS.md).
function reorderPage(pageId: string, delta: -1 | 1): void {
  const model = getModel();
  if (!model) return;
  const snapshot = model.getSnapshot();
  const order = snapshot.body?.pageOrder;
  if (!order) return;
  const idx = order.indexOf(pageId);
  if (idx < 0) return;
  const target = idx + delta;
  if (target < 0 || target >= order.length) return;
  // In-place swap — keeps the array reference stable for any consumers
  // that captured it.
  [order[idx], order[target]] = [order[target], order[idx]];
  model.incrementRev();
  // Re-emit on activePage$ so the SlideSideBar subscriber re-renders
  // and reads the new pageOrder. Without this the rail keeps painting
  // the old sequence until the next active-page change.
  const active = model.getActivePage();
  if (active) model.setActivePage(active);
}

// Toggle isSkipped on the page via the existing `slide.mutation.update-page`.
// PowerPoint persists "Hide slide" as `<p:sld show="0">`; PptxGenJS export
// will need to honour `slideProperties.isSkipped` (follow-up).
async function toggleHidden(pageId: string, current: boolean): Promise<void> {
  await dispatchSlideCommand('slide.mutation.update-page', {
    pageId,
    patch: { slideProperties: { isSkipped: !current } },
  });
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
      const page = model.getPage(pageId);
      const isHidden = !!page?.slideProperties?.isSkipped;
      e.preventDefault();
      // Position will be clamped after the menu mounts (we know its size).
      setMenu({
        x: e.clientX,
        y: e.clientY,
        pageId,
        pageIndex: idx,
        total: order.length,
        isHidden,
      });
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

  const runReorder = useCallback((delta: -1 | 1) => {
    if (!menu) return;
    setMenu(null);
    reorderPage(menu.pageId, delta);
  }, [menu]);

  const runToggleHidden = useCallback(() => {
    if (!menu) return;
    setMenu(null);
    void toggleHidden(menu.pageId, menu.isHidden);
  }, [menu]);

  if (!menu) return null;

  const isFirst = menu.pageIndex <= 1;
  const isLast = menu.pageIndex >= menu.total;

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
          className="cs-slide-context__item"
          disabled={isFirst}
          onClick={() => runReorder(-1)}
          data-testid="slide-context-move-up"
        >
          <Icon name="arrow_upward" size={14} />
          <span>Move up</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          disabled={isLast}
          onClick={() => runReorder(1)}
          data-testid="slide-context-move-down"
        >
          <Icon name="arrow_downward" size={14} />
          <span>Move down</span>
        </button>
      </li>
      <li className="cs-slide-context__sep" role="separator" />
      {/* TODO(layout/background): "Change layout" + "Change background"
       *  are deferred. Both pickers (LayoutPicker, BackgroundPicker) are
       *  mounted inside Toolbar.tsx and anchored to a DOMRect held in
       *  Toolbar local state. To open them from this context menu we
       *  need Toolbar to expose `window.__casualSlides_openLayout(rect)`
       *  + `__casualSlides_openBackground(rect)` (mirroring the existing
       *  `__casualSlides_openThemes` pattern). That wiring lives in
       *  Toolbar and is outside this agent's scope. */}
      <li>
        <button
          type="button"
          className="cs-slide-context__item"
          onClick={runToggleHidden}
          data-testid="slide-context-hide"
        >
          <Icon name={menu.isHidden ? 'visibility' : 'visibility_off'} size={14} />
          <span>{menu.isHidden ? 'Unhide slide' : 'Hide slide'}</span>
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
          <span className="cs-slide-context__shortcut">Shift+Del</span>
        </button>
      </li>
    </ul>
  );
}

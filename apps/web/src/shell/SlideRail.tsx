import { useCallback, useEffect, useRef, useState } from 'react';
import type { Univer } from '@univerjs/core';
import { ICommandService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { ISlidePage, SlideDataModel } from '@univerjs/slides';
import { PageType } from '@univerjs/slides';
import { dispatchSlideCommand } from '../univer/commands';
import { useTranslation } from '../i18n';
import { Icon } from './icons';
import { SlideTile } from './SlideTile';

// Left slide rail — Google Slides-grade thumbnail strip that replaces
// Univer's built-in numbered sidebar (`[data-u-comp="left-sidebar"]`,
// hidden via CSS in styles.css). Self-mounts through <SlideRailProvider />
// in main.tsx, next to the other providers, so App.tsx stays untouched.
//
// Thumbnails reuse the read-only <SlideTile> renderer (same primitive the
// slideshow + presenter view use) scaled down via CSS transform.

const RAIL_WIDTH = 220;
const THUMB_WIDTH = 168; // rail width minus number column + padding

// Inline styles for the hover-action overlay (audit P3). Inlined so the
// feature ships independently of when the parallel UI/UX lane adds the
// proper styles.css block. Values match Google Slides' rail action icons.
const hoverActionsContainerStyle: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  display: 'inline-flex',
  gap: 4,
  zIndex: 2,
};

const hoverActionBtnStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(255, 255, 255, 0.95)',
  border: '1px solid rgba(0, 0, 0, 0.08)',
  borderRadius: 4,
  color: '#3c4043',
  cursor: 'pointer',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08)',
  padding: 0,
};

function getModel(): SlideDataModel | null {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return null;
  try {
    return (
      univer
        .__getInjector()
        .get(IUniverInstanceService)
        .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE) ?? null
    );
  } catch {
    return null;
  }
}

interface RailSlide {
  id: string;
  page: ISlidePage;
}

// Reorder pageOrder by moving `fromIdx` to `toIdx`. Same direct-snapshot
// approach SlideContextMenu's move-up/down uses (Univer v0.24.0 has no
// move-page mutation). TODO(collab): bypasses the command bus.
function movePage(fromIdx: number, toIdx: number): void {
  const model = getModel();
  if (!model) return;
  const snapshot = model.getSnapshot();
  const order = snapshot.body?.pageOrder;
  if (!order) return;
  if (fromIdx < 0 || fromIdx >= order.length) return;
  if (toIdx < 0 || toIdx >= order.length) return;
  if (fromIdx === toIdx) return;
  // The bounds checks above guarantee splice(fromIdx, 1) returns a
  // single-element array; destructuring is safe.
  const [moved] = order.splice(fromIdx, 1) as [string];
  order.splice(toIdx, 0, moved);
  model.incrementRev();
  const active = model.getActivePage();
  if (active) model.setActivePage(active);
}

export function SlideRail() {
  const { t } = useTranslation('chrome');
  const [slides, setSlides] = useState<RailSlide[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<{ idx: number; below: boolean } | null>(null);
  // Hover overlay for Duplicate / Delete inline actions on each tile.
  // Only one item is hovered at a time; cleared on mouseleave so the
  // overlay disappears immediately when the pointer exits.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  const pageSize = useRef<{ width: number; height: number }>({ width: 960, height: 540 });

  // Read the current slide list (SLIDE pages only) + active id from the model.
  const refresh = useCallback(() => {
    const model = getModel();
    if (!model) return;
    const snapshot = model.getSnapshot();
    const order = snapshot.body?.pageOrder ?? [];
    const pages = snapshot.body?.pages ?? {};
    pageSize.current = {
      width: snapshot.pageSize?.width ?? 960,
      height: snapshot.pageSize?.height ?? 540,
    };
    const list: RailSlide[] = [];
    for (const id of order) {
      const page = pages[id];
      if (!page) continue;
      if (page.pageType === PageType.SLIDE || page.pageType === undefined) {
        list.push({ id, page });
      }
    }
    setSlides(list);
    const active = model.getActivePage();
    if (active) setActiveId(active.id);
  }, []);

  // Wire subscriptions once Univer is ready. activePage$ covers selection,
  // but slide CONTENT edits don't emit there — so we also listen to the
  // command bus and re-read the snapshot on any slide.* mutation (same
  // heuristic App.tsx uses for its dirty flag).
  useEffect(() => {
    let disposed = false;
    let unsubActive: (() => void) | null = null;
    let cmdDisposer: { dispose?: () => void } | null = null;
    let wiredUnitId: string | null = null;

    const teardownSubs = () => {
      unsubActive?.();
      unsubActive = null;
      cmdDisposer?.dispose?.();
      cmdDisposer = null;
    };

    // Subscribe to a specific model + its command bus. Returns false if the
    // model/instance isn't ready yet so the watcher can retry.
    const wireTo = (): boolean => {
      const model = getModel();
      const w = window as unknown as { univer?: Univer };
      const univer = w.univer;
      if (!model || !univer) return false;
      refresh();
      try {
        const sub = model.activePage$.subscribe(() => {
          if (!disposed) refresh();
        });
        unsubActive = () => sub.unsubscribe();
        const cs = univer.__getInjector().get(ICommandService);
        const d = cs.onCommandExecuted((info) => {
          if (disposed) return;
          if (!info.id.startsWith('slide.')) return;
          refresh();
        });
        cmdDisposer = { dispose: () => d?.dispose?.() };
        wiredUnitId = model.getUnitId();
        return true;
      } catch {
        teardownSubs();
        return false;
      }
    };

    // Opening a .pptx swaps in a fresh Univer instance (UniverSlide is keyed
    // on snapshot.id), which disposes the model we subscribed to. activePage$
    // on the old model goes silent, so the rail would keep painting the old
    // deck. Poll the live unitId; when it changes (or first appears), tear
    // down the stale subscription and re-wire to the new model. 400 ms is
    // cheap and only does work on an actual swap.
    const watch = () => {
      if (disposed) return;
      const liveUnitId = getModel()?.getUnitId() ?? null;
      if (liveUnitId && liveUnitId !== wiredUnitId) {
        teardownSubs();
        wireTo();
      }
    };
    wireTo();
    const interval = window.setInterval(watch, 400);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      teardownSubs();
    };
  }, [refresh]);

  const activate = useCallback((id: string) => {
    void dispatchSlideCommand('slide.operation.activate-slide', { id });
    const model = getModel();
    // activate-slide may not move getActivePage in every Univer build;
    // set it explicitly so the rail highlight is immediate.
    if (model) {
      const page = model.getPage(id);
      if (page) model.setActivePage(page);
    }
    setActiveId(id);
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent, id: string, idx: number) => {
      if (e.metaKey || e.ctrlKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        anchorRef.current = id;
        return;
      }
      if (e.shiftKey && anchorRef.current) {
        const anchorIdx = slides.findIndex((s) => s.id === anchorRef.current);
        if (anchorIdx >= 0) {
          const [lo, hi] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx];
          setSelected(new Set(slides.slice(lo, hi + 1).map((s) => s.id)));
          activate(id);
          return;
        }
      }
      // Plain click — single select + activate.
      setSelected(new Set([id]));
      anchorRef.current = id;
      activate(id);
    },
    [slides, activate],
  );

  // Keyboard navigation — Up/Down move active slide; Cmd/Ctrl+A select all;
  // Esc clears selection; bare Delete removes selected slides. All guarded
  // against editable surfaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (inEditable) return;
      const activeIdx = slides.findIndex((s) => s.id === activeId);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        // Only claim Cmd/Ctrl+A if the rail has focus context — otherwise
        // let the canvas handle select-all-elements.
        if (document.activeElement?.closest('.cs-slide-rail')) {
          e.preventDefault();
          setSelected(new Set(slides.map((s) => s.id)));
        }
        return;
      }
      if (e.key === 'Escape' && selected.size > 0) {
        setSelected(new Set());
        return;
      }
      if (!document.activeElement?.closest('.cs-slide-rail')) return;
      if (e.key === 'ArrowDown' && activeIdx >= 0 && activeIdx < slides.length - 1) {
        e.preventDefault();
        // activeIdx < slides.length - 1 → activeIdx + 1 is in bounds.
        const next = slides[activeIdx + 1]!;
        setSelected(new Set([next.id]));
        activate(next.id);
      } else if (e.key === 'ArrowUp' && activeIdx > 0) {
        e.preventDefault();
        // activeIdx > 0 → activeIdx - 1 is in bounds.
        const prev = slides[activeIdx - 1]!;
        setSelected(new Set([prev.id]));
        activate(prev.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slides, activeId, selected, activate]);

  function onDragStart(e: React.DragEvent, idx: number) {
    setDragFrom(idx);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox needs data set for drag to fire.
    e.dataTransfer.setData('text/plain', String(idx));
  }
  function onDragOverThumb(e: React.DragEvent, idx: number) {
    if (dragFrom === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const below = e.clientY - rect.top > rect.height / 2;
    setDragOver({ idx, below });
  }
  function onDrop(e: React.DragEvent, idx: number) {
    e.preventDefault();
    if (dragFrom === null) {
      setDragOver(null);
      return;
    }
    let to = idx;
    if (dragOver?.below) to = idx + 1;
    // Account for removing the source first when moving downward.
    if (dragFrom < to) to -= 1;
    movePage(dragFrom, to);
    setDragFrom(null);
    setDragOver(null);
    refresh();
  }
  function onDragEnd() {
    setDragFrom(null);
    setDragOver(null);
  }

  const scale = THUMB_WIDTH / pageSize.current.width;
  const thumbHeight = pageSize.current.height * scale;

  return (
    // `data-u-comp="left-sidebar"` so the existing SlideContextMenu (which
    // detects that attribute + a numbered <span> sibling to resolve the
    // slide index) keeps working on our rail without changes.
    <aside
      className="cs-slide-rail"
      aria-label={t('slideRail.ariaLabel')}
      data-u-comp="left-sidebar"
    >
      <div className="cs-slide-rail__list">
        {slides.map((slide, idx) => {
          const isActive = slide.id === activeId;
          const isSelected = selected.has(slide.id);
          const showDropLine = dragOver?.idx === idx;
          return (
            <div
              key={slide.id}
              className={`cs-slide-rail__item ${showDropLine ? (dragOver?.below ? 'is-drop-below' : 'is-drop-above') : ''}`}
              draggable
              onDragStart={(e) => onDragStart(e, idx)}
              onDragOver={(e) => onDragOverThumb(e, idx)}
              onDrop={(e) => onDrop(e, idx)}
              onDragEnd={onDragEnd}
              onMouseEnter={() => setHoveredId(slide.id)}
              onMouseLeave={() => setHoveredId((cur) => (cur === slide.id ? null : cur))}
              style={{ position: 'relative' }}
            >
              <span className="cs-slide-rail__num">{idx + 1}</span>
              <button
                type="button"
                className={`cs-slide-rail__thumb ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''}`}
                aria-current={isActive}
                aria-selected={isSelected}
                aria-label={t('slideRail.slideLabel', { index: idx + 1 })}
                onClick={(e) => handleClick(e, slide.id, idx)}
              >
                <div
                  className="cs-slide-rail__thumb-frame"
                  style={{ width: THUMB_WIDTH, height: thumbHeight }}
                >
                  <div
                    className="cs-slide-rail__thumb-scale"
                    style={{
                      width: pageSize.current.width,
                      height: pageSize.current.height,
                      transform: `scale(${scale})`,
                      transformOrigin: 'top left',
                    }}
                  >
                    <SlideTile page={slide.page} pageSize={pageSize.current} />
                  </div>
                </div>
              </button>
              {/* Hover-only action overlay — Duplicate + Delete inline,
                  matching the Google Slides rail. Visibility tracked via
                  hoveredId React state (set on the parent item's mouse
                  events). e.stopPropagation on the button onClicks
                  prevents the parent thumb-button from activating the
                  slide. Audit P3. */}
              {hoveredId === slide.id && (
                <div className="cs-slide-rail__hover-actions" style={hoverActionsContainerStyle}>
                  <button
                    type="button"
                    className="cs-slide-rail__hover-btn"
                    title={t('slideRail.duplicate')}
                    aria-label={t('slideRail.duplicate')}
                    onClick={(e) => {
                      e.stopPropagation();
                      void dispatchSlideCommand('slide.command.duplicate-slide', { pageId: slide.id });
                    }}
                    style={hoverActionBtnStyle}
                  >
                    <Icon name="content_copy" size={14} />
                  </button>
                  <button
                    type="button"
                    className="cs-slide-rail__hover-btn cs-slide-rail__hover-btn--danger"
                    title={t('slideRail.delete')}
                    aria-label={t('slideRail.delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      void dispatchSlideCommand('slide.command.delete-slide', { pageId: slide.id });
                    }}
                    style={hoverActionBtnStyle}
                  >
                    <Icon name="delete" size={14} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="cs-slide-rail__add"
        onClick={() => void dispatchSlideCommand('slide.operation.append-slide')}
        title={t('slideRail.newSlide')}
      >
        <Icon name="add" size={16} />
        <span>{t('slideRail.newSlide')}</span>
      </button>
    </aside>
  );
}

// Self-mounting provider — toggles `body.cs-slide-rail-open` so the
// workspace shrinks (margin-left), and renders the rail. Waits until a
// Univer slide unit exists before showing anything.
export function SlideRailProvider() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let retry: number | null = null;
    const check = () => {
      if (disposed) return;
      if (getModel()) {
        setReady(true);
        return;
      }
      retry = window.setTimeout(check, 200);
    };
    check();
    return () => {
      disposed = true;
      if (retry != null) window.clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    if (ready) document.body.classList.add('cs-slide-rail-open');
    else document.body.classList.remove('cs-slide-rail-open');
    return () => document.body.classList.remove('cs-slide-rail-open');
  }, [ready]);

  if (!ready) return null;
  return <SlideRail />;
}

export { RAIL_WIDTH };

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ISlideData } from '@univerjs/slides';
import { PageType } from '@univerjs/slides';
import { useTranslation } from '../i18n';
import { Icon } from './icons';
import { PresenterView } from './PresenterView';
import { SlideTile } from './SlideTile';

// Full-screen presenter mode. Renders slides from the ISlideData snapshot
// as absolutely-positioned DOM nodes scaled to fill the viewport. Read-only
// — no Univer instance, no editor chrome, no scrollbars.
//
// Renderer fidelity is intentionally a subset of Univer's canvas — see
// SlideTile.tsx for the precise element coverage.
//
// Keybinds:
//   →, Space, PageDown       next slide
//   ←, Backspace, PageUp     previous slide
//   Home / End               first / last slide
//   Escape                   exit (also closes jump / clears blackscreen)
//   F                        toggle fullscreen
//   N                        toggle slide-number overlay
//   P                        toggle presenter view
//   B                        toggle black screen
//   W                        toggle white screen
//   0–9                      open "Go to slide" input
//   Enter (inside input)     jump; Esc cancels
//
// Touch:                     horizontal swipe ≥ 60 px in ≤ 600 ms steps
//                            the deck (left → next, right → prev).
//
// Triggered from the Toolbar Slideshow button and F5 (App.tsx keydown).

export interface SlideShowProps {
  snapshot: ISlideData;
  startIndex?: number;
  onExit: () => void;
}

// Auto-hide timeouts for mouse-driven UI and the counter overlay.
const MOUSE_IDLE_MS = 2000;
// Touch-swipe thresholds. 60 px lateral distance over no more than 600 ms;
// vertical motion must not dominate (|dy| < |dx|).
const SWIPE_MIN_DX = 60;
const SWIPE_MAX_MS = 600;

type BlackScreen = 'black' | 'white' | null;

export function SlideShow({ snapshot, startIndex = 0, onExit }: SlideShowProps) {
  const { t } = useTranslation('slideshow');

  const pageOrder = useMemo(() => snapshot.body?.pageOrder ?? [], [snapshot]);
  const pages = useMemo(() => snapshot.body?.pages ?? {}, [snapshot]);
  // Filter to only SLIDE pages (skip MASTER / LAYOUT / NOTES_MASTER which
  // can appear in the imported pageOrder).
  const visiblePageIds = useMemo(
    () =>
      pageOrder.filter(
        (id) =>
          pages[id]?.pageType === PageType.SLIDE ||
          pages[id]?.pageType === undefined,
      ),
    [pageOrder, pages],
  );
  const [idx, setIdx] = useState(() =>
    Math.min(Math.max(startIndex, 0), Math.max(0, visiblePageIds.length - 1)),
  );
  // Counter is OFF by default now; mouse movement reveals it (and the
  // cursor) for MOUSE_IDLE_MS.
  const [showNumber, setShowNumber] = useState(false);
  const [presenter, setPresenter] = useState(false);
  const [blackscreen, setBlackscreen] = useState<BlackScreen>(null);
  const [recentMouseMove, setRecentMouseMove] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState('');
  const jumpInputRef = useRef<HTMLInputElement | null>(null);

  // Presenter timer — counts up from when presenter view was entered.
  const [timerStart, setTimerStart] = useState<number>(() => Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);

  const next = useCallback(
    () => setIdx((i) => Math.min(i + 1, visiblePageIds.length - 1)),
    [visiblePageIds.length],
  );
  const prev = useCallback(() => setIdx((i) => Math.max(i - 1, 0)), []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  const togglePresenter = useCallback(() => {
    setPresenter((v) => {
      const nextV = !v;
      if (nextV) {
        // Reset the timer each time we ENTER presenter view; preserves
        // the count if we toggle out and back in within the same session.
        setTimerStart(Date.now());
        setElapsedMs(0);
      }
      return nextV;
    });
  }, []);

  const resetTimer = useCallback(() => {
    setTimerStart(Date.now());
    setElapsedMs(0);
  }, []);

  // Tick the elapsed timer while presenter view is open.
  useEffect(() => {
    if (!presenter) return;
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - timerStart);
    }, 1000);
    return () => window.clearInterval(id);
  }, [presenter, timerStart]);

  // Keyboard. Single handler covers all modes; jump-input input has its
  // own onKeyDown so Enter/Escape don't double-fire here.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // When the floating jump-to-slide input is focused, let it handle
      // its own keys — the input's onKeyDown manages Enter/Escape.
      if (jumpOpen && e.target instanceof HTMLInputElement) return;

      // Digit opens the jump input; consume the key so the digit becomes
      // the first character of the value.
      if (!jumpOpen && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setJumpValue(e.key);
        setJumpOpen(true);
        return;
      }

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          if (jumpOpen) {
            setJumpOpen(false);
            setJumpValue('');
            return;
          }
          if (blackscreen) {
            setBlackscreen(null);
            return;
          }
          onExit();
          break;
        case 'ArrowRight':
        case ' ':
        case 'PageDown':
          e.preventDefault();
          if (blackscreen) setBlackscreen(null);
          next();
          break;
        case 'ArrowLeft':
        case 'Backspace':
        case 'PageUp':
          e.preventDefault();
          if (blackscreen) setBlackscreen(null);
          prev();
          break;
        case 'Home':
          e.preventDefault();
          if (blackscreen) setBlackscreen(null);
          setIdx(0);
          break;
        case 'End':
          e.preventDefault();
          if (blackscreen) setBlackscreen(null);
          setIdx(Math.max(0, visiblePageIds.length - 1));
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          setShowNumber((v) => !v);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          togglePresenter();
          break;
        case 'b':
        case 'B':
          e.preventDefault();
          setBlackscreen((v) => (v === 'black' ? null : 'black'));
          break;
        case 'w':
        case 'W':
          e.preventDefault();
          setBlackscreen((v) => (v === 'white' ? null : 'white'));
          break;
        default:
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    next,
    prev,
    onExit,
    visiblePageIds.length,
    toggleFullscreen,
    togglePresenter,
    jumpOpen,
    blackscreen,
  ]);

  // Mouse-move auto-hide. Track a debounced "recent" flag; when it flips
  // false we hide both the counter and the cursor.
  useEffect(() => {
    let timeoutId: number | undefined;
    const onMove = () => {
      setRecentMouseMove(true);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        setRecentMouseMove(false);
      }, MOUSE_IDLE_MS);
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, []);

  // Touch swipe. Records the start coords + timestamp and compares on
  // touchend; horizontal motion must clear SWIPE_MIN_DX in ≤ SWIPE_MAX_MS
  // and outweigh any vertical motion. Listeners are passive so the
  // browser still does its native scroll/zoom handling everywhere else.
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let startT = 0;
    const onStart = (e: TouchEvent) => {
      const t0 = e.changedTouches[0];
      if (!t0) return;
      startX = t0.clientX;
      startY = t0.clientY;
      startT = Date.now();
    };
    const onEnd = (e: TouchEvent) => {
      const t0 = e.changedTouches[0];
      if (!t0) return;
      const dx = t0.clientX - startX;
      const dy = t0.clientY - startY;
      const dt = Date.now() - startT;
      if (dt > SWIPE_MAX_MS) return;
      if (Math.abs(dx) < SWIPE_MIN_DX) return;
      if (Math.abs(dy) > Math.abs(dx)) return;
      if (blackscreen) setBlackscreen(null);
      if (dx < 0) next();
      else prev();
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [next, prev, blackscreen]);

  // Focus the jump-input as soon as it opens.
  useEffect(() => {
    if (jumpOpen) jumpInputRef.current?.focus();
  }, [jumpOpen]);

  // Exit fullscreen on unmount if we entered it. We DO NOT request
  // fullscreen on mount — Safari rejects the call without a fresh user
  // gesture, and the surrounding code already covers the viewport.
  useEffect(() => {
    return () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  const commitJump = useCallback(() => {
    const n = parseInt(jumpValue, 10);
    if (!Number.isNaN(n)) {
      const clamped = Math.min(
        Math.max(n - 1, 0),
        Math.max(0, visiblePageIds.length - 1),
      );
      setIdx(clamped);
    }
    setJumpOpen(false);
    setJumpValue('');
  }, [jumpValue, visiblePageIds.length]);

  if (visiblePageIds.length === 0) {
    return (
      <div className="cs-slideshow" role="dialog" aria-label={t('ariaLabel')}>
        <div className="cs-slideshow__empty">
          <Icon name="info" size={36} />
          <p>{t('empty')}</p>
          <button
            type="button"
            className="cs-btn cs-btn--ghost"
            onClick={onExit}
          >
            {t('exit')}
          </button>
        </div>
      </div>
    );
  }

  const currentId = visiblePageIds[idx];
  const currentPage = currentId ? pages[currentId] : undefined;
  const nextId =
    idx + 1 < visiblePageIds.length ? visiblePageIds[idx + 1] : undefined;
  const nextPage = nextId ? pages[nextId] : undefined;
  const pageSize = {
    width: snapshot.pageSize?.width ?? 960,
    height: snapshot.pageSize?.height ?? 540,
  };
  if (!currentPage) {
    return (
      <div className="cs-slideshow" role="dialog" aria-label={t('ariaLabel')}>
        <div className="cs-slideshow__empty">
          <Icon name="error" size={36} />
          <p>{t('notFound')}</p>
          <button
            type="button"
            className="cs-btn cs-btn--ghost"
            onClick={onExit}
          >
            {t('exit')}
          </button>
        </div>
      </div>
    );
  }

  // When recentMouseMove is false, hide the cursor and the counter. The
  // toolbar still shows on hover via mouseenter; we only hide what would
  // otherwise distract during static presentation.
  const cursorHidden = !recentMouseMove;
  const counterVisible = showNumber || recentMouseMove;

  return (
    <div
      className={`cs-slideshow ${
        cursorHidden ? 'cs-slideshow--cursor-hidden' : ''
      } ${presenter ? 'cs-slideshow--presenter' : ''}`}
      role="dialog"
      aria-label={t('ariaLabel')}
    >
      {presenter ? (
        <PresenterView
          currentPage={currentPage}
          nextPage={nextPage ?? null}
          pageSize={pageSize}
          notes={currentPage.description ?? ''}
          elapsedMs={elapsedMs}
          onResetTimer={resetTimer}
          currentNumber={idx + 1}
          totalSlides={visiblePageIds.length}
        />
      ) : (
        <div
          className="cs-slideshow__stage"
          onClick={(e) => {
            // Don't advance if the click landed on the toolbar.
            if ((e.target as HTMLElement).closest('.cs-slideshow__toolbar'))
              return;
            if (blackscreen) {
              setBlackscreen(null);
              return;
            }
            next();
          }}
        >
          <SlideTile page={currentPage} pageSize={pageSize} />
        </div>
      )}

      {/* Black / white screen overlay — sits above the stage but below
          the toolbar so the user can still navigate. */}
      {blackscreen && !presenter && (
        <div
          className="cs-slideshow__blackscreen"
          style={{ background: blackscreen === 'black' ? '#000' : '#fff' }}
          aria-hidden="true"
        />
      )}

      {/* Jump-to-slide floating input — bottom-centre, above the toolbar. */}
      {jumpOpen && (
        <div className="cs-slideshow__jump" role="dialog" aria-label={t('jump.title')}>
          <label htmlFor="cs-slideshow-jump-input" className="cs-slideshow__jump-label">
            {t('jump.label')}
          </label>
          <input
            id="cs-slideshow-jump-input"
            ref={jumpInputRef}
            className="cs-slideshow__jump-input"
            type="number"
            min={1}
            max={visiblePageIds.length}
            value={jumpValue}
            inputMode="numeric"
            onChange={(e) => setJumpValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitJump();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setJumpOpen(false);
                setJumpValue('');
              }
            }}
            onBlur={() => {
              // Closing on blur keeps the popover from sticking after a
              // toolbar click; commit if numeric input is present.
              if (jumpValue) commitJump();
              else setJumpOpen(false);
            }}
          />
          <span className="cs-slideshow__jump-hint">
            {t('jump.hint', { total: visiblePageIds.length })}
          </span>
        </div>
      )}

      <div className="cs-slideshow__toolbar">
        <button
          type="button"
          className="cs-slideshow__btn"
          onClick={prev}
          disabled={idx === 0}
          title={t('tooltips.previous', { key: t('tooltips.previousKey') })}
          aria-label={t('tooltips.previous', { key: t('tooltips.previousKey') })}
        >
          <Icon name="chevron_left" size={20} />
        </button>
        <span
          className={`cs-slideshow__counter ${
            counterVisible ? '' : 'cs-slideshow__counter--hidden'
          }`}
          aria-live="polite"
        >
          {t('counter', { current: idx + 1, total: visiblePageIds.length })}
        </span>
        <button
          type="button"
          className="cs-slideshow__btn"
          onClick={next}
          disabled={idx === visiblePageIds.length - 1}
          title={t('tooltips.next', { key: t('tooltips.nextKey') })}
          aria-label={t('tooltips.next', { key: t('tooltips.nextKey') })}
        >
          <Icon name="chevron_right" size={20} />
        </button>
        <span className="cs-slideshow__divider" />
        <button
          type="button"
          className={`cs-slideshow__btn ${
            presenter ? 'cs-slideshow__btn--active' : ''
          }`}
          onClick={togglePresenter}
          title={t('tooltips.presenter')}
          aria-label={t('tooltips.presenter')}
          aria-pressed={presenter}
        >
          <Icon name="present_to_all" size={20} filled={presenter} />
        </button>
        <button
          type="button"
          className={`cs-slideshow__btn ${
            blackscreen === 'black' ? 'cs-slideshow__btn--active' : ''
          }`}
          onClick={() =>
            setBlackscreen((v) => (v === 'black' ? null : 'black'))
          }
          title={t('tooltips.blackscreen')}
          aria-label={t('tooltips.blackscreen')}
          aria-pressed={blackscreen === 'black'}
        >
          <Icon name="format_color_fill" size={20} />
        </button>
        <button
          type="button"
          className="cs-slideshow__btn"
          onClick={toggleFullscreen}
          title={t('tooltips.fullscreen')}
          aria-label={t('tooltips.fullscreen')}
        >
          <Icon name="fullscreen" size={20} />
        </button>
        <button
          type="button"
          className="cs-slideshow__btn"
          onClick={onExit}
          title={t('tooltips.exit')}
          aria-label={t('tooltips.exit')}
        >
          <Icon name="close" size={20} />
        </button>
      </div>
    </div>
  );
}

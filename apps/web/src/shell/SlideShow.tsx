import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IPageElement, ISlideData, ISlidePage } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';
import { Icon } from './icons';

// Full-screen presenter mode. Renders slides from the ISlideData snapshot
// as absolutely-positioned DOM nodes scaled to fill the viewport. Read-only
// — no Univer instance, no editor chrome, no scrollbars.
//
// Renderer fidelity is intentionally a subset of Univer's canvas:
//   ✓ slide background fill
//   ✓ text elements with size/color/bold/italic
//   ✓ basic shapes (rect/ellipse) with fill colour
//   ✗ images — defer; needs base64 / contentUrl handling
//   ✗ rich text runs — single-run only; multi-run formatting follows P1+
//
// Navigation:
//   →, Space, click   next slide
//   ←, Backspace      previous slide
//   Escape            exit
//   F                  toggle fullscreen
//   N                  toggle slide number overlay (visible by default)
//
// Triggered from the Toolbar Slideshow button and F5 (App.tsx keydown).

export interface SlideShowProps {
  snapshot: ISlideData;
  startIndex?: number;
  onExit: () => void;
}

// Univer's Nullable<T> includes `void`; widen the accept type.
function rgbToCss(rgb: string | null | undefined | void, fallback = '#ffffff'): string {
  if (!rgb) return fallback;
  return rgb.trim();
}

function renderTextElement(element: IPageElement) {
  const rt = element.richText;
  if (!rt?.text) return null;
  return (
    <div
      key={element.id}
      style={{
        position: 'absolute',
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.height,
        fontSize: rt.fs ? `${rt.fs}px` : '24px',
        color: rgbToCss(rt.cl?.rgb, '#111827'),
        fontWeight: rt.bl ? 700 : 400,
        fontStyle: rt.it ? 'italic' : 'normal',
        textDecoration: rt.ul ? 'underline' : 'none',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.2,
        overflow: 'hidden',
      }}
    >
      {rt.text}
    </div>
  );
}

function renderShapeElement(element: IPageElement) {
  const shape = element.shape;
  if (!shape) return null;
  const isEllipse = shape.shapeType === 'ellipse';
  return (
    <div
      key={element.id}
      style={{
        position: 'absolute',
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.height,
        background: rgbToCss(shape.shapeProperties?.shapeBackgroundFill?.rgb, '#e2e8f0'),
        borderRadius: isEllipse ? '50%' : (shape.shapeProperties?.radius ?? 0),
      }}
    />
  );
}

function renderImageElement(element: IPageElement) {
  const img = element.image;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = img?.imageProperties as any;
  const src: string | undefined = props?.contentUrl || props?.base64Cache;
  if (!src) return null;
  return (
    <img
      key={element.id}
      src={src}
      alt=""
      style={{
        position: 'absolute',
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.height,
        objectFit: 'contain',
      }}
    />
  );
}

function renderElement(element: IPageElement) {
  if (element.type === PageElementType.TEXT) return renderTextElement(element);
  if (element.type === PageElementType.SHAPE) return renderShapeElement(element);
  if (element.type === PageElementType.IMAGE) return renderImageElement(element);
  return null;
}

function SlidePane({ page, pageSize }: { page: ISlidePage; pageSize: { width: number; height: number } }) {
  const elements = useMemo(
    () => Object.values(page.pageElements ?? {}).sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)),
    [page.pageElements],
  );
  return (
    <div
      className="cs-slideshow__slide"
      style={{
        width: pageSize.width,
        height: pageSize.height,
        background: rgbToCss(page.pageBackgroundFill?.rgb, '#ffffff'),
      }}
    >
      {elements.map(renderElement)}
    </div>
  );
}

export function SlideShow({ snapshot, startIndex = 0, onExit }: SlideShowProps) {
  const pageOrder = useMemo(() => snapshot.body?.pageOrder ?? [], [snapshot]);
  const pages = useMemo(() => snapshot.body?.pages ?? {}, [snapshot]);
  // Filter to only SLIDE pages (skip MASTER / LAYOUT / NOTES_MASTER which
  // can appear in the imported pageOrder).
  const visiblePageIds = useMemo(
    () => pageOrder.filter((id) => pages[id]?.pageType === PageType.SLIDE || pages[id]?.pageType === undefined),
    [pageOrder, pages],
  );
  const [idx, setIdx] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(0, visiblePageIds.length - 1)));
  const [showNumber, setShowNumber] = useState(true);

  const next = useCallback(() => setIdx((i) => Math.min(i + 1, visiblePageIds.length - 1)), [visiblePageIds.length]);
  const prev = useCallback(() => setIdx((i) => Math.max(i - 1, 0)), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onExit();
          break;
        case 'ArrowRight':
        case ' ':
        case 'PageDown':
          e.preventDefault();
          next();
          break;
        case 'ArrowLeft':
        case 'Backspace':
        case 'PageUp':
          e.preventDefault();
          prev();
          break;
        case 'Home':
          e.preventDefault();
          setIdx(0);
          break;
        case 'End':
          e.preventDefault();
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
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen?.();
          break;
        default:
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [next, prev, onExit, visiblePageIds.length]);

  // Best-effort fullscreen on mount. Some browsers (Safari) require a
  // user-gesture proxy — the Slideshow click counts as that, but auto-
  // mount via key shortcut might silently no-op. That's fine; the
  // overlay still covers the page.
  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  if (visiblePageIds.length === 0) {
    return (
      <div className="cs-slideshow" onClick={onExit}>
        <div className="cs-slideshow__empty">
          <Icon name="info" size={36} />
          <p>No slides to present.</p>
          <button type="button" className="cs-btn cs-btn--ghost" onClick={onExit}>
            Exit
          </button>
        </div>
      </div>
    );
  }

  const currentId = visiblePageIds[idx];
  const currentPage = pages[currentId];
  const pageSize = {
    width: snapshot.pageSize?.width ?? 960,
    height: snapshot.pageSize?.height ?? 540,
  };
  if (!currentPage) {
    return (
      <div className="cs-slideshow" onClick={onExit}>
        <div className="cs-slideshow__empty">
          <p>Slide not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="cs-slideshow" role="dialog" aria-label="Slideshow">
      <div
        className="cs-slideshow__stage"
        onClick={(e) => {
          // Don't advance if the click landed on the toolbar.
          if ((e.target as HTMLElement).closest('.cs-slideshow__toolbar')) return;
          next();
        }}
      >
        <SlidePane page={currentPage} pageSize={pageSize} />
      </div>
      <div className="cs-slideshow__toolbar">
        <button
          type="button"
          className="cs-slideshow__btn"
          onClick={prev}
          disabled={idx === 0}
          title="Previous (Left arrow)"
        >
          <Icon name="chevron_left" size={20} />
        </button>
        {showNumber && (
          <span className="cs-slideshow__counter">
            {idx + 1} / {visiblePageIds.length}
          </span>
        )}
        <button
          type="button"
          className="cs-slideshow__btn"
          onClick={next}
          disabled={idx === visiblePageIds.length - 1}
          title="Next (Right arrow or Space)"
        >
          <Icon name="chevron_right" size={20} />
        </button>
        <span className="cs-slideshow__divider" />
        <button
          type="button"
          className="cs-slideshow__btn"
          onClick={() => {
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen?.();
          }}
          title="Toggle fullscreen (F)"
        >
          <Icon name="fullscreen" size={20} />
        </button>
        <button
          type="button"
          className="cs-slideshow__btn"
          onClick={onExit}
          title="Exit (Escape)"
        >
          <Icon name="close" size={20} />
        </button>
      </div>
    </div>
  );
}

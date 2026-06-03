import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { Univer } from '@univerjs/core';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { Icon } from './icons';
import { getSelectedElement, getSelectedElementCount, subscribeSelection } from './selection';

// Read the live transform (x, y, w, h) for whatever element is currently
// selected. Returns null when nothing is selected or the snapshot can't
// be reached.
//
// Re-runs on selection identity change (bridge notifies). During a drag
// the bridge doesn't fire — the snapshot itself updates in place but
// our component only re-paints when the selection bridge or the
// surrounding props change. Good enough for "you selected this element,
// here's where it sits" UX; the Format pane already covers live drag
// readouts via its transformer subscription.
function readSelectedTransform(): { x: number; y: number; w: number; h: number } | null {
  const sel = getSelectedElement();
  if (!sel) return null;
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return null;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    const el = model?.getPage(sel.pageId)?.pageElements?.[sel.elementId];
    if (!el) return null;
    return {
      x: Math.round(el.left ?? 0),
      y: Math.round(el.top ?? 0),
      w: Math.round(el.width ?? 0),
      h: Math.round(el.height ?? 0),
    };
  } catch {
    return null;
  }
}

// Bottom status bar. Slide count on the left, view-mode toggles + zoom
// slider on the right.
//
// Zoom semantics — `zoom` is the integer percent (100 == 1.0). Owned by
// App.tsx so the View → Zoom menu can drive it from the title bar.
// onZoomChange clamps to 25..400 to match Google Slides' rail.

export interface StatusBarProps {
  slideCount: number;
  activeSlideIndex?: number;
  zoom: number;
  onZoomChange: (next: number) => void;
  notesVisible?: boolean;
  onToggleNotes?: () => void;
}

const ZOOM_MIN = 25;
const ZOOM_MAX = 400;

export function StatusBar({
  slideCount,
  activeSlideIndex = 0,
  zoom,
  onZoomChange,
  notesVisible,
  onToggleNotes,
}: StatusBarProps) {
  const { t } = useTranslation('statusbar');
  const clamp = (n: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(n)));
  const safeSlideIndex = slideCount === 0 ? 0 : Math.min(activeSlideIndex + 1, slideCount);

  // Re-render when the selection bridge fires (new element selected /
  // cleared). The transform is then re-read inside the render below.
  useSyncExternalStore(subscribeSelection, getSelectedElement, getSelectedElement);
  // Drag-tick freshness: while a selection exists, requestAnimationFrame
  // poll the snapshot so x/y/w/h tracks the live drag. The polling stops
  // automatically when the selection clears (effect re-runs).
  const [, setTick] = useState(0);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (getSelectedElement()) {
        setTick((n) => (n + 1) & 0xffff);
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  const xform = readSelectedTransform();
  const selCount = getSelectedElementCount();

  return (
    <footer className="cs-statusbar">
      <div className="cs-statusbar__left">
        <span className="cs-statusbar__slide-count">
          {t('slideCount', { count: slideCount, current: safeSlideIndex, total: slideCount })}
        </span>
        {selCount > 1 ? (
          // Multi-select: show the count rather than the (single-element)
          // X/Y/W/H, which can't represent a group selection meaningfully.
          <span
            className="cs-statusbar__selection"
            title={t('selectionCountTooltip', 'Number of selected elements')}
          >
            <Icon name="select_all" size={14} />
            <span>{t('selectionCount', '{{count}} elements selected', { count: selCount })}</span>
          </span>
        ) : xform ? (
          <span
            className="cs-statusbar__selection"
            title={t('selectionTooltip', 'Position and size of the selected element')}
          >
            <Icon name="select_all" size={14} />
            <span>X {xform.x} · Y {xform.y}</span>
            <span className="cs-statusbar__sep" aria-hidden="true" />
            <span>{xform.w} × {xform.h}</span>
          </span>
        ) : null}
      </div>
      <div className="cs-statusbar__right">
        <button type="button" className="cs-statusbar__view-btn is-active" title={t('viewNormal')}>
          <Icon name="view_agenda" size={16} filled />
        </button>
        <button
          type="button"
          className={`cs-statusbar__view-btn ${notesVisible ? 'is-active' : ''}`}
          title={notesVisible ? t('notesHide') : t('notesShow')}
          aria-pressed={notesVisible}
          onClick={onToggleNotes}
        >
          <Icon name="sticky_note_2" size={16} filled={notesVisible} />
        </button>
        <span className="cs-statusbar__sep" aria-hidden="true" />
        <button
          type="button"
          className="cs-statusbar__zoom-btn"
          title={t('zoomOut')}
          onClick={() => onZoomChange(clamp(zoom - 10))}
          disabled={zoom <= ZOOM_MIN}
        >
          <Icon name="remove" size={16} />
        </button>
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={5}
          value={zoom}
          onChange={(e) => onZoomChange(clamp(Number(e.target.value)))}
          className="cs-statusbar__zoom-slider"
          aria-label={t('zoomLabel')}
        />
        <button
          type="button"
          className="cs-statusbar__zoom-btn"
          title={t('zoomIn')}
          onClick={() => onZoomChange(clamp(zoom + 10))}
          disabled={zoom >= ZOOM_MAX}
        >
          <Icon name="add" size={16} />
        </button>
        <button
          type="button"
          className="cs-statusbar__zoom-value"
          title={t('zoomReset')}
          onClick={() => onZoomChange(100)}
        >
          {t('zoomValue', { percent: zoom })}
        </button>
        <span className="cs-statusbar__sep" aria-hidden="true" />
        {/* Present icon — bottom-right is the most direct mouse path to
            slideshow once the deck is done. Dispatches via the same
            window global the Toolbar Slideshow CTA uses (App.tsx exposes
            it on mount). Audit S3. */}
        <button
          type="button"
          className="cs-statusbar__zoom-btn cs-statusbar__present-btn"
          title={t('presentTooltip')}
          aria-label={t('present')}
          onClick={() => {
            const w = window as Window & { __casualSlides_openSlideshow?: () => void };
            w.__casualSlides_openSlideshow?.();
          }}
        >
          <Icon name="slideshow" size={16} filled />
        </button>
      </div>
    </footer>
  );
}

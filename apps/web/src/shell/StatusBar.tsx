import { useTranslation } from 'react-i18next';
import { Icon } from './icons';

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

  return (
    <footer className="cs-statusbar">
      <div className="cs-statusbar__left">
        <span className="cs-statusbar__slide-count">
          {t('slideCount', { count: slideCount, current: safeSlideIndex, total: slideCount })}
        </span>
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

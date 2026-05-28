import type { ISlidePage } from '@univerjs/slides';
import { useTranslation } from '../i18n';
import { Icon } from './icons';
import { SlideTile } from './SlideTile';

// PresenterView — two-pane layout shown when the user toggles presenter
// mode inside the slideshow.
//
//   Left pane (≈60% width)  — current slide rendered at full fidelity.
//   Right pane (≈40% width) — stack of:
//                              1. next-slide preview thumbnail
//                              2. speaker notes (scrollable)
//                              3. elapsed timer + reset
//
// All chrome lives outside this component — SlideShow.tsx still owns the
// bottom toolbar, the blackscreen overlay, the jump-to-slide popover and
// every keybind. This file only concerns itself with the dual-pane
// content.

export interface PresenterViewProps {
  currentPage: ISlidePage;
  nextPage: ISlidePage | null;
  pageSize: { width: number; height: number };
  notes: string;
  elapsedMs: number;
  onResetTimer: () => void;
  currentNumber: number;
  totalSlides: number;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function PresenterView({
  currentPage,
  nextPage,
  pageSize,
  notes,
  elapsedMs,
  onResetTimer,
  currentNumber,
  totalSlides,
}: PresenterViewProps) {
  const { t } = useTranslation('slideshow');
  return (
    <div className="cs-slideshow__presenter">
      <div className="cs-slideshow__presenter-main">
        <div className="cs-slideshow__presenter-label">
          {t('presenter.currentLabel', {
            current: currentNumber,
            total: totalSlides,
          })}
        </div>
        <div className="cs-slideshow__presenter-tile">
          <SlideTile page={currentPage} pageSize={pageSize} />
        </div>
      </div>
      <div className="cs-slideshow__presenter-side">
        <div className="cs-slideshow__presenter-next">
          <div className="cs-slideshow__presenter-label">
            <Icon name="keyboard_double_arrow_right" size={14} />
            <span>{t('presenter.nextLabel')}</span>
          </div>
          <div className="cs-slideshow__presenter-next-tile">
            {nextPage ? (
              <SlideTile page={nextPage} pageSize={pageSize} />
            ) : (
              <div className="cs-slideshow__presenter-next-empty">
                {t('presenter.endOfDeck')}
              </div>
            )}
          </div>
        </div>
        <div
          className="cs-slideshow__presenter-notes"
          aria-label={t('presenter.notesAriaLabel')}
        >
          <div className="cs-slideshow__presenter-notes-header">
            <Icon name="note" size={14} />
            <span>{t('presenter.notesLabel')}</span>
          </div>
          <div className="cs-slideshow__presenter-notes-body">
            {notes.trim().length === 0 ? (
              <span className="cs-slideshow__presenter-notes-empty">
                {t('presenter.notesEmpty')}
              </span>
            ) : (
              notes
            )}
          </div>
        </div>
        <div className="cs-slideshow__presenter-timer">
          <Icon name="timer" size={14} />
          <span className="cs-slideshow__presenter-timer-value">
            {formatElapsed(elapsedMs)}
          </span>
          <button
            type="button"
            className="cs-slideshow__btn cs-slideshow__btn--ghost"
            onClick={onResetTimer}
            title={t('presenter.resetTimerTooltip')}
            aria-label={t('presenter.resetTimerTooltip')}
          >
            {t('presenter.resetTimer')}
          </button>
        </div>
      </div>
    </div>
  );
}

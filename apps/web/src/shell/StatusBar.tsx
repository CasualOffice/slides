import { useState } from 'react';
import { Icon } from './icons';

// Bottom status bar. Slide count + locale on the left, view-mode toggles
// + zoom slider on the right. Zoom is visual-only in v0.0.x; wiring to
// Univer's scale API follows in P1.

export interface StatusBarProps {
  slideCount: number;
  activeSlideIndex?: number;
  notesVisible?: boolean;
  onToggleNotes?: () => void;
}

export function StatusBar({ slideCount, activeSlideIndex = 0, notesVisible, onToggleNotes }: StatusBarProps) {
  const [zoom, setZoom] = useState(100);

  return (
    <footer className="cs-statusbar">
      <div className="cs-statusbar__left">
        <span className="cs-statusbar__slide-count">
          Slide {Math.min(activeSlideIndex + 1, slideCount)} of {slideCount}
        </span>
        <span className="cs-statusbar__sep" aria-hidden="true" />
        <span className="cs-statusbar__lang">English (US)</span>
      </div>
      <div className="cs-statusbar__right">
        <button type="button" className="cs-statusbar__view-btn is-active" title="Normal view">
          <Icon name="view_agenda" size={14} />
        </button>
        <button type="button" className="cs-statusbar__view-btn" disabled title="Slide sorter — coming soon">
          <Icon name="view_module" size={14} />
        </button>
        <button
          type="button"
          className={`cs-statusbar__view-btn ${notesVisible ? 'is-active' : ''}`}
          title={notesVisible ? 'Hide speaker notes' : 'Show speaker notes'}
          onClick={onToggleNotes}
        >
          <Icon name="sticky_note_2" size={14} />
        </button>
        <span className="cs-statusbar__sep" aria-hidden="true" />
        <button
          type="button"
          className="cs-statusbar__zoom-btn"
          title="Zoom out"
          onClick={() => setZoom(Math.max(25, zoom - 10))}
        >
          <Icon name="remove" size={14} />
        </button>
        <input
          type="range"
          min={25}
          max={400}
          step={5}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="cs-statusbar__zoom-slider"
          aria-label="Zoom"
        />
        <button
          type="button"
          className="cs-statusbar__zoom-btn"
          title="Zoom in"
          onClick={() => setZoom(Math.min(400, zoom + 10))}
        >
          <Icon name="add" size={14} />
        </button>
        <span className="cs-statusbar__zoom-value">{zoom}%</span>
      </div>
    </footer>
  );
}

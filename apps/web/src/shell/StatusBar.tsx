import { useState } from 'react';

// PowerPoint-style status bar. Slide count + view-mode toggle on the left,
// zoom controls on the right. Zoom is visual-only in v0.0.x; wiring to
// Univer's scale API follows in P1.

export interface StatusBarProps {
  slideCount: number;
  activeSlideIndex?: number;
}

export function StatusBar({ slideCount, activeSlideIndex = 0 }: StatusBarProps) {
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
          <span className="material-symbols-outlined">view_agenda</span>
        </button>
        <button type="button" className="cs-statusbar__view-btn" disabled title="Slide sorter — coming soon">
          <span className="material-symbols-outlined">view_module</span>
        </button>
        <button type="button" className="cs-statusbar__view-btn" disabled title="Notes page — coming soon">
          <span className="material-symbols-outlined">sticky_note_2</span>
        </button>
        <button type="button" className="cs-statusbar__view-btn" disabled title="Slide show — coming soon">
          <span className="material-symbols-outlined">play_arrow</span>
        </button>
        <span className="cs-statusbar__sep" aria-hidden="true" />
        <button
          type="button"
          className="cs-statusbar__zoom-btn"
          title="Zoom out"
          onClick={() => setZoom(Math.max(25, zoom - 10))}
        >
          <span className="material-symbols-outlined">remove</span>
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
          <span className="material-symbols-outlined">add</span>
        </button>
        <span className="cs-statusbar__zoom-value">{zoom}%</span>
      </div>
    </footer>
  );
}

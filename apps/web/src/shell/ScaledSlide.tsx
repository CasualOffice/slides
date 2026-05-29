import { useEffect, useRef, useState } from 'react';
import type { ISlidePage } from '@univerjs/slides';
import { SlideTile } from './SlideTile';

// Fits a SlideTile (which renders at the slide's native px) into whatever
// box the parent gives it, preserving aspect ratio. The outer element holds
// the slide's aspect via `aspect-ratio` and clips overflow; the inner element
// is the native-size tile scaled by `containerWidth / pageWidth` (measured
// with a ResizeObserver). Used by the presenter view + next-slide preview so
// the tiles don't overflow their panes.

export interface ScaledSlideProps {
  page: ISlidePage;
  pageSize: { width: number; height: number };
  className?: string;
}

export function ScaledSlide({ page, pageSize, className }: ScaledSlideProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setScale(w / pageSize.width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageSize.width]);

  return (
    <div
      ref={ref}
      className={`cs-scaled-slide ${className ?? ''}`}
      style={{ aspectRatio: `${pageSize.width} / ${pageSize.height}` }}
    >
      <div
        className="cs-scaled-slide__inner"
        style={{
          width: pageSize.width,
          height: pageSize.height,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          // Hide until measured to avoid a one-frame native-size flash.
          visibility: scale > 0 ? 'visible' : 'hidden',
        }}
      >
        <SlideTile page={page} pageSize={pageSize} />
      </div>
    </div>
  );
}

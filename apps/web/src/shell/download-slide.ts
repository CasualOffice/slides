import * as ReactDOM from 'react-dom/client';
import { createElement } from 'react';
import { toPng } from 'html-to-image';
import type { ISlidePage } from '@univerjs/slides';
import { SlideTile } from './SlideTile';

// Render a SlideTile offscreen, rasterize it via html-to-image, and trigger a
// PNG download. The Tile is mounted into a hidden container at native px so
// the rasterizer captures the slide exactly as the editor displays it — same
// renderer the slideshow/presenter use. No dependency on the Univer canvas
// (which is GPU-backed; pulling pixels from it would need an export API we
// don't have).

function safeFileName(name: string, suffix: string): string {
  const base = (name || 'slide').trim().replace(/[\\/:*?"<>|]+/g, '_');
  return `${base}${suffix}.png`;
}

function downloadDataUrl(dataUrl: string, fileName: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function downloadSlideAsPng(
  page: ISlidePage,
  pageSize: { width: number; height: number },
  fileName: string,
  slideNumber: number,
): Promise<void> {
  // Offscreen container at native size. Positioned far off-screen instead
  // of using visibility:hidden — html-to-image clones the DOM and the clone
  // inherits visibility, so a hidden host rasterizes blank. left:-10000px
  // keeps it out of sight while still painting.
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = `${pageSize.width}px`;
  host.style.height = `${pageSize.height}px`;
  host.style.pointerEvents = 'none';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);

  const root = ReactDOM.createRoot(host);
  root.render(createElement(SlideTile, { page, pageSize }));

  try {
    // Let React paint + give the fonts a frame to settle.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (document.fonts?.ready) {
      await document.fonts.ready.catch(() => {});
    }
    await new Promise<void>((r) => setTimeout(r, 60));

    const target = host.firstElementChild as HTMLElement | null;
    if (!target) return;

    const dataUrl = await toPng(target, {
      width: pageSize.width,
      height: pageSize.height,
      pixelRatio: 2,
      cacheBust: false,
      backgroundColor: '#ffffff',
      skipFonts: false,
    });
    downloadDataUrl(dataUrl, safeFileName(fileName, `-slide-${slideNumber}`));
  } finally {
    root.unmount();
    host.remove();
  }
}

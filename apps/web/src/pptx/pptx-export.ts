import pptxgen from 'pptxgenjs';
import type { IPageElement, ISlideData, ISlidePage, ISlideRichTextProps } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';

// Convert an ISlideData snapshot into a .pptx Blob via PptxGenJS.
//
// Fidelity target: T1 ("Core") from docs/PPTX_PIPELINE.md — text frames,
// transforms, slide order, page size. T2+ (masters, shapes, images, tables,
// charts, animations) lands in P1+.
//
// Coordinate system: ISlideData stores pixels @ 96 DPI; PptxGenJS expects
// inches. The conversion factor is 1 in = 96 px.

const px2in = (px: number | undefined): number => (px ?? 0) / 96;

/**
 * Normalize a colour value from the ISlideData model to the form PptxGenJS
 * wants: uppercase 6-char hex, no leading `#`.
 *
 * Accepts:
 *   '#rrggbb'  | '#RGB'       (CSS hex)
 *   'rgb(r,g,b)' / 'rgb(r, g, b)' (CSS rgb)
 *   undefined / unknown        → fallback '000000'
 */
// Note: Univer's `Nullable<T>` is `T | null | undefined | void`. Accept the
// same surface and treat anything falsy as the fallback.
function normalizeColor(rgb: string | null | undefined | void, fallback = '000000'): string {
  if (!rgb) return fallback;
  const trimmed = rgb.trim();

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      return hex.split('').map((c) => c + c).join('').toUpperCase();
    }
    if (hex.length === 6) return hex.toUpperCase();
    return fallback;
  }

  const m = trimmed.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (m) {
    return [m[1], m[2], m[3]]
      .map((n) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }
  return fallback;
}

function emitTextElement(slide: pptxgen.Slide, element: IPageElement, richText: ISlideRichTextProps) {
  slide.addText(richText.text ?? '', {
    x: px2in(element.left),
    y: px2in(element.top),
    w: px2in(element.width),
    h: px2in(element.height),
    fontSize: richText.fs ?? 18,
    color: normalizeColor(richText.cl?.rgb, '111827'),
    bold: !!richText.bl,
    italic: !!richText.it,
    underline: richText.ul ? { style: 'sng' } : undefined,
    rotate: element.angle ?? 0,
    // Default valign — PowerPoint's placeholder default is top-aligned.
    valign: 'top',
    // The model stores newlines as literal '\n' in `text`. PptxGenJS honors
    // these as paragraph breaks when passed as a plain string.
    breakLine: false,
  });
}

function emitPage(deck: pptxgen, page: ISlidePage) {
  // Only SLIDE-type pages are emitted as real pptx slides for now. Masters /
  // layouts / notes round-trip via the resources passthrough in P1+.
  if (page.pageType !== PageType.SLIDE) return;

  const slide = deck.addSlide();

  // Background fill — pptxgenjs `background: { color }` expects hex w/o `#`.
  if (page.pageBackgroundFill?.rgb) {
    slide.background = { color: normalizeColor(page.pageBackgroundFill.rgb, 'FFFFFF') };
  }

  // Render elements in z-index order so the top-most paint last.
  const elements = Object.values(page.pageElements ?? {}).sort(
    (a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0),
  );

  for (const element of elements) {
    if (element.type === PageElementType.TEXT && element.richText) {
      emitTextElement(slide, element, element.richText);
      continue;
    }
    // SHAPE / IMAGE / TABLE / CHART / LINE / VIDEO — left for P1+ once the
    // model carries them. Skipping is the right move for the spike — they
    // are simply absent from the exported deck.
  }
}

export async function exportSlidesToPptx(snapshot: ISlideData): Promise<Blob> {
  const deck = new pptxgen();
  deck.title = snapshot.title || 'Untitled deck';
  deck.author = 'Casual Slides';
  deck.company = 'Casual Slides';

  // Map the deck-level page size. ISlideData stores pixels; PptxGenJS layouts
  // are in inches. 960×540 px (the Univer default) is 10×5.625 in = 16:9.
  const width = px2in(snapshot.pageSize?.width ?? 960);
  const height = px2in(snapshot.pageSize?.height ?? 540);
  deck.defineLayout({ name: 'CASUAL_SLIDES_DECK', width, height });
  deck.layout = 'CASUAL_SLIDES_DECK';

  const pageOrder = snapshot.body?.pageOrder ?? [];
  const pages = snapshot.body?.pages ?? {};
  for (const pageId of pageOrder) {
    const page = pages[pageId];
    if (page) emitPage(deck, page);
  }

  // PptxGenJS returns `string | Blob | Buffer` depending on outputType.
  // 'blob' guarantees a browser-usable Blob.
  const result = await deck.write({ outputType: 'blob' });
  if (!(result instanceof Blob)) {
    throw new Error('PptxGenJS did not return a Blob — runtime mismatch');
  }
  return result;
}

import JSZip from 'jszip';
import pptxgen from 'pptxgenjs';
import type { IImage, IPageElement, IShape, ISlideData, ISlidePage, ISlideRichTextProps } from '@univerjs/slides';
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
// D12 — detect the transparent sentinel emitted by the import side for
// shapes carrying `<a:noFill/>` (and for line-like prsts). When present,
// the export skips PptxGenJS's `fill` opt entirely so the resulting
// pptx round-trips the no-fill semantics rather than baking white in.
function isTransparentFill(rgb: string | null | undefined | void): boolean {
  if (!rgb) return false;
  const t = rgb.trim().toLowerCase();
  if (t === 'transparent') return true;
  return /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/.test(t);
}

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

function emitShapeElement(slide: pptxgen.Slide, element: IPageElement, shape: IShape) {
  // ISlideData's ShapeType uses OOXML prstGeom values directly ('rect',
  // 'ellipse', 'triangle', ...) — PptxGenJS shape names are the same strings
  // so we pass through.
  //
  // PptxGenJS rejects unknown shape names. For anything we haven't validated
  // we fall back to 'rect'; the visible bounds are correct even if the
  // outline is wrong.
  const shapeType = shape.shapeType ?? 'rect';

  slide.addShape(shapeType as pptxgen.SHAPE_NAME, {
    x: px2in(element.left),
    y: px2in(element.top),
    w: px2in(element.width),
    h: px2in(element.height),
    rotate: element.angle ?? 0,
    flipH: !!element.flipX,
    flipV: !!element.flipY,
    fill:
      shape.shapeProperties?.shapeBackgroundFill?.rgb &&
      !isTransparentFill(shape.shapeProperties.shapeBackgroundFill.rgb)
        ? { color: normalizeColor(shape.shapeProperties.shapeBackgroundFill.rgb, 'FFFFFF') }
        : undefined,
    line: shape.shapeProperties?.outline
      ? {
          color: normalizeColor(shape.shapeProperties.outline.outlineFill?.rgb, '000000'),
          width: shape.shapeProperties.outline.weight ?? 1,
        }
      : undefined,
    rectRadius: shape.shapeProperties?.radius,
  });

  // Shapes can carry inline text — render it as a text overlay on the same
  // bounds. PowerPoint stores text-in-shape via <p:txBody> inside <p:sp>;
  // PptxGenJS doesn't expose a text-in-shape API, so a separate addText with
  // identical bounds is the round-trip-safe equivalent.
  if (shape.text) {
    slide.addText(shape.text, {
      x: px2in(element.left),
      y: px2in(element.top),
      w: px2in(element.width),
      h: px2in(element.height),
      fontSize: 18,
      color: '111827',
      valign: 'middle',
      align: 'center',
    });
  }
}

// Resolve the bytes-or-URL source for an IMAGE element to the form
// PptxGenJS's addImage() accepts. We prefer contentUrl when it's already a
// `data:` URI or an http(s) URL; otherwise we synthesize a `data:` URI from
// base64Cache. Returns null when there's nothing usable.
//
// MIME caveat: if base64Cache doesn't have a `data:` prefix we default to
// `image/png`. That's the most common embed (PowerPoint emits PNG for
// pastes, screenshots, etc.) — JPEG/GIF/SVG base64 dropped through this
// path would still embed as `image/png` and survive bytes-wise; viewers
// sniff the actual content. Tracked in PPTX_PIPELINE.md.
function imageSource(image: IImage): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = image.imageProperties as any;
  if (!props) return null;
  const contentUrl: unknown = props.contentUrl;
  if (typeof contentUrl === 'string' && contentUrl.length > 0) {
    if (contentUrl.startsWith('data:') || /^https?:/i.test(contentUrl)) {
      return contentUrl;
    }
  }
  const base64: unknown = props.base64Cache;
  if (typeof base64 === 'string' && base64.length > 0) {
    if (base64.startsWith('data:')) return base64;
    return `data:image/png;base64,${base64}`;
  }
  return null;
}

function emitImageElement(slide: pptxgen.Slide, element: IPageElement, image: IImage) {
  const data = imageSource(image);
  if (!data) {
    // eslint-disable-next-line no-console
    console.warn(`[pptx-export] image element ${element.id} has no usable contentUrl/base64Cache; dropped`);
    return;
  }
  slide.addImage({
    data,
    x: px2in(element.left),
    y: px2in(element.top),
    w: px2in(element.width),
    h: px2in(element.height),
    rotate: element.angle ?? 0,
    flipH: !!element.flipX,
    flipV: !!element.flipY,
  });
}

function emitTextElement(slide: pptxgen.Slide, element: IPageElement, richText: ISlideRichTextProps) {
  // C13 export-side — `documentStyle.renderConfig.fontScale` carries
  // the parsed `<a:normAutofit fontScale>` fraction. The importer
  // stopped multiplying `fs` at import (so the model preserves the
  // authored size and re-import doesn't double-shrink). On export we
  // BAKE the multiplication back into the static `fs` so PowerPoint
  // reads the visually-correct size — PptxGenJS doesn't expose a
  // `normAutofit fontScale="N"` opt, so the autofit metadata itself is
  // intentionally lost. Net effect: bytes-different round-trip, but
  // visually stable through any number of edit / save cycles.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fontScale = (richText.rich as any)?.documentStyle?.renderConfig?.fontScale;
  const baseFs = richText.fs ?? 18;
  const fs = typeof fontScale === 'number' && fontScale > 0 && fontScale !== 1
    ? Math.round(baseFs * fontScale * 10) / 10
    : baseFs;

  slide.addText(richText.text ?? '', {
    x: px2in(element.left),
    y: px2in(element.top),
    w: px2in(element.width),
    h: px2in(element.height),
    fontSize: fs,
    fontFace: richText.ff || undefined,
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

// G1-G4 — emit a TABLE page element through PptxGenJS `addTable`. Maps:
//  • cells with rowSpan/colSpan → PptxGenJS rowspan/colspan (skip merge
//    target cells that are just placeholders — hMerge/vMerge=true)
//  • fillRgb → cell.options.fill
//  • outlineRgb/outlineWeight → cell.options.border
//  • text (or rich first-run text) → cell.text
function emitTableElement(slide: pptxgen.Slide, element: IPageElement): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (element as any).table;
  if (!table?.rows?.length) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TableRow = { height?: number; cells: Array<any> };
  const rows: TableRow[] = table.rows;

  const pgRows: pptxgen.TableRow[] = [];
  for (const row of rows) {
    const pgCells: pptxgen.TableCell[] = [];
    for (const cell of row.cells) {
      // Skip merge-target cells — they don't render content, the
      // origin cell's rowspan/colspan covers them.
      if (cell.hMerge || cell.vMerge) {
        pgCells.push({ text: '' });
        continue;
      }
      const opts: pptxgen.TableCellProps = {};
      if (typeof cell.rowSpan === 'number' && cell.rowSpan > 1) opts.rowspan = cell.rowSpan;
      if (typeof cell.colSpan === 'number' && cell.colSpan > 1) opts.colspan = cell.colSpan;
      if (typeof cell.fillRgb === 'string') {
        opts.fill = { color: normalizeColor(cell.fillRgb, 'FFFFFF') };
      }
      if (typeof cell.outlineRgb === 'string') {
        opts.border = {
          color: normalizeColor(cell.outlineRgb, '000000'),
          pt: cell.outlineWeight ?? 1,
        } as pptxgen.BorderProps;
      }
      pgCells.push({ text: cell.text ?? '', options: opts });
    }
    pgRows.push(pgCells);
  }

  const opts: pptxgen.TableProps = {
    x: px2in(element.left),
    y: px2in(element.top),
    w: px2in(element.width),
    h: px2in(element.height),
  };
  if (Array.isArray(table.columnWidths) && table.columnWidths.length > 0) {
    opts.colW = table.columnWidths.map((px: number) => px2in(px));
  }
  slide.addTable(pgRows, opts);
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
    if (element.type === PageElementType.SHAPE && element.shape) {
      emitShapeElement(slide, element, element.shape);
      continue;
    }
    if (element.type === PageElementType.IMAGE && element.image) {
      emitImageElement(slide, element, element.image);
      continue;
    }
    // G1-G4 — native TABLE page element (Wave 7o).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (element.type === (6 as any) && (element as any).table) {
      emitTableElement(slide, element);
      continue;
    }
    // CHART / VIDEO — captured on import via passthrough; the chart XML
    // rides via ISlideData.resources and is re-injected by
    // restorePassthrough, but the slide-XML reference is not emitted
    // (would need post-generation surgery on the slide XML). Future wave.
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

  // Wave 7n — restore captured raw OOXML parts. PptxGenJS doesn't touch
  // notesSlides / comments / diagrams / ink, so injecting our captured
  // versions verbatim is safe. layouts / masters / themes are
  // intentionally NOT restored because PptxGenJS generates its own and
  // the slide rels reference them — overwriting would break the deck.
  return await restorePassthrough(result, snapshot);
}

interface PptxRawPayload {
  layouts?: Record<string, string>;
  masters?: Record<string, string>;
  themes?: Record<string, string>;
  notesSlides?: Record<string, string>;
  comments?: Record<string, string>;
  diagrams?: Record<string, string>;
  ink?: Record<string, string>;
  charts?: Record<string, string>;
  rels?: Record<string, string>;
  // K2 — passthrough of `docProps/custom.xml`. PptxGenJS doesn't emit
  // a custom-props part, so re-injecting our captured bytes round-trips
  // the author-defined custom metadata. The bucket is keyed by zip-path
  // so the inject pass writes it verbatim.
  customProps?: Record<string, string>;
}

async function restorePassthrough(blob: Blob, snapshot: ISlideData): Promise<Blob> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resources = (snapshot as any).resources as Array<{ name: string; data: string }> | undefined;
  const entry = resources?.find((r) => r.name === 'CASUAL_SLIDES_PPTX_RAW');
  if (!entry) return blob;

  let payload: PptxRawPayload;
  try {
    payload = JSON.parse(entry.data) as PptxRawPayload;
  } catch {
    return blob;
  }

  // Restore only the categories PptxGenJS doesn't generate. Skipping
  // layouts/masters/themes preserves PptxGenJS's wired rels.
  const restorableBuckets: Array<keyof PptxRawPayload> = ['notesSlides', 'comments', 'diagrams', 'ink', 'charts', 'rels', 'customProps'];
  let hasAny = false;
  for (const key of restorableBuckets) {
    if (payload[key] && Object.keys(payload[key] ?? {}).length > 0) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return blob;

  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  for (const key of restorableBuckets) {
    const bucket = payload[key] ?? {};
    for (const [zipPath, content] of Object.entries(bucket)) {
      if (typeof content === 'string' && content.length > 0) {
        // `rels` bucket: only inject rels files whose target part also
        // got injected. Skip rels for layouts/masters/themes since we
        // don't restore those parts.
        if (key === 'rels') {
          const isSkipped =
            zipPath.startsWith('ppt/slideLayouts/_rels/') ||
            zipPath.startsWith('ppt/slideMasters/_rels/') ||
            zipPath.startsWith('ppt/theme/_rels/');
          if (isSkipped) continue;
        }
        zip.file(zipPath, content);
      }
    }
  }

  return await zip.generateAsync({ type: 'blob', mimeType: blob.type || 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

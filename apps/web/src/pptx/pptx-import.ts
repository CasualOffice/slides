import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { IPageElement, ISlideData, ISlidePage } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';

// pptx import — JSZip + fast-xml-parser → ISlideData.
//
// Current scope (T1 partial):
//   ✅ pageSize from <p:sldSz cx cy> (EMU → px, /9525)
//   ✅ slide order from <p:sldIdLst><p:sldId r:id=…>
//   ✅ each <p:sp> with <p:txBody> → TEXT element with transform
//   ❌ shapes geometry, images, masters, themes — deferred until the
//      audit corpus lands per docs/PPTX_PIPELINE.md
//
// Coordinate system: pptx OOXML uses EMU. 914_400 EMU = 1 inch, 9525 EMU = 1 px
// at 96 DPI. We invert the px2in used by the export side.

const EMU_PER_PIXEL = 9525;
const emu2px = (emu: number | string | undefined): number => {
  if (emu === undefined) return 0;
  const n = typeof emu === 'string' ? parseInt(emu, 10) : emu;
  return Number.isFinite(n) ? n / EMU_PER_PIXEL : 0;
};

// fast-xml-parser config — preserve attributes (we need cx/cy/r:id/etc.) and
// don't collapse single-child arrays to scalars (lets us iterate uniformly).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: false,
  trimValues: false,
});

interface XmlNode {
  [key: string]: unknown;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function findChild(node: unknown, key: string): unknown {
  if (!node || typeof node !== 'object') return undefined;
  return (node as XmlNode)[key];
}

function extractRelMap(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const parsed = parser.parse(relsXml) as XmlNode;
  const rels = findChild(parsed, 'Relationships');
  const rel = toArray(findChild(rels, 'Relationship'));
  for (const r of rel) {
    if (typeof r !== 'object' || !r) continue;
    const id = (r as XmlNode)['@Id'];
    const target = (r as XmlNode)['@Target'];
    if (typeof id === 'string' && typeof target === 'string') map.set(id, target);
  }
  return map;
}

function extractTextFromTxBody(txBody: unknown): string {
  // <p:txBody><a:p><a:r><a:t>text</a:t></a:r></a:p></p:txBody>
  // Multiple paragraphs join with \n; multiple runs in a paragraph concat.
  const paragraphs = toArray(findChild(txBody, 'a:p'));
  const lines: string[] = [];
  for (const p of paragraphs) {
    const runs = toArray(findChild(p, 'a:r'));
    const inline = runs
      .map((r) => {
        const t = findChild(r, 'a:t');
        return typeof t === 'string' ? t : (t as XmlNode | undefined)?.['#text'] ?? '';
      })
      .filter((s) => typeof s === 'string')
      .join('');
    lines.push(inline as string);
  }
  return lines.join('\n');
}

function extractElementsFromSlideXml(slideXml: string): IPageElement[] {
  const parsed = parser.parse(slideXml) as XmlNode;
  // sld → cSld → spTree → sp[]
  const spTree = findChild(findChild(findChild(parsed, 'p:sld'), 'p:cSld'), 'p:spTree');
  const shapes = toArray(findChild(spTree, 'p:sp'));

  const elements: IPageElement[] = [];
  let zIndex = 1;
  for (const sp of shapes) {
    if (!sp || typeof sp !== 'object') continue;

    // Transform — <p:spPr><a:xfrm><a:off x y/><a:ext cx cy/></a:xfrm>
    const spPr = findChild(sp, 'p:spPr');
    const xfrm = findChild(spPr, 'a:xfrm');
    const off = findChild(xfrm, 'a:off') as XmlNode | undefined;
    const ext = findChild(xfrm, 'a:ext') as XmlNode | undefined;

    const left = emu2px(off?.['@x'] as string | undefined);
    const top = emu2px(off?.['@y'] as string | undefined);
    const width = emu2px(ext?.['@cx'] as string | undefined);
    const height = emu2px(ext?.['@cy'] as string | undefined);

    // Text body
    const txBody = findChild(sp, 'p:txBody');
    if (txBody) {
      const text = extractTextFromTxBody(txBody);
      const id = `el-${zIndex}`;
      elements.push({
        id,
        zIndex,
        left,
        top,
        width,
        height,
        title: '',
        description: '',
        type: PageElementType.TEXT,
        richText: { text },
      });
      zIndex += 1;
      continue;
    }

    // Shape without text — represent as a shape with rect fallback. Geometry
    // mapping is deferred; we record the bounds so a round-trip preserves
    // position even if the visual outline is wrong.
    if (spPr) {
      const id = `el-${zIndex}`;
      elements.push({
        id,
        zIndex,
        left,
        top,
        width,
        height,
        title: '',
        description: '',
        type: PageElementType.SHAPE,
        shape: {
          shapeType: 'rect' as never, // narrow against ShapeType
          text: '',
          shapeProperties: {
            shapeBackgroundFill: { rgb: 'rgb(255, 255, 255)' },
          },
        },
      });
      zIndex += 1;
    }
  }

  return elements;
}

export async function importPptxToSlides(file: ArrayBuffer, fileName: string): Promise<ISlideData> {
  const zip = await JSZip.loadAsync(file);

  // 1. Deck-level: ppt/presentation.xml gives slide size + slide id order.
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
  if (!presentationXml) {
    throw new Error('ppt/presentation.xml not found — not a valid pptx');
  }
  const presParsed = parser.parse(presentationXml) as XmlNode;
  const presentation = findChild(presParsed, 'p:presentation') as XmlNode | undefined;

  const sldSz = findChild(presentation, 'p:sldSz') as XmlNode | undefined;
  const pageSize = {
    width: emu2px((sldSz?.['@cx'] as string | undefined) ?? '9144000'),  // default 10"
    height: emu2px((sldSz?.['@cy'] as string | undefined) ?? '6858000'), // default 7.5"
  };

  const sldIdLst = findChild(presentation, 'p:sldIdLst');
  const sldIds = toArray(findChild(sldIdLst, 'p:sldId'));

  // 2. Resolve slide rId → slide xml path via ppt/_rels/presentation.xml.rels.
  const presRelsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  const relMap = presRelsXml ? extractRelMap(presRelsXml) : new Map<string, string>();

  // 3. For each slide id, fetch the slide xml + extract elements.
  const pages: Record<string, ISlidePage> = {};
  const pageOrder: string[] = [];

  for (let i = 0; i < sldIds.length; i += 1) {
    const sldId = sldIds[i] as XmlNode;
    const rId = sldId['@r:id'] as string | undefined;
    if (!rId) continue;
    const relTarget = relMap.get(rId);
    if (!relTarget) continue;
    // relTarget is relative to ppt/, e.g. 'slides/slide1.xml' → 'ppt/slides/slide1.xml'
    const slidePath = relTarget.startsWith('/') ? relTarget.slice(1) : `ppt/${relTarget}`;
    const slideXml = await zip.file(slidePath)?.async('string');
    if (!slideXml) continue;

    const pageId = `page-${i + 1}`;
    const elements = extractElementsFromSlideXml(slideXml);
    const elementMap: Record<string, IPageElement> = {};
    for (const el of elements) elementMap[el.id] = el;

    pages[pageId] = {
      id: pageId,
      pageType: PageType.SLIDE,
      zIndex: i + 1,
      title: `Slide ${i + 1}`,
      description: '',
      pageBackgroundFill: { rgb: 'rgb(255, 255, 255)' },
      pageElements: elementMap,
    };
    pageOrder.push(pageId);
  }

  return {
    id: `imported-${Date.now().toString(36)}`,
    title: fileName.replace(/\.pptx$/i, ''),
    pageSize,
    body: { pages, pageOrder },
  };
}

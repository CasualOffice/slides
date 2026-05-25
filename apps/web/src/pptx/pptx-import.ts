import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { IPageElement, ISlideData, ISlidePage, ISlideRichTextProps } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';

// pptx import — JSZip + fast-xml-parser → ISlideData.
//
// Wave-1 fidelity (this file): text runs preserve font size / bold /
// italic / underline / color; images extracted from ppt/media/ via
// rId lookups; shape geometry is still a rect fallback.
//
// Wave-2 (deferred):
//   • Multi-run rich text (currently we collapse all runs to the first
//     run's properties — works when a frame has one style throughout,
//     drops mid-text formatting changes)
//   • Theme color resolution (`<a:schemeClr val="accent1"/>` etc.)
//   • Layout / master inheritance (placeholders that get position +
//     font from a slideLayout instead of the slide itself)
//   • Shape geometry (`<a:prstGeom prst=…>` → ShapeType enum)
//   • Tables / charts / lines / groups
//
// Coordinate system: pptx OOXML uses EMU. 914_400 EMU = 1 inch,
// 9525 EMU = 1 px at 96 DPI. We invert the px2in used by the export side.

const EMU_PER_PIXEL = 9525;
const emu2px = (emu: number | string | undefined): number => {
  if (emu === undefined) return 0;
  const n = typeof emu === 'string' ? parseInt(emu, 10) : emu;
  return Number.isFinite(n) ? n / EMU_PER_PIXEL : 0;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: false,
  trimValues: false,
});

interface XmlNode { [key: string]: unknown; }

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

// Get a string out of a <a:t> node which can be either a bare string or
// an object whose '#text' field holds the actual content (fast-xml-parser
// shape varies with run nesting).
function readT(node: unknown): string {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object') {
    const t = (node as XmlNode)['#text'];
    if (typeof t === 'string') return t;
  }
  return '';
}

// Parse <a:rPr> attributes into ISlideRichTextProps-compatible fields.
// OOXML stores sizes in hundredths of points (sz="3000" → 30 pt → 40 px
// at 96 DPI). Univer's IStyleBase wants `fs` in pt.
//
// Color extraction handles `<a:solidFill><a:srgbClr val="HEX"/></>` —
// theme colors (`<a:schemeClr>`) are deferred until we read the theme.
function parseRunProps(rPr: unknown): Partial<ISlideRichTextProps> {
  if (!rPr || typeof rPr !== 'object') return {};
  const node = rPr as XmlNode;
  const out: Partial<ISlideRichTextProps> = {};

  // Font size — OOXML stores hundredths of point.
  const szRaw = node['@sz'];
  if (typeof szRaw === 'string' || typeof szRaw === 'number') {
    const sz = parseInt(String(szRaw), 10);
    if (Number.isFinite(sz)) out.fs = sz / 100;
  }

  const b = node['@b'];
  if (b === '1' || b === 1 || b === 'true') out.bl = 1;

  const i = node['@i'];
  if (i === '1' || i === 1 || i === 'true') out.it = 1;

  const u = node['@u'];
  if (typeof u === 'string' && u !== 'none') {
    // ITextDecoration shape — Univer accepts a truthy object. The minimum
    // is `{ s: 1 }` (single line); we pass that.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any).ul = { s: 1 };
  }

  // Color: <a:solidFill><a:srgbClr val="RRGGBB"/></a:solidFill>
  const solidFill = findChild(node, 'a:solidFill');
  const srgbClr = findChild(solidFill, 'a:srgbClr') as XmlNode | undefined;
  const valAttr = srgbClr?.['@val'];
  if (typeof valAttr === 'string' && /^[0-9a-fA-F]{6}$/.test(valAttr)) {
    out.cl = { rgb: `#${valAttr}` };
  }

  return out;
}

// Extract text + first-run formatting from a <p:txBody>.
//
// Wave-1 simplification: we use the FIRST run's formatting as the
// element-level style. Frames with consistent styling throughout (the
// vast majority of slides) survive intact. Mixed-format runs collapse
// to the first run's style and lose visible distinctions — tracked as
// Sprint 2 #6 (multi-run rich text).
function extractTextAndProps(txBody: unknown): { text: string; props: Partial<ISlideRichTextProps> } {
  const paragraphs = toArray(findChild(txBody, 'a:p'));
  const lines: string[] = [];
  let firstProps: Partial<ISlideRichTextProps> = {};
  let captured = false;

  for (const p of paragraphs) {
    const runs = toArray(findChild(p, 'a:r'));
    const inline: string[] = [];
    for (const r of runs) {
      const tNode = findChild(r, 'a:t');
      inline.push(readT(tNode));
      if (!captured) {
        const rPr = findChild(r, 'a:rPr');
        const parsed = parseRunProps(rPr);
        if (Object.keys(parsed).length > 0) {
          firstProps = parsed;
          captured = true;
        }
      }
    }
    lines.push(inline.join(''));
  }

  return { text: lines.join('\n'), props: firstProps };
}

interface ImageRegistry {
  /** rels for the active slide — rId → image part path inside the zip */
  imageRelMap: Map<string, string>;
  /** Cache of decoded base64 data URIs keyed by zip-path */
  cache: Map<string, string>;
  /** The zip we're reading bytes out of */
  zip: JSZip;
}

const MIME_FROM_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

async function readImageAsDataUri(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  const base64 = await entry.async('base64');
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME_FROM_EXT[ext] ?? 'image/png';
  return `data:${mime};base64,${base64}`;
}

// Process `<p:pic>` nodes from the spTree. Each has a `<p:blipFill><a:blip
// r:embed="rIdN"/>` referencing an image in ppt/media/* via the slide's
// rels file.
async function extractPicElements(
  pics: unknown[],
  reg: ImageRegistry,
  startZ: number,
): Promise<IPageElement[]> {
  const out: IPageElement[] = [];
  for (let i = 0; i < pics.length; i += 1) {
    const pic = pics[i];
    if (!pic || typeof pic !== 'object') continue;

    // Transform.
    const spPr = findChild(pic, 'p:spPr');
    const xfrm = findChild(spPr, 'a:xfrm');
    const off = findChild(xfrm, 'a:off') as XmlNode | undefined;
    const ext = findChild(xfrm, 'a:ext') as XmlNode | undefined;
    const left = emu2px(off?.['@x'] as string | undefined);
    const top = emu2px(off?.['@y'] as string | undefined);
    const width = emu2px(ext?.['@cx'] as string | undefined);
    const height = emu2px(ext?.['@cy'] as string | undefined);

    // <p:blipFill><a:blip r:embed="rIdN"/>
    const blipFill = findChild(pic, 'p:blipFill');
    const blip = findChild(blipFill, 'a:blip') as XmlNode | undefined;
    const rEmbed = blip?.['@r:embed'] as string | undefined;
    if (!rEmbed) continue;

    const relTarget = reg.imageRelMap.get(rEmbed);
    if (!relTarget) continue;
    // relTarget like '../media/image1.png' relative to ppt/slides/_rels.
    // Normalise to a zip-rooted path.
    const slidesRoot = 'ppt/slides/';
    const zipPath = relTarget.startsWith('/')
      ? relTarget.slice(1)
      : (relTarget.startsWith('..')
        ? `ppt/${relTarget.replace(/^\.\.\//, '')}`
        : `${slidesRoot}${relTarget}`);

    let dataUri = reg.cache.get(zipPath) ?? null;
    if (!dataUri) {
      dataUri = await readImageAsDataUri(reg.zip, zipPath);
      if (!dataUri) continue;
      reg.cache.set(zipPath, dataUri);
    }

    const id = `pic-${startZ + i}`;
    out.push({
      id,
      zIndex: startZ + i,
      left,
      top,
      width,
      height,
      title: '',
      description: '',
      type: PageElementType.IMAGE,
      image: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        imageProperties: { contentUrl: dataUri } as any,
      },
    });
  }
  return out;
}

async function extractElementsFromSlideXml(
  slideXml: string,
  reg: ImageRegistry,
  pageOrdinal: number,
): Promise<IPageElement[]> {
  const parsed = parser.parse(slideXml) as XmlNode;
  const spTree = findChild(findChild(findChild(parsed, 'p:sld'), 'p:cSld'), 'p:spTree');
  const shapes = toArray(findChild(spTree, 'p:sp'));
  const pics = toArray(findChild(spTree, 'p:pic'));

  const elements: IPageElement[] = [];
  let zIndex = 1;

  for (const sp of shapes) {
    if (!sp || typeof sp !== 'object') continue;
    const spPr = findChild(sp, 'p:spPr');
    const xfrm = findChild(spPr, 'a:xfrm');
    const off = findChild(xfrm, 'a:off') as XmlNode | undefined;
    const ext = findChild(xfrm, 'a:ext') as XmlNode | undefined;
    const left = emu2px(off?.['@x'] as string | undefined);
    const top = emu2px(off?.['@y'] as string | undefined);
    const width = emu2px(ext?.['@cx'] as string | undefined);
    const height = emu2px(ext?.['@cy'] as string | undefined);

    const txBody = findChild(sp, 'p:txBody');
    if (txBody) {
      const { text, props } = extractTextAndProps(txBody);
      // Per-page-unique id (otherwise el-1 collides across slides).
      const id = `s${pageOrdinal}-el-${zIndex}`;
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
        richText: { text, ...props } as ISlideRichTextProps,
      });
      zIndex += 1;
      continue;
    }

    if (spPr) {
      const id = `s${pageOrdinal}-shape-${zIndex}`;
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
          shapeType: 'rect' as never,
          text: '',
          shapeProperties: {
            shapeBackgroundFill: { rgb: 'rgb(255, 255, 255)' },
          },
        },
      });
      zIndex += 1;
    }
  }

  const picElements = await extractPicElements(pics, reg, zIndex);
  return elements.concat(picElements);
}

export async function importPptxToSlides(file: ArrayBuffer, fileName: string): Promise<ISlideData> {
  const zip = await JSZip.loadAsync(file);

  // 1. Deck-level: ppt/presentation.xml → slide size + slide ids.
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
  if (!presentationXml) {
    throw new Error('ppt/presentation.xml not found — not a valid pptx');
  }
  const presParsed = parser.parse(presentationXml) as XmlNode;
  const presentation = findChild(presParsed, 'p:presentation') as XmlNode | undefined;

  const sldSz = findChild(presentation, 'p:sldSz') as XmlNode | undefined;
  const pageSize = {
    width: emu2px((sldSz?.['@cx'] as string | undefined) ?? '9144000'),
    height: emu2px((sldSz?.['@cy'] as string | undefined) ?? '6858000'),
  };

  const sldIdLst = findChild(presentation, 'p:sldIdLst');
  const sldIds = toArray(findChild(sldIdLst, 'p:sldId'));

  // 2. Resolve slide rId → slide xml path via ppt/_rels/presentation.xml.rels.
  const presRelsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  const relMap = presRelsXml ? extractRelMap(presRelsXml) : new Map<string, string>();

  // 3. For each slide id, also load its own _rels/slideN.xml.rels so we can
  //    resolve image refs (r:embed="rIdN") into ppt/media/imageN.png paths.
  const pages: Record<string, ISlidePage> = {};
  const pageOrder: string[] = [];
  const imageCache = new Map<string, string>();

  for (let i = 0; i < sldIds.length; i += 1) {
    const sldId = sldIds[i] as XmlNode;
    const rId = sldId['@r:id'] as string | undefined;
    if (!rId) continue;
    const relTarget = relMap.get(rId);
    if (!relTarget) continue;
    const slidePath = relTarget.startsWith('/') ? relTarget.slice(1) : `ppt/${relTarget}`;
    const slideXml = await zip.file(slidePath)?.async('string');
    if (!slideXml) continue;

    // Slide's own rels file is at ppt/slides/_rels/slideN.xml.rels — the
    // slidePath's stem with `_rels/` and `.rels` suffix.
    const slideName = slidePath.split('/').pop() ?? '';
    const slideRelsPath = `ppt/slides/_rels/${slideName}.rels`;
    const slideRelsXml = await zip.file(slideRelsPath)?.async('string');
    const imageRelMap = slideRelsXml ? extractRelMap(slideRelsXml) : new Map<string, string>();

    const reg: ImageRegistry = { imageRelMap, cache: imageCache, zip };
    const pageOrdinal = i + 1;
    const pageId = `page-${pageOrdinal}`;
    const elements = await extractElementsFromSlideXml(slideXml, reg, pageOrdinal);
    const elementMap: Record<string, IPageElement> = {};
    for (const el of elements) elementMap[el.id] = el;

    pages[pageId] = {
      id: pageId,
      pageType: PageType.SLIDE,
      zIndex: pageOrdinal,
      title: `Slide ${pageOrdinal}`,
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

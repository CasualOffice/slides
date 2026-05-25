import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { IPageElement, ISlideData, ISlidePage, ISlideRichTextProps } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';

// pptx import — JSZip + fast-xml-parser → ISlideData.
//
// Wave-1 fidelity (this file): text runs preserve font size / bold /
// italic / underline / color; images extracted from ppt/media/ via
// rId lookups; shape geometry parsed from `<a:prstGeom prst=…>` with
// solid-fill + outline.
//
// Wave-2 (deferred):
//   • Multi-run rich text (currently we collapse all runs to the first
//     run's properties — works when a frame has one style throughout,
//     drops mid-text formatting changes)
//   • Theme color resolution (`<a:schemeClr val="accent1"/>` etc.)
//   • Layout / master inheritance (placeholders that get position +
//     font from a slideLayout instead of the slide itself)
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

// Find the first Relationship of a given Type (suffix-matched — OOXML
// uses long URI prefixes that vary between document and presentationML
// flavors, but the last path segment is stable). Returns Target string.
function findRelTargetByType(relsXml: string, typeSuffix: string): string | null {
  const parsed = parser.parse(relsXml) as XmlNode;
  const rels = findChild(parsed, 'Relationships');
  const rel = toArray(findChild(rels, 'Relationship'));
  for (const r of rel) {
    if (typeof r !== 'object' || !r) continue;
    const type = (r as XmlNode)['@Type'];
    const target = (r as XmlNode)['@Target'];
    if (typeof type === 'string' && typeof target === 'string' && type.endsWith(typeSuffix)) {
      return target;
    }
  }
  return null;
}

// Resolve a rels Target (which may be '../slideLayouts/slideLayout1.xml'
// or 'slides/slide1.xml' depending on the rels file's location) into a
// zip-rooted path. `baseDir` is the directory of the file that owns
// the rels (e.g. 'ppt/slides/' for slideN.xml.rels).
function resolveRelTarget(target: string, baseDir: string): string {
  if (target.startsWith('/')) return target.slice(1);
  // Normalise '../' walks.
  const parts = (baseDir + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p === '.' || p === '') continue;
    else out.push(p);
  }
  return out.join('/');
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

  // Font family (B3): <a:rPr><a:latin typeface="Calibri"/></a:rPr>.
  // <a:ea> and <a:cs> are deferred (B4) — currently we use the Latin
  // typeface as the canonical font; if a deck only declared `<a:ea>`,
  // it'd fall back to the renderer default. That covers > 95 % of
  // Western decks today.
  const latin = findChild(node, 'a:latin') as XmlNode | undefined;
  const typeface = latin?.['@typeface'];
  if (typeof typeface === 'string' && typeface.length > 0) {
    out.ff = typeface;
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
function extractTextAndProps(
  txBody: unknown,
  fallbackProps?: Partial<ISlideRichTextProps>,
): { text: string; props: Partial<ISlideRichTextProps> } {
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

  // I4 — when the slide's run carried no formatting of its own, fall
  // back to the placeholder's <a:lstStyle><a:lvl1pPr><a:defRPr> from
  // layout/master. Run-level rPr wins by field when both exist (we
  // spread fallback first, then the captured first-run props).
  const props: Partial<ISlideRichTextProps> = fallbackProps
    ? { ...fallbackProps, ...firstProps }
    : firstProps;

  return { text: lines.join('\n'), props };
}

// Read a `<… val="RRGGBB"/>` srgbClr child of a parent node, returning
// the css-style hex string or null when absent / not a srgbClr fill.
//
// OOXML's `<a:solidFill>` accepts several child kinds (srgbClr,
// schemeClr, prstClr, sysClr). Only srgbClr is round-trippable through
// `pnpm export` today — the others are deferred to theme resolution
// (wave 2).
function parseSrgbColor(parent: unknown): string | null {
  const solid = findChild(parent, 'a:solidFill');
  const srgb = findChild(solid, 'a:srgbClr') as XmlNode | undefined;
  const val = srgb?.['@val'];
  if (typeof val !== 'string' || !/^[0-9a-fA-F]{6}$/.test(val)) return null;
  return `#${val.toUpperCase()}`;
}

// Pull geometry + fill + outline out of <p:spPr>. Returns enough to
// reconstruct what PptxGenJS's addShape() emitted on export. Unknown
// prstGeom values fall back to 'rect' so we never drop a shape; the
// position / size / fill still survive.
function parseShapeAppearance(spPr: unknown): {
  shapeType: string;
  fillRgb: string | null;
  outlineRgb: string | null;
  outlineWeightPx: number | null;
} {
  const prstGeom = findChild(spPr, 'a:prstGeom') as XmlNode | undefined;
  const prstAttr = prstGeom?.['@prst'];
  const shapeType = typeof prstAttr === 'string' && prstAttr.length > 0 ? prstAttr : 'rect';

  const fillRgb = parseSrgbColor(spPr);

  let outlineRgb: string | null = null;
  let outlineWeightPx: number | null = null;
  const ln = findChild(spPr, 'a:ln') as XmlNode | undefined;
  if (ln) {
    outlineRgb = parseSrgbColor(ln);
    const w = ln['@w'];
    if (typeof w === 'string' || typeof w === 'number') {
      const emu = parseInt(String(w), 10);
      if (Number.isFinite(emu)) {
        // OOXML `<a:ln w>` is EMU. 9525 EMU = 1 px @ 96 DPI; PptxGenJS
        // accepts weight in points on export, so on import we want the
        // px-equivalent stored. The shape model's `weight` field is
        // unitless in Univer's type, but the export side uses it as
        // points — that's the surviving lossy bit. Accept that for now.
        outlineWeightPx = emu / EMU_PER_PIXEL;
      }
    }
  }

  return { shapeType, fillRgb, outlineRgb, outlineWeightPx };
}

// Placeholder geometry inherited from the slide layout / master (I3).
//
// A pptx slide may carry a `<p:sp>` whose `<p:nvSpPr><p:nvPr><p:ph
// type=… idx=…/>` marks it as a placeholder. PowerPoint's authoring
// convention is to omit `<a:xfrm>` from such placeholders and let the
// slideLayout (and ultimately the slideMaster) provide position+size.
// Without inheritance, those placeholders render at 0,0 / 0,0 — which
// is precisely why imported real-world decks looked like "only text,
// no properties, randomly placed at origin".
interface PlaceholderRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * Default first-level paragraph run properties from the layout/master
   * placeholder's `<a:lstStyle><a:lvl1pPr><a:defRPr>` — used when the
   * slide's run has no `<a:rPr>` of its own (I4).
   */
  defaultRunProps?: Partial<ISlideRichTextProps>;
}

// Compose a stable lookup key from `<p:ph type idx>`. Layout/master and
// slide use the same convention so the strings line up by construction.
//
// Edge cases:
// • Title placeholders use `type="title"` or `type="ctrTitle"` — idx
//   is usually absent.
// • Body content slots use `idx="N"` (1, 2, …) — type is often absent.
// • Header/footer date/slide-number placeholders use specific types.
//
// We key on `${type}|${idx}` with missing values as empty strings, so
// the same placeholder in slide / layout / master always resolves to
// the same string.
function placeholderKey(ph: XmlNode | undefined): string | null {
  if (!ph) return null;
  const type = ph['@type'];
  const idx = ph['@idx'];
  if (type === undefined && idx === undefined) {
    // Bare `<p:ph/>` — treat as idx="0" by OOXML convention.
    return '|0';
  }
  return `${type ?? ''}|${idx ?? ''}`;
}

function getPlaceholderKey(sp: unknown): string | null {
  const nvSpPr = findChild(sp, 'p:nvSpPr');
  const nvPr = findChild(nvSpPr, 'p:nvPr');
  const ph = findChild(nvPr, 'p:ph') as XmlNode | undefined;
  return placeholderKey(ph);
}

// Walk a <p:sldLayout> or <p:sldMaster> XML and collect every
// placeholder's xfrm into a key → rect map. Used as the inheritance
// source for slides that leave xfrm off their placeholders.
function extractPlaceholderRects(layoutOrMasterXml: string): Map<string, PlaceholderRect> {
  const parsed = parser.parse(layoutOrMasterXml) as XmlNode;
  const root =
    (findChild(parsed, 'p:sldLayout') as XmlNode | undefined) ??
    (findChild(parsed, 'p:sldMaster') as XmlNode | undefined);
  const map = new Map<string, PlaceholderRect>();
  if (!root) return map;
  const spTree = findChild(findChild(root, 'p:cSld'), 'p:spTree');
  for (const sp of toArray(findChild(spTree, 'p:sp'))) {
    if (!sp || typeof sp !== 'object') continue;
    const key = getPlaceholderKey(sp);
    if (!key) continue;
    const spPr = findChild(sp, 'p:spPr');
    const xfrm = findChild(spPr, 'a:xfrm');
    const off = xfrm ? (findChild(xfrm, 'a:off') as XmlNode | undefined) : undefined;
    const ext = xfrm ? (findChild(xfrm, 'a:ext') as XmlNode | undefined) : undefined;

    // I4 — default run properties live at
    // <p:txBody><a:lstStyle><a:lvl1pPr><a:defRPr ...>.
    // Use lvl1 as our canonical placeholder default; deeper levels
    // (a:lvl2pPr etc.) matter once bullets land in wave 6.
    let defaultRunProps: Partial<ISlideRichTextProps> | undefined;
    const txBody = findChild(sp, 'p:txBody');
    const lstStyle = findChild(txBody, 'a:lstStyle');
    const lvl1pPr = findChild(lstStyle, 'a:lvl1pPr');
    const defRPr = findChild(lvl1pPr, 'a:defRPr');
    if (defRPr) {
      const parsed = parseRunProps(defRPr);
      if (Object.keys(parsed).length > 0) defaultRunProps = parsed;
    }

    // Either an xfrm rect or text-style defaults is enough to be worth
    // recording — a placeholder with neither carries no inheritance.
    if (!off || !ext) {
      if (defaultRunProps) {
        map.set(key, {
          left: 0, top: 0, width: 0, height: 0,
          defaultRunProps,
        });
      }
      continue;
    }

    map.set(key, {
      left: emu2px(off['@x'] as string | undefined),
      top: emu2px(off['@y'] as string | undefined),
      width: emu2px(ext['@cx'] as string | undefined),
      height: emu2px(ext['@cy'] as string | undefined),
      defaultRunProps,
    });
  }
  return map;
}

// Resolve a slide's layout (then master) and merge their placeholder
// rects. Layout overrides master where both define the same key —
// that matches PowerPoint's inheritance order.
async function buildPlaceholderMap(
  slideRelsXml: string | null,
  zip: JSZip,
): Promise<Map<string, PlaceholderRect>> {
  if (!slideRelsXml) return new Map();
  // Slide's rels live at ppt/slides/_rels/slideN.xml.rels — base dir
  // for resolving Targets is ppt/slides/.
  const layoutTarget = findRelTargetByType(slideRelsXml, '/slideLayout');
  if (!layoutTarget) return new Map();
  const layoutPath = resolveRelTarget(layoutTarget, 'ppt/slides/');
  const layoutXml = await zip.file(layoutPath)?.async('string');
  if (!layoutXml) return new Map();

  // Layout's own rels for finding the master (and image refs the
  // layout itself might carry — out of scope today).
  const layoutDir = layoutPath.slice(0, layoutPath.lastIndexOf('/') + 1);
  const layoutName = layoutPath.split('/').pop() ?? '';
  const layoutRelsPath = `${layoutDir}_rels/${layoutName}.rels`;
  const layoutRelsXml = await zip.file(layoutRelsPath)?.async('string');

  let masterMap = new Map<string, PlaceholderRect>();
  if (layoutRelsXml) {
    const masterTarget = findRelTargetByType(layoutRelsXml, '/slideMaster');
    if (masterTarget) {
      const masterPath = resolveRelTarget(masterTarget, layoutDir);
      const masterXml = await zip.file(masterPath)?.async('string');
      if (masterXml) masterMap = extractPlaceholderRects(masterXml);
    }
  }

  const layoutMap = extractPlaceholderRects(layoutXml);
  // Master first, then layout overrides. Field-level merge: layout's
  // rect wins when present; for defaultRunProps, layout > master >
  // none — so a layout with xfrm but no lstStyle still picks up the
  // master's default font.
  const merged = new Map<string, PlaceholderRect>(masterMap);
  for (const [k, layoutEntry] of layoutMap) {
    const masterEntry = merged.get(k);
    if (!masterEntry) {
      merged.set(k, layoutEntry);
      continue;
    }
    merged.set(k, {
      left: layoutEntry.left || masterEntry.left,
      top: layoutEntry.top || masterEntry.top,
      width: layoutEntry.width || masterEntry.width,
      height: layoutEntry.height || masterEntry.height,
      defaultRunProps: {
        ...(masterEntry.defaultRunProps ?? {}),
        ...(layoutEntry.defaultRunProps ?? {}),
      },
    });
  }
  return merged;
}

interface ImageRegistry {
  /** rels for the active slide — rId → image part path inside the zip */
  imageRelMap: Map<string, string>;
  /** Cache of decoded base64 data URIs keyed by zip-path */
  cache: Map<string, string>;
  /** The zip we're reading bytes out of */
  zip: JSZip;
  /** Placeholder rects from this slide's layout + master (I3) */
  placeholderRects: Map<string, PlaceholderRect>;
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

// Group shape transform (F2). OOXML lets a `<p:grpSp>` apply its own
// `<a:xfrm>` with `<a:off>`/`<a:ext>` (parent rect on the slide) plus
// `<a:chOff>`/`<a:chExt>` (the local coordinate space of the group's
// children). When the two differ, children get scaled + offset.
//
// Returns the (scale, offset) you apply to each child's raw (x, y) to
// land it in slide coordinates:
//   slideX = off.x + (childX - chOff.x) * (ext.cx / chExt.cx)
//   slideY = off.y + (childY - chOff.y) * (ext.cy / chExt.cy)
//
// When the group has no xfrm we return the identity transform.
interface GroupXfrm {
  offX: number;
  offY: number;
  chOffX: number;
  chOffY: number;
  scaleX: number;
  scaleY: number;
}

const IDENTITY_XFRM: GroupXfrm = {
  offX: 0,
  offY: 0,
  chOffX: 0,
  chOffY: 0,
  scaleX: 1,
  scaleY: 1,
};

function readGroupXfrm(grpSpPr: unknown): GroupXfrm {
  const xfrm = findChild(grpSpPr, 'a:xfrm');
  if (!xfrm) return IDENTITY_XFRM;
  const off = findChild(xfrm, 'a:off') as XmlNode | undefined;
  const ext = findChild(xfrm, 'a:ext') as XmlNode | undefined;
  const chOff = findChild(xfrm, 'a:chOff') as XmlNode | undefined;
  const chExt = findChild(xfrm, 'a:chExt') as XmlNode | undefined;

  const offX = emu2px(off?.['@x'] as string | undefined);
  const offY = emu2px(off?.['@y'] as string | undefined);
  const extCx = emu2px(ext?.['@cx'] as string | undefined);
  const extCy = emu2px(ext?.['@cy'] as string | undefined);
  const chOffX = emu2px(chOff?.['@x'] as string | undefined);
  const chOffY = emu2px(chOff?.['@y'] as string | undefined);
  const chExtCx = emu2px(chExt?.['@cx'] as string | undefined);
  const chExtCy = emu2px(chExt?.['@cy'] as string | undefined);

  const scaleX = chExtCx > 0 ? extCx / chExtCx : 1;
  const scaleY = chExtCy > 0 ? extCy / chExtCy : 1;

  return { offX, offY, chOffX, chOffY, scaleX, scaleY };
}

function composeXfrm(outer: GroupXfrm, inner: GroupXfrm): GroupXfrm {
  // outer applied after inner. inner places the child in its own
  // coordinate space; outer then maps that into the slide space.
  return {
    offX: outer.offX + (inner.offX - outer.chOffX) * outer.scaleX,
    offY: outer.offY + (inner.offY - outer.chOffY) * outer.scaleY,
    chOffX: inner.chOffX,
    chOffY: inner.chOffY,
    scaleX: outer.scaleX * inner.scaleX,
    scaleY: outer.scaleY * inner.scaleY,
  };
}

function applyXfrm(g: GroupXfrm, x: number, y: number): { x: number; y: number } {
  return {
    x: g.offX + (x - g.chOffX) * g.scaleX,
    y: g.offY + (y - g.chOffY) * g.scaleY,
  };
}

// Counter mutable across the recursive descent so every element on a
// page gets a strictly increasing z-index — siblings render in tree
// order, just like PowerPoint paints them.
interface ZCounter {
  next: number;
}

// Recursively process a <p:spTree> (or nested <p:grpSp>) into
// IPageElements. `groupXfrm` is the accumulated group transform that
// maps from the current node's child-coordinate-space into slide space.
async function processSpTree(
  spTree: unknown,
  reg: ImageRegistry,
  pageOrdinal: number,
  groupXfrm: GroupXfrm,
  z: ZCounter,
  out: IPageElement[],
): Promise<void> {
  // <p:sp>
  for (const sp of toArray(findChild(spTree, 'p:sp'))) {
    if (!sp || typeof sp !== 'object') continue;
    const spPr = findChild(sp, 'p:spPr');
    const xfrm = findChild(spPr, 'a:xfrm');
    const off = findChild(xfrm, 'a:off') as XmlNode | undefined;
    const ext = findChild(xfrm, 'a:ext') as XmlNode | undefined;
    let rawLeft = emu2px(off?.['@x'] as string | undefined);
    let rawTop = emu2px(off?.['@y'] as string | undefined);
    let rawW = emu2px(ext?.['@cx'] as string | undefined);
    let rawH = emu2px(ext?.['@cy'] as string | undefined);

    // I3 + I4 — pull both geometry and default text style off the
    // matching layout/master placeholder when the slide leaves them
    // off. Without this, placeholders end up at (0, 0) sized (0, 0)
    // with default-rendered text — the dominant cause of "imported
    // decks look empty / unstyled".
    const phKey = getPlaceholderKey(sp);
    const phInherited = phKey ? reg.placeholderRects.get(phKey) : null;
    if (!xfrm && phInherited) {
      rawLeft = phInherited.left;
      rawTop = phInherited.top;
      rawW = phInherited.width;
      rawH = phInherited.height;
    }

    const { x: left, y: top } = applyXfrm(groupXfrm, rawLeft, rawTop);
    const width = rawW * groupXfrm.scaleX;
    const height = rawH * groupXfrm.scaleY;

    const zIndex = z.next;
    z.next += 1;

    const txBody = findChild(sp, 'p:txBody');
    if (txBody) {
      const { text, props } = extractTextAndProps(txBody, phInherited?.defaultRunProps);
      out.push({
        id: `s${pageOrdinal}-el-${zIndex}`,
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
      continue;
    }

    if (spPr) {
      const { shapeType, fillRgb, outlineRgb, outlineWeightPx } = parseShapeAppearance(spPr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shapeProperties: any = {};
      if (fillRgb) shapeProperties.shapeBackgroundFill = { rgb: fillRgb };
      if (outlineRgb || outlineWeightPx !== null) {
        shapeProperties.outline = {
          outlineFill: outlineRgb ? { rgb: outlineRgb } : undefined,
          weight: outlineWeightPx ?? 1,
        };
      }
      out.push({
        id: `s${pageOrdinal}-shape-${zIndex}`,
        zIndex,
        left,
        top,
        width,
        height,
        title: '',
        description: '',
        type: PageElementType.SHAPE,
        shape: { shapeType: shapeType as never, text: '', shapeProperties },
      });
    }
  }

  // <p:pic>
  for (const pic of toArray(findChild(spTree, 'p:pic'))) {
    if (!pic || typeof pic !== 'object') continue;
    const result = await processPicNode(pic, reg, groupXfrm, pageOrdinal, z);
    if (result) out.push(result);
  }

  // <p:grpSp> — recurse. Compose this group's xfrm with the inherited
  // group transform so nested groups stack correctly.
  for (const grp of toArray(findChild(spTree, 'p:grpSp'))) {
    if (!grp || typeof grp !== 'object') continue;
    const grpSpPr = findChild(grp, 'p:grpSpPr');
    const innerXfrm = readGroupXfrm(grpSpPr);
    const childXfrm = composeXfrm(groupXfrm, innerXfrm);
    // The group itself is structural — only its children produce
    // IPageElements. Univer has no native "group" page-element type in
    // the OSS model (Gap 3 candidate), so we flatten and let z-order
    // preserve the visual stack.
    await processSpTree(grp, reg, pageOrdinal, childXfrm, z, out);
  }
}

// Pic processing factored out of processSpTree so group recursion can
// reuse it. Returns the IPageElement (or null on missing media).
async function processPicNode(
  pic: unknown,
  reg: ImageRegistry,
  groupXfrm: GroupXfrm,
  pageOrdinal: number,
  z: ZCounter,
): Promise<IPageElement | null> {
  const spPr = findChild(pic, 'p:spPr');
  const xfrm = findChild(spPr, 'a:xfrm');
  const off = findChild(xfrm, 'a:off') as XmlNode | undefined;
  const ext = findChild(xfrm, 'a:ext') as XmlNode | undefined;
  const rawLeft = emu2px(off?.['@x'] as string | undefined);
  const rawTop = emu2px(off?.['@y'] as string | undefined);
  const rawW = emu2px(ext?.['@cx'] as string | undefined);
  const rawH = emu2px(ext?.['@cy'] as string | undefined);
  const { x: left, y: top } = applyXfrm(groupXfrm, rawLeft, rawTop);
  const width = rawW * groupXfrm.scaleX;
  const height = rawH * groupXfrm.scaleY;

  const blipFill = findChild(pic, 'p:blipFill');
  const blip = findChild(blipFill, 'a:blip') as XmlNode | undefined;
  const rEmbed = blip?.['@r:embed'] as string | undefined;
  if (!rEmbed) return null;
  const relTarget = reg.imageRelMap.get(rEmbed);
  if (!relTarget) return null;
  const slidesRoot = 'ppt/slides/';
  const zipPath = relTarget.startsWith('/')
    ? relTarget.slice(1)
    : (relTarget.startsWith('..')
      ? `ppt/${relTarget.replace(/^\.\.\//, '')}`
      : `${slidesRoot}${relTarget}`);

  let dataUri = reg.cache.get(zipPath) ?? null;
  if (!dataUri) {
    dataUri = await readImageAsDataUri(reg.zip, zipPath);
    if (!dataUri) return null;
    reg.cache.set(zipPath, dataUri);
  }

  const zIndex = z.next;
  z.next += 1;
  return {
    id: `s${pageOrdinal}-pic-${zIndex}`,
    zIndex,
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
  };
}

async function extractElementsFromSlideXml(
  slideXml: string,
  reg: ImageRegistry,
  pageOrdinal: number,
): Promise<IPageElement[]> {
  const parsed = parser.parse(slideXml) as XmlNode;
  const spTree = findChild(findChild(findChild(parsed, 'p:sld'), 'p:cSld'), 'p:spTree');
  const elements: IPageElement[] = [];
  const z: ZCounter = { next: 1 };
  await processSpTree(spTree, reg, pageOrdinal, IDENTITY_XFRM, z, elements);
  return elements;
}

// A2 — read `<p:cSld><p:bg>` for the slide background. Today we resolve
// `<p:bgPr><a:solidFill><a:srgbClr>` only; gradient (`<a:gradFill>`),
// picture (`<a:blipFill>`), and theme-referenced (`<p:bgRef>`)
// backgrounds are deferred to later waves (A3 / A4 / A5).
function extractSlideBackground(slideXml: string): string | null {
  const parsed = parser.parse(slideXml) as XmlNode;
  const cSld = findChild(findChild(parsed, 'p:sld'), 'p:cSld');
  const bg = findChild(cSld, 'p:bg');
  if (!bg) return null;
  const bgPr = findChild(bg, 'p:bgPr');
  if (!bgPr) return null;
  return parseSrgbColor(bgPr);
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
    const slideRelsXml = (await zip.file(slideRelsPath)?.async('string')) ?? null;
    const imageRelMap = slideRelsXml ? extractRelMap(slideRelsXml) : new Map<string, string>();
    const placeholderRects = await buildPlaceholderMap(slideRelsXml, zip);

    const reg: ImageRegistry = { imageRelMap, cache: imageCache, zip, placeholderRects };
    const pageOrdinal = i + 1;
    const pageId = `page-${pageOrdinal}`;
    const elements = await extractElementsFromSlideXml(slideXml, reg, pageOrdinal);
    const elementMap: Record<string, IPageElement> = {};
    for (const el of elements) elementMap[el.id] = el;

    // A2 — slide background. Theme- and layout-inherited backgrounds
    // are still TODO (A5 / I6); when this slide has no `<p:bg>` we
    // keep the historical white default.
    const slideBg = extractSlideBackground(slideXml);

    pages[pageId] = {
      id: pageId,
      pageType: PageType.SLIDE,
      zIndex: pageOrdinal,
      title: `Slide ${pageOrdinal}`,
      description: '',
      pageBackgroundFill: { rgb: slideBg ?? 'rgb(255, 255, 255)' },
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

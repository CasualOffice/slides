import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { IPageElement, ISlideData, ISlidePage, ISlideRichTextProps } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';
import type { IBullet, IDocumentData, IParagraph, ITextRun, IParagraphStyle } from '@univerjs/core';
import { BorderStyleTypes, HorizontalAlign, PresetListType } from '@univerjs/core';

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

// Theme color map (J2). PowerPoint's `<a:schemeClr val="…">` references
// resolve against `ppt/theme/themeN.xml`'s `<a:clrScheme>`. Map keys
// are the OOXML scheme color names plus PowerPoint's tx/bg aliases:
//   bg1 ↔ lt1   bg2 ↔ lt2   tx1 ↔ dk1   tx2 ↔ dk2
//   accent1..6, hlink, folHlink resolve directly.
//
// Modifiers (`<a:lumMod>`, `<a:lumOff>`, `<a:tint>`, `<a:shade>`) are
// intentionally NOT applied yet — they sit on top of the base scheme
// color to lighten/darken. Worth ~5 % more fidelity; deferred behind
// the rest of wave 5/6 since the base-colour fix already unlocks the
// majority of "title is invisible because text is white-on-white" cases.
type ThemeMap = Map<string, string>;

const SCHEME_ALIASES: Record<string, string> = {
  bg1: 'lt1',
  bg2: 'lt2',
  tx1: 'dk1',
  tx2: 'dk2',
};

function resolveSchemeName(name: string): string {
  return SCHEME_ALIASES[name] ?? name;
}

// Parse one `<a:clrScheme>` child like `<a:accent1><a:srgbClr val="…"/></a:accent1>`
// or `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>`. Returns
// the hex value or null on unparseable shapes.
function readClrSchemeChildColor(node: unknown): string | null {
  const srgb = findChild(node, 'a:srgbClr') as XmlNode | undefined;
  const srgbVal = srgb?.['@val'];
  if (typeof srgbVal === 'string' && /^[0-9a-fA-F]{6}$/.test(srgbVal)) {
    return srgbVal.toUpperCase();
  }
  // <a:sysClr lastClr="…"/> carries a baked hex equivalent.
  const sys = findChild(node, 'a:sysClr') as XmlNode | undefined;
  const sysLast = sys?.['@lastClr'];
  if (typeof sysLast === 'string' && /^[0-9a-fA-F]{6}$/.test(sysLast)) {
    return sysLast.toUpperCase();
  }
  return null;
}

function parseThemeColors(themeXml: string): ThemeMap {
  const map: ThemeMap = new Map();
  const parsed = parser.parse(themeXml) as XmlNode;
  const theme = findChild(parsed, 'a:theme');
  const themeElements = findChild(theme, 'a:themeElements');
  const clrScheme = findChild(themeElements, 'a:clrScheme') as XmlNode | undefined;
  if (!clrScheme) return map;

  // a:clrScheme's children are named by scheme slot (dk1, lt1, accent1, …)
  // — iterate the keys rather than reaching for known names.
  for (const key of Object.keys(clrScheme)) {
    if (key.startsWith('@')) continue; // skip attributes
    if (!key.startsWith('a:')) continue;
    const slotName = key.slice(2); // strip "a:" prefix
    if (slotName === 'extLst') continue;
    const hex = readClrSchemeChildColor(clrScheme[key]);
    if (hex) map.set(slotName, hex);
  }
  return map;
}

// Wave 5b — colour modifiers. OOXML lets you stack `<a:lumMod>`,
// `<a:lumOff>`, `<a:tint>`, `<a:shade>` (etc.) inside an srgbClr or
// schemeClr to lighten / darken the base. PowerPoint themes lean
// heavily on this: accent1 with `lumMod="60000" lumOff="40000"` is a
// common "lighter accent1" used for backgrounds. Without these the
// extracted hex is the dark base — bg shapes look wrong tone.
//
// Implemented modifiers (the 80 %):
//   lumMod val=N → L' = L * (N / 100000)
//   lumOff val=N → L' = L + (N / 100000), clamped 0..1
//   tint   val=N → blend toward white   by N / 100000
//   shade  val=N → blend toward black   by N / 100000
// Skipped: satMod, satOff, satTo, hueMod, hueOff, hueTo, alpha — rare,
// and partial support is worse than none (gives the impression we
// nailed it). Tracked as a follow-up if a deck surfaces issues.
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    default: h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(h + 1 / 3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1 / 3) * 255),
  ];
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

function applyColorModifiers(hex: string, colourNode: XmlNode | undefined): string {
  if (!colourNode) return hex;
  // Read children in document order so lumMod * lumOff composes
  // correctly. fast-xml-parser groups same-named children into arrays;
  // we walk the known modifier slots and apply each. Order between
  // *different* modifiers is the OOXML default (lumMod → lumOff →
  // tint/shade) — matches what PowerPoint emits in practice.
  let [r, g, b] = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  let [h, s, l] = rgbToHsl(r, g, b);

  const readPct = (key: string): number | null => {
    const node = findChild(colourNode, key) as XmlNode | undefined;
    const v = node?.['@val'];
    if (v === undefined) return null;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n / 100_000 : null;
  };

  const lumMod = readPct('a:lumMod');
  if (lumMod !== null) l = clamp01(l * lumMod);
  const lumOff = readPct('a:lumOff');
  if (lumOff !== null) l = clamp01(l + lumOff);

  if (lumMod !== null || lumOff !== null) {
    [r, g, b] = hslToRgb(h, s, l);
  }

  const tint = readPct('a:tint');
  if (tint !== null) {
    // Blend toward white by `tint`. PowerPoint's actual formula uses
    // luminance, but the linear-RGB approximation is visually
    // indistinguishable for the modifier ranges actually used.
    r = Math.round(r + (255 - r) * tint);
    g = Math.round(g + (255 - g) * tint);
    b = Math.round(b + (255 - b) * tint);
  }
  const shade = readPct('a:shade');
  if (shade !== null) {
    // Blend toward black.
    r = Math.round(r * (1 - shade));
    g = Math.round(g * (1 - shade));
    b = Math.round(b * (1 - shade));
  }

  const toHex = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Resolve a `<a:schemeClr val="accent1"/>` reference. Returns the hex
// (with leading "#") or null when unresolvable.
function resolveSchemeColor(node: unknown, theme: ThemeMap | null): string | null {
  if (!theme) return null;
  const schemeClr = findChild(node, 'a:schemeClr') as XmlNode | undefined;
  if (!schemeClr) return null;
  const raw = schemeClr['@val'];
  if (typeof raw !== 'string') return null;
  const resolved = theme.get(resolveSchemeName(raw));
  if (!resolved) return null;
  return applyColorModifiers(`#${resolved}`, schemeClr);
}

// Wave 7 — gradient fill fallback (D9 / A3). Univer's IColorStyle has no
// gradient slot, so when we encounter `<a:gradFill>` we degrade to the
// first colour stop in `<a:gsLst>` (sorted by `@pos`, ascending).
//
// Why first-stop: PowerPoint's "gradient down" presets typically run
// from accent → lighter-accent; the start is the more saturated /
// brand-faithful end. Picking middle / average tends to wash out the
// signal colour. First-stop is the best single-RGB approximation for
// "what colour did the author pick?" without a fork patch to widen
// IColorStyle.
function readGradFirstStop(parent: unknown, theme: ThemeMap | null): string | null {
  const grad = findChild(parent, 'a:gradFill');
  if (!grad) return null;
  const gsLst = findChild(grad, 'a:gsLst');
  const stops = toArray(findChild(gsLst, 'a:gs'));
  if (stops.length === 0) return null;
  const sorted = stops.slice().sort((a, b) => {
    const pa = parseInt(String((a as XmlNode)['@pos'] ?? '0'), 10);
    const pb = parseInt(String((b as XmlNode)['@pos'] ?? '0'), 10);
    return (Number.isFinite(pa) ? pa : 0) - (Number.isFinite(pb) ? pb : 0);
  });
  for (const stop of sorted) {
    // Each `<a:gs>` has the colour directly as a child (NOT wrapped
    // in `<a:solidFill>`). Try srgbClr first, then schemeClr.
    const srgb = findChild(stop, 'a:srgbClr') as XmlNode | undefined;
    const srgbVal = srgb?.['@val'];
    if (typeof srgbVal === 'string' && /^[0-9a-fA-F]{6}$/.test(srgbVal)) {
      return applyColorModifiers(`#${srgbVal.toUpperCase()}`, srgb);
    }
    const schemeClr = findChild(stop, 'a:schemeClr') as XmlNode | undefined;
    if (schemeClr && theme) {
      const raw = schemeClr['@val'];
      if (typeof raw === 'string') {
        const resolved = theme.get(resolveSchemeName(raw));
        if (resolved) return applyColorModifiers(`#${resolved}`, schemeClr);
      }
    }
  }
  return null;
}

// Combined "read any colour" — srgbClr first, schemeClr as fallback,
// then a degraded gradient first-stop. Caller passes the parent node
// that contains `<a:solidFill>` / `<a:gradFill>` / equivalent.
function readColor(parent: unknown, theme: ThemeMap | null): string | null {
  const solid = findChild(parent, 'a:solidFill');
  if (solid) {
    const srgb = findChild(solid, 'a:srgbClr') as XmlNode | undefined;
    const srgbVal = srgb?.['@val'];
    if (typeof srgbVal === 'string' && /^[0-9a-fA-F]{6}$/.test(srgbVal)) {
      return applyColorModifiers(`#${srgbVal.toUpperCase()}`, srgb);
    }
    const schemed = resolveSchemeColor(solid, theme);
    if (schemed) return schemed;
  }
  // Degraded gradient → first-stop solid. Better than dropping the fill.
  return readGradFirstStop(parent, theme);
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
function parseRunProps(rPr: unknown, theme: ThemeMap | null = null): Partial<ISlideRichTextProps> {
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

  // Color: <a:solidFill><a:srgbClr val="…"/></a:solidFill> or
  // <a:solidFill><a:schemeClr val="accent1"/></a:solidFill> resolved
  // via the theme color scheme (J2).
  const colour = readColor(node, theme);
  if (colour) out.cl = { rgb: colour };

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
// Map `<a:pPr algn>` (l / ctr / r / just / dist) → Univer's
// HorizontalAlign enum. Undefined / 'l' fall through to LEFT (the
// default), null means "no override".
function parseParagraphAlign(pPr: unknown): HorizontalAlign | null {
  const node = pPr as XmlNode | undefined;
  const raw = node?.['@algn'];
  if (typeof raw !== 'string') return null;
  switch (raw) {
    case 'ctr': return HorizontalAlign.CENTER;
    case 'r': return HorizontalAlign.RIGHT;
    case 'just': return HorizontalAlign.JUSTIFIED;
    case 'dist': return HorizontalAlign.DISTRIBUTED;
    case 'l': return HorizontalAlign.LEFT;
    default: return null;
  }
}

// Wave 6b — bullet info from `<a:pPr>`. PowerPoint expresses bullet
// behaviour with one of three sibling children of `<a:pPr>`:
//   <a:buChar char="•"/>          → unordered bullet w/ custom char
//   <a:buAutoNum type="arabicPeriod"/> → ordered list, 1. 2. 3. …
//   <a:buNone/>                   → explicitly NO bullet (override)
//
// Returns null when there's no explicit bullet directive on this
// paragraph (the bullet inherits from layout/master defaults — same
// list-style cascade as run properties; full inheritance is layered
// in via I4 today, just for text-style not bullets — bullet
// inheritance is a wave-6c follow-up).
//
// Univer's IBullet asks for a listType (PresetListType), a listId
// (used to share numbering across paragraphs), nestingLevel, and a
// textStyle for the bullet glyph. We synth a listId per element so
// numbering restarts at the start of every text frame — matches
// PowerPoint's per-frame numbering scope.
function parseBullet(pPr: unknown, listIdSeed: string, level: number): IBullet | null {
  if (!pPr || typeof pPr !== 'object') return null;
  const node = pPr as XmlNode;
  if (findChild(node, 'a:buNone') !== undefined) {
    // Explicit "no bullet" — caller treats null as "no override", so
    // we distinguish via a sentinel `none` flag. Today bullet
    // inheritance isn't implemented anyway, so null is functionally
    // equivalent for now.
    return null;
  }
  const buChar = findChild(node, 'a:buChar') as XmlNode | undefined;
  if (buChar) {
    // For unordered lists Univer's preset family `BULLET_LIST_n`
    // matches the visual treatment at each nesting level; the actual
    // glyph isn't read from `@char` today (Univer's bullet renderer
    // uses its own glyph set). Recording the listType is what makes
    // the indent + glyph appear.
    return { listType: PresetListType.BULLET_LIST, listId: `${listIdSeed}-bul`, nestingLevel: level };
  }
  const buAutoNum = findChild(node, 'a:buAutoNum') as XmlNode | undefined;
  if (buAutoNum) {
    return { listType: PresetListType.ORDER_LIST, listId: `${listIdSeed}-ord`, nestingLevel: level };
  }
  return null;
}

// Wave 7 — paragraph space-before / space-after (C5). Same shape as
// lnSpc: either `<a:spcPct val=…>` (percent * 1000) or
// `<a:spcPts val=…>` (100ths of a point). Univer's `spaceAbove` /
// `spaceBelow` are `INumberUnit { v, u? }` — we set just `v` and let
// the renderer use its default unit.
function parseSpacePts(holder: unknown): number | null {
  if (!holder) return null;
  const pts = findChild(holder, 'a:spcPts') as XmlNode | undefined;
  const ptsVal = pts?.['@val'];
  if (ptsVal !== undefined) {
    const n = parseInt(String(ptsVal), 10);
    if (Number.isFinite(n)) return n / 100;
  }
  const pct = findChild(holder, 'a:spcPct') as XmlNode | undefined;
  const pctVal = pct?.['@val'];
  if (pctVal !== undefined) {
    const n = parseInt(String(pctVal), 10);
    // Express as a multiplier; renderer treats values < 10 as multipliers
    // (same convention as lineSpacing).
    if (Number.isFinite(n)) return n / 100_000;
  }
  return null;
}

// Parse `<a:lnSpc>` → line spacing multiplier OR absolute pt value.
// PowerPoint stores it as either:
//   <a:lnSpc><a:spcPct val="100000"/></a:lnSpc>  → percent * 1000 (100% = 1.0)
//   <a:lnSpc><a:spcPts val="2400"/></a:lnSpc>    → 100ths-of-a-point (24pt)
// Univer's `lineSpacing` is a unitless number — values < 10 read as
// multipliers, >= 10 as point values. We follow that convention.
function parseLineSpacing(pPr: unknown): number | null {
  const lnSpc = findChild(pPr, 'a:lnSpc');
  if (!lnSpc) return null;
  const pct = findChild(lnSpc, 'a:spcPct') as XmlNode | undefined;
  const pctVal = pct?.['@val'];
  if (pctVal !== undefined) {
    const n = parseInt(String(pctVal), 10);
    if (Number.isFinite(n)) return n / 100_000; // 100000 → 1.0
  }
  const pts = findChild(lnSpc, 'a:spcPts') as XmlNode | undefined;
  const ptsVal = pts?.['@val'];
  if (ptsVal !== undefined) {
    const n = parseInt(String(ptsVal), 10);
    if (Number.isFinite(n)) return n / 100; // 100ths-of-a-pt → pt
  }
  return null;
}

// Parse `<a:pPr>` indent attributes. OOXML stores them in EMU (or
// hundredths-of-a-point in some legacy schemas — sticking to EMU
// here). marL = left margin of the paragraph; indent = first-line
// indent relative to marL. Univer wants px / pt — convert via 9525
// EMU/px @ 96 DPI.
function parseIndent(pPr: unknown): { indentStart?: number; indentFirstLine?: number } {
  const node = pPr as XmlNode | undefined;
  const out: { indentStart?: number; indentFirstLine?: number } = {};
  const marL = node?.['@marL'];
  if (marL !== undefined) {
    const n = parseInt(String(marL), 10);
    if (Number.isFinite(n) && n !== 0) out.indentStart = n / EMU_PER_PIXEL;
  }
  const indent = node?.['@indent'];
  if (indent !== undefined) {
    const n = parseInt(String(indent), 10);
    if (Number.isFinite(n) && n !== 0) out.indentFirstLine = n / EMU_PER_PIXEL;
  }
  return out;
}

// Bullet nesting level from `<a:pPr lvl="0..8">`. Defaults to 0.
function parseLevel(pPr: unknown): number {
  const node = pPr as XmlNode | undefined;
  const lvl = node?.['@lvl'];
  if (lvl === undefined) return 0;
  const n = parseInt(String(lvl), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(8, n)) : 0;
}

// Wave 6 — extract a full `IDocumentData` body from a `<p:txBody>`.
// Each `<a:r>` becomes one `ITextRun` carrying its own style; each
// `<a:p>` becomes one `IParagraph` with its `<a:pPr>` alignment. The
// fallbackProps (from layout/master placeholder lstStyle defRPr —
// I4) is spread under every run as the inherited default.
//
// Compat: we still return a `text` string + element-level `props` (from
// the first run + fallback) so callers that look at `richText.text` /
// `richText.fs` etc. keep working — the rich body is the source of
// truth when present, the flat fields a fallback for older paths
// (notably PptxGenJS export which reads from the flat fields).
//
// Univer's IDocumentBody requires:
//   • dataStream ends with `\r\n` (\r = paragraph break, \n = section)
//   • paragraphs[i].startIndex = index of the `\r` that ends paragraph i
//   • textRuns[i] = { st, ed, ts } where st inclusive, ed exclusive
function extractRichDoc(
  txBody: unknown,
  elementId: string,
  fallbackProps?: Partial<ISlideRichTextProps>,
  theme: ThemeMap | null = null,
): {
  text: string;
  props: Partial<ISlideRichTextProps>;
  rich: IDocumentData | null;
} {
  const paras = toArray(findChild(txBody, 'a:p'));
  if (paras.length === 0) {
    return { text: '', props: fallbackProps ?? {}, rich: null };
  }

  const dataStream: string[] = [];
  const textRuns: ITextRun[] = [];
  const paragraphs: IParagraph[] = [];
  const lines: string[] = [];
  let cursor = 0;
  let firstRunProps: Partial<ISlideRichTextProps> = {};
  let capturedFirstRun = false;

  for (const p of paras) {
    const runs = toArray(findChild(p, 'a:r'));
    const paraText: string[] = [];

    for (const r of runs) {
      const tNode = findChild(r, 'a:t');
      const txt = readT(tNode);
      paraText.push(txt);

      // Build the run's style: layout/master defaults < layout pPr
      // defaults < this run's rPr.
      const rPr = findChild(r, 'a:rPr');
      const runStyle = parseRunProps(rPr, theme);
      const ts = { ...(fallbackProps ?? {}), ...runStyle };

      if (txt.length > 0) {
        textRuns.push({ st: cursor, ed: cursor + txt.length, ts });
      }
      cursor += txt.length;

      if (!capturedFirstRun && Object.keys(runStyle).length > 0) {
        firstRunProps = runStyle;
        capturedFirstRun = true;
      }
    }

    // Paragraph-level (C2 + C3 + C4 + C5 + C6 + C7 + C8).
    const pPr = findChild(p, 'a:pPr');
    const align = parseParagraphAlign(pPr);
    const lineSpacing = parseLineSpacing(pPr);
    const { indentStart, indentFirstLine } = parseIndent(pPr);
    const level = parseLevel(pPr);
    const bullet = parseBullet(pPr, elementId, level);
    const spaceAbove = parseSpacePts(findChild(pPr, 'a:spcBef'));
    const spaceBelow = parseSpacePts(findChild(pPr, 'a:spcAft'));

    const paragraphStyle: IParagraphStyle = {};
    if (align !== null) paragraphStyle.horizontalAlign = align;
    if (lineSpacing !== null) paragraphStyle.lineSpacing = lineSpacing;
    if (indentStart !== undefined) paragraphStyle.indentStart = { v: indentStart };
    if (indentFirstLine !== undefined) paragraphStyle.indentFirstLine = { v: indentFirstLine };
    if (spaceAbove !== null) paragraphStyle.spaceAbove = { v: spaceAbove };
    if (spaceBelow !== null) paragraphStyle.spaceBelow = { v: spaceBelow };

    const paragraph: IParagraph = { startIndex: cursor };
    if (Object.keys(paragraphStyle).length > 0) paragraph.paragraphStyle = paragraphStyle;
    if (bullet) paragraph.bullet = bullet;
    paragraphs.push(paragraph);
    dataStream.push(...paraText, '\r');
    cursor += 1;
    lines.push(paraText.join(''));
  }

  // Univer convention: the section-final `\n` sits past the last \r.
  dataStream.push('\n');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rich: IDocumentData = {
    id: `${elementId}-doc`,
    body: { dataStream: dataStream.join(''), textRuns, paragraphs },
    documentStyle: {},
  } as any;

  // Flat fallback fields = layout/master defaults spread under first
  // run's overrides. Run-level wins by field.
  const props: Partial<ISlideRichTextProps> = fallbackProps
    ? { ...fallbackProps, ...firstRunProps }
    : firstRunProps;

  return { text: lines.join('\n'), props, rich };
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
// Wave 7 — OOXML `<a:prstDash val=…>` → Univer's BorderStyleTypes.
// PowerPoint's dash presets are richer than Univer's border enum; map
// to the closest available value. `solid` and unknown values fall
// through to THIN (the conventional "plain stroke").
function parsePrstDash(ln: unknown): BorderStyleTypes | null {
  const node = findChild(ln, 'a:prstDash') as XmlNode | undefined;
  const val = node?.['@val'];
  if (typeof val !== 'string') return null;
  switch (val) {
    case 'dot':
    case 'sysDot':
      return BorderStyleTypes.DOTTED;
    case 'dash':
    case 'sysDash':
      return BorderStyleTypes.DASHED;
    case 'lgDash':
      return BorderStyleTypes.MEDIUM_DASHED;
    case 'dashDot':
    case 'sysDashDot':
      return BorderStyleTypes.DASH_DOT;
    case 'lgDashDot':
      return BorderStyleTypes.MEDIUM_DASH_DOT;
    case 'lgDashDotDot':
    case 'sysDashDotDot':
      return BorderStyleTypes.MEDIUM_DASH_DOT_DOT;
    case 'solid':
      return BorderStyleTypes.THIN;
    default:
      return null;
  }
}

function parseShapeAppearance(spPr: unknown, theme: ThemeMap | null = null): {
  shapeType: string;
  fillRgb: string | null;
  outlineRgb: string | null;
  outlineWeightPx: number | null;
  outlineDash: BorderStyleTypes | null;
} {
  const prstGeom = findChild(spPr, 'a:prstGeom') as XmlNode | undefined;
  const prstAttr = prstGeom?.['@prst'];
  const shapeType = typeof prstAttr === 'string' && prstAttr.length > 0 ? prstAttr : 'rect';

  const fillRgb = readColor(spPr, theme) ?? parseSrgbColor(spPr);

  let outlineRgb: string | null = null;
  let outlineWeightPx: number | null = null;
  let outlineDash: BorderStyleTypes | null = null;
  const ln = findChild(spPr, 'a:ln') as XmlNode | undefined;
  if (ln) {
    outlineRgb = readColor(ln, theme) ?? parseSrgbColor(ln);
    outlineDash = parsePrstDash(ln);
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

  return { shapeType, fillRgb, outlineRgb, outlineWeightPx, outlineDash };
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
function extractPlaceholderRects(layoutOrMasterXml: string, theme: ThemeMap | null = null): Map<string, PlaceholderRect> {
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
      const parsed = parseRunProps(defRPr, theme);
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

// Walk slide → layout → master → theme, returning the parsed theme
// color map (or null when the chain breaks). The `cache` argument
// memoises by master path so multi-slide decks don't re-parse the
// theme on every slide.
async function resolveThemeForSlide(
  slideRelsXml: string | null,
  zip: JSZip,
  cache: Map<string, ThemeMap | null>,
): Promise<ThemeMap | null> {
  if (!slideRelsXml) return null;
  const layoutTarget = findRelTargetByType(slideRelsXml, '/slideLayout');
  if (!layoutTarget) return null;
  const layoutPath = resolveRelTarget(layoutTarget, 'ppt/slides/');
  const layoutDir = layoutPath.slice(0, layoutPath.lastIndexOf('/') + 1);
  const layoutName = layoutPath.split('/').pop() ?? '';
  const layoutRelsXml = await zip.file(`${layoutDir}_rels/${layoutName}.rels`)?.async('string');
  if (!layoutRelsXml) return null;
  const masterTarget = findRelTargetByType(layoutRelsXml, '/slideMaster');
  if (!masterTarget) return null;
  const masterPath = resolveRelTarget(masterTarget, layoutDir);
  if (cache.has(masterPath)) return cache.get(masterPath) ?? null;
  const masterDir = masterPath.slice(0, masterPath.lastIndexOf('/') + 1);
  const masterName = masterPath.split('/').pop() ?? '';
  const masterRelsXml = await zip.file(`${masterDir}_rels/${masterName}.rels`)?.async('string');
  if (!masterRelsXml) {
    cache.set(masterPath, null);
    return null;
  }
  const themeTarget = findRelTargetByType(masterRelsXml, '/theme');
  if (!themeTarget) {
    cache.set(masterPath, null);
    return null;
  }
  const themePath = resolveRelTarget(themeTarget, masterDir);
  const themeXml = await zip.file(themePath)?.async('string');
  const theme = themeXml ? parseThemeColors(themeXml) : null;
  cache.set(masterPath, theme);
  return theme;
}

// Resolve a slide's layout (then master) and merge their placeholder
// rects. Layout overrides master where both define the same key —
// that matches PowerPoint's inheritance order.
async function buildPlaceholderMap(
  slideRelsXml: string | null,
  zip: JSZip,
  theme: ThemeMap | null,
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
      if (masterXml) masterMap = extractPlaceholderRects(masterXml, theme);
    }
  }

  const layoutMap = extractPlaceholderRects(layoutXml, theme);
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
  /** Theme color scheme from `ppt/theme/themeN.xml` (J2) */
  theme: ThemeMap | null;
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

// D3 / D4 / E7 — read rotation + horizontal/vertical flip off an
// <a:xfrm>. OOXML's `@rot` is 60000ths-of-a-degree; Univer's
// `IPageElement.angle` is degrees. `@flipH="1"` and `@flipV="1"` map
// to `.flipX` / `.flipY` booleans.
function readXfrmExtras(xfrm: unknown): { angle: number; flipX: boolean; flipY: boolean } {
  if (!xfrm || typeof xfrm !== 'object') return { angle: 0, flipX: false, flipY: false };
  const node = xfrm as XmlNode;
  let angle = 0;
  const rotRaw = node['@rot'];
  if (typeof rotRaw === 'string' || typeof rotRaw === 'number') {
    const r = parseInt(String(rotRaw), 10);
    if (Number.isFinite(r)) angle = r / 60_000;
  }
  const fH = node['@flipH'];
  const fV = node['@flipV'];
  return {
    angle,
    flipX: fH === '1' || fH === 1 || fH === 'true',
    flipY: fV === '1' || fV === 1 || fV === 'true',
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
    const { angle, flipX, flipY } = readXfrmExtras(xfrm);

    const zIndex = z.next;
    z.next += 1;

    const txBody = findChild(sp, 'p:txBody');
    if (txBody) {
      const elId = `s${pageOrdinal}-el-${zIndex}`;
      const { text, props, rich } = extractRichDoc(
        txBody,
        elId,
        phInherited?.defaultRunProps,
        reg.theme,
      );
      const richText: ISlideRichTextProps = {
        text,
        ...props,
        ...(rich ? { rich } : {}),
      } as ISlideRichTextProps;
      out.push({
        id: elId,
        zIndex,
        left,
        top,
        width,
        height,
        angle,
        flipX,
        flipY,
        title: '',
        description: '',
        type: PageElementType.TEXT,
        richText,
      });
      continue;
    }

    if (spPr) {
      const { shapeType, fillRgb, outlineRgb, outlineWeightPx, outlineDash } = parseShapeAppearance(spPr, reg.theme);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shapeProperties: any = {};
      if (fillRgb) shapeProperties.shapeBackgroundFill = { rgb: fillRgb };
      if (outlineRgb || outlineWeightPx !== null || outlineDash !== null) {
        shapeProperties.outline = {
          outlineFill: outlineRgb ? { rgb: outlineRgb } : undefined,
          weight: outlineWeightPx ?? 1,
          ...(outlineDash !== null ? { dashStyle: outlineDash } : {}),
        };
      }
      out.push({
        id: `s${pageOrdinal}-shape-${zIndex}`,
        zIndex,
        left,
        top,
        width,
        height,
        angle,
        flipX,
        flipY,
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
  const { angle, flipX, flipY } = readXfrmExtras(xfrm);

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
    angle,
    flipX,
    flipY,
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

// A2 — read `<p:cSld><p:bg>` for the slide background. Resolves both
// `<p:bgPr><a:solidFill><a:srgbClr>` and `<p:bgPr><a:solidFill><a:schemeClr>`
// (J2) — the latter via the theme map. Gradient (`<a:gradFill>`),
// picture (`<a:blipFill>`), and `<p:bgRef>` (theme background indexes)
// are deferred to later waves (A3 / A4 / A5-ref).
function extractSlideBackground(slideXml: string, theme: ThemeMap | null): string | null {
  const parsed = parser.parse(slideXml) as XmlNode;
  const cSld = findChild(findChild(parsed, 'p:sld'), 'p:cSld');
  const bg = findChild(cSld, 'p:bg');
  if (!bg) return null;
  const bgPr = findChild(bg, 'p:bgPr');
  if (!bgPr) return null;
  return readColor(bgPr, theme) ?? parseSrgbColor(bgPr);
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
  const themeCache = new Map<string, ThemeMap | null>();

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

    // Resolve theme BEFORE the placeholder map so layout/master
    // `<a:lstStyle><a:lvl1pPr><a:defRPr>` entries that use scheme
    // colours (the common case in modern themes) resolve to real hex
    // values when we capture the inherited defaults. Theme (J2) walks
    // slide → layout → master → theme; cached by master path so
    // multi-slide decks don't re-parse it on every slide.
    const theme = await resolveThemeForSlide(slideRelsXml, zip, themeCache);
    const placeholderRects = await buildPlaceholderMap(slideRelsXml, zip, theme);

    const reg: ImageRegistry = { imageRelMap, cache: imageCache, zip, placeholderRects, theme };
    const pageOrdinal = i + 1;
    const pageId = `page-${pageOrdinal}`;
    const elements = await extractElementsFromSlideXml(slideXml, reg, pageOrdinal);
    const elementMap: Record<string, IPageElement> = {};
    for (const el of elements) elementMap[el.id] = el;

    // A2 — slide background. Theme- and layout-inherited backgrounds
    // are still TODO (A5 / I6); when this slide has no `<p:bg>` we
    // keep the historical white default.
    const slideBg = extractSlideBackground(slideXml, theme);

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

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { IPageElement, ISlideData, ISlidePage, ISlideRichTextProps } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';
import type { IBullet, ICustomRange, IDocumentData, IDocumentStyle, IParagraph, ITextRun, IParagraphStyle } from '@univerjs/core';
import { BaselineOffset, BorderStyleTypes, CustomRangeType, HorizontalAlign, PresetListType, TextDirection, VerticalAlign, WrapStrategy } from '@univerjs/core';

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

// Casual Slides — order-preserving parser used ONLY to recover the
// source DOM order of `<p:spTree>` children. Regular fast-xml-parser
// groups same-tag children into arrays but LOSES cross-tag order, which
// caused z-stacking bugs (text frames painting BELOW images that should
// have been beneath them per the source XML order).
const orderedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: false,
  trimValues: false,
  preserveOrder: true,
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
//
// J3 — the theme also carries `<a:fontScheme>` with `<a:majorFont>` and
// `<a:minorFont>` Latin typefaces. They flow through the same map under
// reserved keys (`__majorLatin` / `__minorLatin`) — the color-scheme
// names never collide with the double-underscore prefix, so a single
// Map keeps the threading lightweight.
type ThemeMap = Map<string, string>;

const FONT_MAJOR_KEY = '__majorLatin';
const FONT_MINOR_KEY = '__minorLatin';

// A5-idx — cache of theme's <a:fmtScheme><a:bgFillStyleLst> entries
// keyed by ThemeMap identity. Stored as parsed XmlNode arrays so the
// existing readColor / readGradFirstStop helpers can decode each entry
// (which may itself be a solidFill / gradFill / blipFill) on demand.
//
// We attach via a parallel WeakMap rather than serialising entries into
// the ThemeMap to avoid round-tripping XML through fast-xml-parser's
// string format.
const themeFmtSchemeCache = new WeakMap<ThemeMap, { bgFillStyleLst: XmlNode[]; fillStyleLst: XmlNode[] }>();

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
  if (clrScheme) {
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
  }

  // A5-idx — capture <a:fmtScheme><a:bgFillStyleLst> + <a:fillStyleLst>
  // entries so `<p:bgRef idx="N">` resolution can recover the actual
  // fill (which may be solidFill / gradFill / blipFill / pattFill).
  // Per OOXML §20.1.4.1.5 the indexes are:
  //   1000      → fillStyleLst entry 1 (subtle)
  //   1001-1003 → bgFillStyleLst entries 1..3 (subtle / moderate / intense)
  //   1-999     → fillStyleLst entry idx (lookup by 1-based offset)
  // Real-world templates almost always use the bgFillStyleLst range; we
  // populate both lists so a fallback lookup is available.
  const fmtScheme = findChild(themeElements, 'a:fmtScheme') as XmlNode | undefined;
  if (fmtScheme) {
    const bgFillStyleLst = findChild(fmtScheme, 'a:bgFillStyleLst');
    const fillStyleLst = findChild(fmtScheme, 'a:fillStyleLst');
    const collectStyleEntries = (lst: unknown): XmlNode[] => {
      if (!lst || typeof lst !== 'object') return [];
      const out: XmlNode[] = [];
      // bgFillStyleLst children are a mix of <a:solidFill>, <a:gradFill>,
      // <a:blipFill>, <a:noFill>, <a:pattFill> — keep them in document
      // order so idx=1001 maps to the first child regardless of type.
      // fast-xml-parser groups same-named children into arrays; iterate
      // by tag name then flatten.
      const node = lst as XmlNode;
      // The order matters but the parser separates children by tag; we
      // re-derive document order by scanning the keys (fast-xml-parser
      // preserves insertion order on regular objects in V8).
      for (const key of Object.keys(node)) {
        if (key.startsWith('@')) continue;
        // Skip whitespace text nodes
        if (key === '#text') continue;
        for (const child of toArray(node[key])) {
          if (child && typeof child === 'object') {
            // Wrap each child under its tag so downstream helpers can
            // re-discover the type (a:solidFill vs a:gradFill).
            out.push({ [key]: child } as XmlNode);
          }
        }
      }
      return out;
    };
    const bgEntries = collectStyleEntries(bgFillStyleLst);
    const fillEntries = collectStyleEntries(fillStyleLst);
    if (bgEntries.length > 0 || fillEntries.length > 0) {
      themeFmtSchemeCache.set(map, { bgFillStyleLst: bgEntries, fillStyleLst: fillEntries });
    }
  }

  // J3 — `<a:fontScheme>` carries the deck-wide major (heading) and minor
  // (body) typefaces. We harvest the Latin entry from each since Univer's
  // single `IStyleBase.ff` slot stores a single font-family string — the
  // East-Asian / complex-script subfonts (`<a:ea>`, `<a:cs>`) are
  // followed by the parseRunProps fallback chain already (B4).
  const fontScheme = findChild(themeElements, 'a:fontScheme') as XmlNode | undefined;
  if (fontScheme) {
    const majorFont = findChild(fontScheme, 'a:majorFont') as XmlNode | undefined;
    const majorLatin = findChild(majorFont, 'a:latin') as XmlNode | undefined;
    const majorTypeface = majorLatin?.['@typeface'];
    if (typeof majorTypeface === 'string' && majorTypeface.length > 0) {
      map.set(FONT_MAJOR_KEY, majorTypeface);
    }
    const minorFont = findChild(fontScheme, 'a:minorFont') as XmlNode | undefined;
    const minorLatin = findChild(minorFont, 'a:latin') as XmlNode | undefined;
    const minorTypeface = minorLatin?.['@typeface'];
    if (typeof minorTypeface === 'string' && minorTypeface.length > 0) {
      map.set(FONT_MINOR_KEY, minorTypeface);
    }
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

// A3 / D9 — harvest the full gradient stop list so the renderer can
// actually paint the gradient (rather than rely on the first-stop
// degradation). The model field is a structured payload that rides on
// shapeProperties / pageBackgroundFill alongside the degraded hex.
//
// Stops are sorted by `@pos` (ascending) and each stop carries:
//   • pos — normalised position (0..1)
//   • color — resolved hex with applied lum/lumOff/tint/shade modifiers
// The wrapper carries the gradient flavour:
//   • kind — 'linear' | 'radial' | 'path'
//   • angle — for linear, the OOXML `@ang` in degrees (60000ths → deg)
//     after a 90° flip so it matches CSS conventions (0° = right).
//
// Returns null when no gradient is present or no stops resolve.
export interface IGradientStop {
  pos: number;
  color: string;
}
export interface IGradientFill {
  kind: 'linear' | 'radial' | 'path';
  angle?: number;
  stops: IGradientStop[];
}
function readGradientStops(parent: unknown, theme: ThemeMap | null): IGradientFill | null {
  const grad = findChild(parent, 'a:gradFill');
  if (!grad) return null;
  const gsLst = findChild(grad, 'a:gsLst');
  const rawStops = toArray(findChild(gsLst, 'a:gs'));
  if (rawStops.length === 0) return null;
  const sorted = rawStops.slice().sort((a, b) => {
    const pa = parseInt(String((a as XmlNode)['@pos'] ?? '0'), 10);
    const pb = parseInt(String((b as XmlNode)['@pos'] ?? '0'), 10);
    return (Number.isFinite(pa) ? pa : 0) - (Number.isFinite(pb) ? pb : 0);
  });
  const stops: IGradientStop[] = [];
  for (const stop of sorted) {
    const posRaw = (stop as XmlNode)['@pos'];
    const posVal = parseInt(String(posRaw ?? '0'), 10);
    const pos = Number.isFinite(posVal) ? posVal / 100_000 : 0;
    // Each `<a:gs>` has the colour directly as a child — reuse readColor
    // to flow through srgb / scheme / prst / sys (without the gradient
    // fallback path, which would recurse here).
    let colour: string | null = null;
    const srgb = findChild(stop, 'a:srgbClr') as XmlNode | undefined;
    const srgbVal = srgb?.['@val'];
    if (typeof srgbVal === 'string' && /^[0-9a-fA-F]{6}$/.test(srgbVal)) {
      colour = applyColorModifiers(`#${srgbVal.toUpperCase()}`, srgb);
    } else {
      colour = resolveSchemeColor(stop, theme) ?? readPrstColor(stop) ?? readSysColor(stop);
    }
    if (colour) stops.push({ pos, color: colour });
  }
  if (stops.length === 0) return null;
  // Discriminator — OOXML has <a:lin> (linear), <a:path> (radial / path).
  let kind: IGradientFill['kind'] = 'linear';
  let angle: number | undefined;
  const lin = findChild(grad, 'a:lin') as XmlNode | undefined;
  if (lin) {
    kind = 'linear';
    const angRaw = lin['@ang'];
    if (angRaw !== undefined) {
      const a = parseInt(String(angRaw), 10);
      if (Number.isFinite(a)) angle = a / 60_000;
    }
  } else {
    const path = findChild(grad, 'a:path') as XmlNode | undefined;
    if (path) {
      const pathKind = path['@path'];
      // OOXML <a:path path="circle"> → radial; "rect" or "shape" → "path"
      kind = pathKind === 'circle' ? 'radial' : 'path';
    }
  }
  return { kind, ...(angle !== undefined ? { angle } : {}), stops };
}

// B12 — `<a:prstClr val="red"/>` uses the OOXML named-colour table. Only
// the common ones make it into real-world decks; map them to hex and
// skip the long tail. `<a:sysClr lastClr="HEX"/>` carries the value
// PowerPoint resolved at write time; using `lastClr` round-trips
// without needing a sysColour lookup table.
const PRST_COLOR_MAP: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF',
  yellow: 'FFFF00', cyan: '00FFFF', magenta: 'FF00FF', gray: '808080', grey: '808080',
  silver: 'C0C0C0', maroon: '800000', olive: '808000', lime: '00FF00', aqua: '00FFFF',
  teal: '008080', navy: '000080', purple: '800080', fuchsia: 'FF00FF', orange: 'FFA500',
  pink: 'FFC0CB', brown: 'A52A2A', gold: 'FFD700', dkRed: '8B0000', dkBlue: '00008B',
  dkGreen: '006400', dkGray: 'A9A9A9', dkGrey: 'A9A9A9', ltGray: 'D3D3D3', ltGrey: 'D3D3D3',
};

function readPrstColor(solid: unknown): string | null {
  const prst = findChild(solid, 'a:prstClr') as XmlNode | undefined;
  const val = prst?.['@val'];
  if (typeof val !== 'string') return null;
  const hex = PRST_COLOR_MAP[val];
  return hex ? applyColorModifiers(`#${hex}`, prst) : null;
}

function readSysColor(solid: unknown): string | null {
  const sys = findChild(solid, 'a:sysClr') as XmlNode | undefined;
  const lastClr = sys?.['@lastClr'];
  if (typeof lastClr !== 'string' || !/^[0-9a-fA-F]{6}$/.test(lastClr)) return null;
  return applyColorModifiers(`#${lastClr.toUpperCase()}`, sys);
}

// A5-idx — resolve `<p:bgRef idx="N">` into a hex colour. Looks up the
// theme's bgFillStyleLst (idx 1001+) or fillStyleLst (idx 1-1000) entry,
// then decodes the matched fill the same way readColor does for inline
// fills. The `<p:bgRef>` may also carry an inner `<a:schemeClr>` that
// *tints* the indexed entry — we apply colour modifiers off the bgRef
// itself when the indexed entry resolves to a schemeClr lookup.
//
// Returns the resolved hex (with leading "#") or null when the index
// references an entry we can't decode (blipFill / pattFill / etc.).
function resolveBgRefIdx(bgRef: XmlNode, theme: ThemeMap | null): string | null {
  if (!theme) return null;
  const cache = themeFmtSchemeCache.get(theme);
  if (!cache) return null;
  const idxRaw = bgRef['@idx'];
  if (idxRaw === undefined) return null;
  const idx = parseInt(String(idxRaw), 10);
  if (!Number.isFinite(idx)) return null;
  // Per OOXML §20.1.4.1.5:
  //   idx === 0       → noFill (omit background)
  //   idx in 1..999   → fillStyleLst[idx-1]
  //   idx === 1000    → noFill (legacy alias)
  //   idx in 1001+    → bgFillStyleLst[idx-1001]
  let entry: XmlNode | undefined;
  if (idx === 0 || idx === 1000) return null;
  if (idx >= 1001) {
    entry = cache.bgFillStyleLst[idx - 1001];
  } else if (idx >= 1) {
    entry = cache.fillStyleLst[idx - 1];
  }
  if (!entry) return null;
  // The entry is wrapped under its OOXML tag name (e.g. { 'a:solidFill': {…} }).
  // readColor + readGradFirstStop already understand a:solidFill /
  // a:gradFill children, so pass the wrapper directly. For schemeClr
  // entries, the bgRef's own inner schemeClr can carry modifiers that
  // should override the entry's base — but in practice the bgRef
  // schemeClr is just the colour seed for the indexed style. We let the
  // entry win (matches PowerPoint's rendering most of the time).
  const colour = readColor(entry, theme);
  if (colour) return colour;
  return null;
}

// Combined "read any colour" — srgbClr first, schemeClr as fallback,
// then a degraded gradient first-stop. Caller passes the parent node
// that contains `<a:solidFill>` / `<a:gradFill>` / equivalent.
//
// Some OOXML carriers (e.g. `<a:highlight>`, `<a:gs>` gradient stops)
// embed an `EG_ColorChoice` directly — no `<a:solidFill>` wrapper. After
// the wrapped attempts fail we re-run the same colour-choice probes on
// the parent itself so B13 (and any future direct-child caller) reuses
// this helper without re-deriving the colour-choice cascade.
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
    // B12 — fall back to preset / system colours before the gradient
    // degradation. These appear in plain authored decks ("solidFill
    // with red prstClr") and in legacy templates.
    const prst = readPrstColor(solid);
    if (prst) return prst;
    const sys = readSysColor(solid);
    if (sys) return sys;
  }
  // Direct EG_ColorChoice on the parent itself (no solidFill wrapper).
  // Used by `<a:highlight>` (B13) and structurally identical carriers.
  const directSrgb = findChild(parent, 'a:srgbClr') as XmlNode | undefined;
  const directSrgbVal = directSrgb?.['@val'];
  if (typeof directSrgbVal === 'string' && /^[0-9a-fA-F]{6}$/.test(directSrgbVal)) {
    return applyColorModifiers(`#${directSrgbVal.toUpperCase()}`, directSrgb);
  }
  const directSchemed = resolveSchemeColor(parent, theme);
  if (directSchemed) return directSchemed;
  const directPrst = readPrstColor(parent);
  if (directPrst) return directPrst;
  const directSys = readSysColor(parent);
  if (directSys) return directSys;
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
function parseRunProps(
  rPr: unknown,
  theme: ThemeMap | null = null,
  isTitle: boolean = false,
): Partial<ISlideRichTextProps> {
  if (!rPr || typeof rPr !== 'object') return {};
  const node = rPr as XmlNode;
  const out: Partial<ISlideRichTextProps> = {};

  // Font size — OOXML stores hundredths of point.
  const szRaw = node['@sz'];
  if (typeof szRaw === 'string' || typeof szRaw === 'number') {
    const sz = parseInt(String(szRaw), 10);
    if (Number.isFinite(sz)) out.fs = sz / 100;
  }

  // Bold / italic are tri-state: present-and-truthy, present-and-false,
  // or absent. We MUST emit explicit `bl: 0` / `it: 0` when the deck
  // sets `b="0"` / `i="0"` so it can OVERRIDE an inherited
  // bold-by-default (e.g. master title placeholder has `b="1"` and the
  // slide body explicitly opts out via `b="0"`). Absent stays absent so
  // inheritance keeps flowing.
  const b = node['@b'];
  if (b === '1' || b === 1 || b === 'true') out.bl = 1;
  else if (b === '0' || b === 0 || b === 'false') out.bl = 0;

  const i = node['@i'];
  if (i === '1' || i === 1 || i === 'true') out.it = 1;
  else if (i === '0' || i === 0 || i === 'false') out.it = 0;

  const u = node['@u'];
  if (typeof u === 'string' && u !== 'none') {
    // ITextDecoration shape — Univer accepts a truthy object. The minimum
    // is `{ s: 1 }` (single line); we pass that.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any).ul = { s: 1 };
  }

  // B8 — strikethrough. <a:rPr strike="sngStrike|dblStrike"> →
  // IStyleBase.st (same ITextDecoration shape as ul). 'noStrike'
  // and absent attribute = off. `dblStrike` collapses to a single
  // line because Univer's ITextDecoration has no double variant —
  // acceptable lossiness for a rare attribute.
  const strike = node['@strike'];
  if (strike === 'sngStrike' || strike === 'dblStrike') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any).st = { s: 1 };
  }

  // B9 — sub/superscript. <a:rPr baseline="N"> with N in thousandths
  // of a percent. Positive (e.g. 30000) = SUPERSCRIPT, negative
  // (e.g. -25000) = SUBSCRIPT, 0 / absent = NORMAL (omitted).
  const baselineRaw = node['@baseline'];
  if (typeof baselineRaw === 'string' || typeof baselineRaw === 'number') {
    const baseline = parseInt(String(baselineRaw), 10);
    if (Number.isFinite(baseline) && baseline !== 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any).va = baseline > 0 ? BaselineOffset.SUPERSCRIPT : BaselineOffset.SUBSCRIPT;
    }
  }

  // B16 — text caps transform. `<a:rPr cap="all|small|none">` is the
  // OOXML equivalent of CSS `text-transform`. Common on title styles
  // (e.g. master defaults to `cap="all"` so the title renders as
  // ALL CAPS regardless of how the author typed it). Univer's
  // IStyleBase has no text-transform field, so we mark the style with
  // a private `_cap` token and uppercase / lowercase the text at run
  // emission time. Lossy for round-trip (export won't re-emit
  // `cap="all"`) until a fork patch adds a proper IStyleBase field.
  const capRaw = node['@cap'];
  if (typeof capRaw === 'string' && capRaw !== 'none' && capRaw.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any)._cap = capRaw;
  }

  // Color: <a:solidFill><a:srgbClr val="…"/></a:solidFill> or
  // <a:solidFill><a:schemeClr val="accent1"/></a:solidFill> resolved
  // via the theme color scheme (J2).
  const colour = readColor(node, theme);
  if (colour) out.cl = { rgb: colour };

  // B13 — `<a:rPr><a:highlight><a:srgbClr|a:schemeClr|a:prstClr/></a:highlight>`.
  // Univer's IStyleBase has `bg` for background colour; highlight maps
  // naturally onto it without needing a new field.
  const highlight = findChild(node, 'a:highlight');
  if (highlight) {
    const hlColour = readColor(highlight, theme);
    if (hlColour) (out as Partial<ISlideRichTextProps> & { bg?: { rgb: string } }).bg = { rgb: hlColour };
  }

  // B14 — `<a:rPr spc="N">` is letter spacing in hundredths of a point.
  // Univer's `IStyleBase.spc` (added via fork patch) is plain pt. We pass
  // both positive (widen) and negative (tighten) values through.
  const spcRaw = node['@spc'];
  if (typeof spcRaw === 'string' || typeof spcRaw === 'number') {
    const spc = parseInt(String(spcRaw), 10);
    if (Number.isFinite(spc) && spc !== 0) {
      (out as Partial<ISlideRichTextProps> & { spc?: number }).spc = spc / 100;
    }
  }

  // B15 — `<a:rPr><a:ln>` is the glyph outline (stroke around each
  // character). Lands on the fork-patched `IStyleBase.tol`. Width is
  // OOXML EMU on import → pt on the model (matches IOutline.weight on
  // shapes). Colour resolves via readColor (srgb/scheme/prst/sys).
  const rln = findChild(node, 'a:ln') as XmlNode | undefined;
  if (rln) {
    const tolColor = readColor(rln, theme) ?? parseSrgbColor(rln);
    const wRaw = rln['@w'];
    let tolWeight: number | undefined;
    if (typeof wRaw === 'string' || typeof wRaw === 'number') {
      const emu = parseInt(String(wRaw), 10);
      // EMU → pt: 12700 EMU = 1 pt.
      if (Number.isFinite(emu)) tolWeight = emu / 12700;
    }
    if (tolColor || tolWeight !== undefined) {
      const tol: { color?: { rgb: string }; weight?: number } = {};
      if (tolColor) tol.color = { rgb: tolColor };
      if (tolWeight !== undefined) tol.weight = tolWeight;
      (out as Partial<ISlideRichTextProps> & { tol?: typeof tol }).tol = tol;
    }
  }

  // Font family (B3 + B4 + J3): prefer `<a:latin>`, then fall back to
  // `<a:ea>` (East-Asian) and `<a:cs>` (complex-script). Univer's
  // IStyleBase has a single `ff` slot, so the priority order picks the
  // one most likely to render the run's glyphs. CJK-only decks that
  // omit `<a:latin>` previously fell through to the renderer default —
  // now they get the authored typeface.
  //
  // J3 — when none of the three is present (a bare `<a:rPr>` or no
  // run-level font), fall back to the theme's `<a:fontScheme>`:
  // title-type placeholders pick up `<a:majorFont><a:latin>`; everything
  // else inherits `<a:minorFont><a:latin>`. The `isTitle` flag carries
  // the placeholder type from the caller (extractPlaceholderRects /
  // extractRichDoc).
  //
  // OOXML also uses two special `<a:latin typeface>` sentinels that
  // reference the theme indirectly: `+mj-lt` (major Latin) and `+mn-lt`
  // (minor Latin). When we see those, resolve them right here instead of
  // passing the literal "+mj-lt" string to the renderer.
  const latin = findChild(node, 'a:latin') as XmlNode | undefined;
  const ea = findChild(node, 'a:ea') as XmlNode | undefined;
  const cs = findChild(node, 'a:cs') as XmlNode | undefined;
  const resolveThemeSentinel = (raw: string | false): string | false => {
    if (raw === '+mj-lt') return theme?.get(FONT_MAJOR_KEY) ?? raw;
    if (raw === '+mn-lt') return theme?.get(FONT_MINOR_KEY) ?? raw;
    return raw;
  };
  const typeface =
    resolveThemeSentinel(typeof latin?.['@typeface'] === 'string' && latin['@typeface']) ||
    resolveThemeSentinel(typeof ea?.['@typeface'] === 'string' && ea['@typeface']) ||
    resolveThemeSentinel(typeof cs?.['@typeface'] === 'string' && cs['@typeface']) ||
    '';
  if (typeof typeface === 'string' && typeface.length > 0) {
    out.ff = substituteFontFamily(typeface);
  } else if (theme) {
    const themeFont = isTitle ? theme.get(FONT_MAJOR_KEY) : theme.get(FONT_MINOR_KEY);
    if (themeFont) out.ff = substituteFontFamily(themeFont);
  }

  return out;
}

// MS-proprietary deck fonts → metric-compatible open-source replacements
// loaded by index.html via Google Fonts. Without this rewrite, canvas
// `ctx.font = "Calibri"` resolves to the system fallback chain on every
// non-Windows machine (everything collapses to Arial). Carlito is
// designed metric-identical to Calibri by tyPoland; Caladea is the
// same for Cambria by Huerta Tipográfica.
const FONT_SUBSTITUTION_MAP: Record<string, string> = {
  'Calibri': 'Carlito',
  'Calibri Light': 'Carlito',
  'Calibri Bold': 'Carlito',
  'Cambria': 'Caladea',
  'Cambria Math': 'Caladea',
};

function substituteFontFamily(family: string): string {
  const sub = FONT_SUBSTITUTION_MAP[family];
  return sub ?? family;
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
// Bullet info — the IBullet block that lands on the paragraph PLUS
// any custom glyph metadata the importer can plug into a per-document
// `lists` map. When `customGlyph` is set, the caller must synthesise
// an entry in `IDocumentData.lists` keyed by `listType` so the
// renderer pulls the right character instead of falling back to the
// PRESET_LIST_TYPE preset glyph.
interface ParsedBullet {
  bullet: IBullet;
  customGlyph?: string;
  // `<a:buSzPts val="N">` is the bullet font size in 1/100 pt.
  customFontSize?: number;
  // `<a:buFont typeface="...">` — font to render the bullet glyph in.
  customFontFamily?: string;
}

function parseBullet(pPr: unknown, listIdSeed: string, level: number, theme: ThemeMap | null = null): ParsedBullet | null {
  if (!pPr || typeof pPr !== 'object') return null;
  const node = pPr as XmlNode;
  if (findChild(node, 'a:buNone') !== undefined) {
    // Explicit "no bullet" — caller treats null as "no override", so
    // we distinguish via a sentinel `none` flag.
    return null;
  }
  const buChar = findChild(node, 'a:buChar') as XmlNode | undefined;
  if (buChar) {
    const rawChar = buChar['@char'];
    const customGlyph = typeof rawChar === 'string' && rawChar.length > 0 ? rawChar : undefined;
    // C17 — read companion `<a:buFont typeface="...">` and
    // `<a:buSzPts val="...">` so the bullet glyph matches the
    // authored size/typeface (an ➔ rendered in Wingdings looks
    // nothing like an ➔ in Raleway).
    const buFont = findChild(node, 'a:buFont') as XmlNode | undefined;
    let customFontFamily: string | undefined;
    if (buFont) {
      const raw = buFont['@typeface'];
      if (typeof raw === 'string' && raw.length > 0) {
        // Resolve the same theme sentinels (`+mj-lt` / `+mn-lt`) that
        // parseRunProps handles.
        if (raw === '+mj-lt') customFontFamily = theme?.get(FONT_MAJOR_KEY) ?? undefined;
        else if (raw === '+mn-lt') customFontFamily = theme?.get(FONT_MINOR_KEY) ?? undefined;
        else customFontFamily = raw;
      }
    }
    const buSzPts = findChild(node, 'a:buSzPts') as XmlNode | undefined;
    let customFontSize: number | undefined;
    if (buSzPts) {
      const raw = buSzPts['@val'];
      if (typeof raw === 'string' || typeof raw === 'number') {
        const n = parseInt(String(raw), 10);
        if (Number.isFinite(n)) customFontSize = n / 100;
      }
    }
    // Custom listType when we have a char so it doesn't collide with
    // the global PRESET_LIST_TYPE entry. Each element-seed gets its
    // own listType so the lists map stays scoped to this text frame.
    const listType = customGlyph ? `${listIdSeed}-bul` : PresetListType.BULLET_LIST;
    return {
      bullet: { listType, listId: `${listIdSeed}-bul`, nestingLevel: level },
      customGlyph,
      customFontSize,
      customFontFamily,
    };
  }
  const buAutoNum = findChild(node, 'a:buAutoNum') as XmlNode | undefined;
  if (buAutoNum) {
    return {
      bullet: { listType: PresetListType.ORDER_LIST, listId: `${listIdSeed}-ord`, nestingLevel: level },
    };
  }
  return null;
}

// Wave 7b — text-frame body properties (C10 insets + C11 vertical
// anchor). OOXML's `<a:bodyPr lIns="…" tIns="…" rIns="…" bIns="…"
// anchor="t|ctr|b">` controls the inset between the frame's bounding
// box and its text, plus where the text aligns vertically inside.
//
// Defaults (per OOXML §17.16.10): lIns=91440 (0.1in), tIns=45720
// (0.05in), rIns=91440, bIns=45720, anchor=t. We only emit non-default
// values to keep the documentStyle small.
function parseBodyPr(bodyPr: unknown): Partial<IDocumentStyle> | null {
  if (!bodyPr || typeof bodyPr !== 'object') return null;
  const node = bodyPr as XmlNode;
  const out: Partial<IDocumentStyle> = {};
  const readEmu = (key: string): number | undefined => {
    const raw = node[key];
    if (raw === undefined) return undefined;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) ? n / EMU_PER_PIXEL : undefined;
  };
  const lIns = readEmu('@lIns');
  const tIns = readEmu('@tIns');
  const rIns = readEmu('@rIns');
  const bIns = readEmu('@bIns');
  if (lIns !== undefined) out.marginLeft = lIns;
  if (tIns !== undefined) out.marginTop = tIns;
  if (rIns !== undefined) out.marginRight = rIns;
  if (bIns !== undefined) out.marginBottom = bIns;

  const anchor = node['@anchor'];
  let verticalAlign: VerticalAlign | null = null;
  if (typeof anchor === 'string') {
    switch (anchor) {
      case 't': verticalAlign = VerticalAlign.TOP; break;
      case 'ctr': verticalAlign = VerticalAlign.MIDDLE; break;
      case 'b': verticalAlign = VerticalAlign.BOTTOM; break;
      default: verticalAlign = null;
    }
  }
  if (verticalAlign !== null) {
    out.renderConfig = { ...(out.renderConfig ?? {}), verticalAlign };
  }

  // C14 — text wrap. OOXML's `<a:bodyPr wrap="square|none">` controls
  // whether long lines wrap within the frame (`square`, the default)
  // or overflow horizontally (`none`). Map to Univer's WrapStrategy:
  // `square` → WRAP, `none` → OVERFLOW. Absent attribute keeps the
  // renderer default.
  const wrap = node['@wrap'];
  if (wrap === 'none') {
    out.renderConfig = { ...(out.renderConfig ?? {}), wrapStrategy: WrapStrategy.OVERFLOW };
  } else if (wrap === 'square') {
    out.renderConfig = { ...(out.renderConfig ?? {}), wrapStrategy: WrapStrategy.WRAP };
  }

  // C12 — body rotation. OOXML's `<a:bodyPr rot="N">` is the in-frame
  // text rotation in 60000ths of a degree (positive = clockwise). Common
  // values: 5400000 (90°), 10800000 (180°), 16200000 (270°). Univer's
  // `IDocumentRenderConfig.centerAngle` is the equivalent (degrees,
  // applied to text content within the doc body). Only emit when an
  // explicit, finite, non-zero value is present so the default
  // (no rotation) stays implicit.
  const rotRaw = node['@rot'];
  if (rotRaw !== undefined) {
    const rot = parseInt(String(rotRaw), 10);
    if (Number.isFinite(rot) && rot !== 0) {
      out.renderConfig = { ...(out.renderConfig ?? {}), centerAngle: rot / 60000 };
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

// C13 — text-frame autofit. OOXML's
// `<a:bodyPr><a:normAutofit fontScale="N" lnSpcReduction="N"/></a:bodyPr>`
// tells the renderer to shrink text proportionally until it fits the
// frame. `fontScale` is the kept fraction of the original font size in
// thousandths of a percent (default 100000 = 100 %). `lnSpcReduction`
// (default 0) is the amount the line-spacing should be reduced by.
//
// Univer's `IDocumentRenderConfig` has no explicit autofit slot. The
// practical compromise: apply the fontScale to the run's font size at
// import time (multiply `fs` by `fontScale / 100000`). This bakes the
// shrunk size into the text style. It's lossy on round-trip — exported
// `fs` will already be shrunk — but it gets the correct visual at
// import, which is the whole game for read fidelity.
//
// `lnSpcReduction` is NOT applied for v1 — Univer's line-spacing model
// is multiplicative; layering this on top is risky without a runtime
// check.
//
// Returns the multiplier (e.g. 0.8 for fontScale="80000") or 1 when
// the attribute is absent / not finite.
function parseBodyPrFontScale(bodyPr: unknown): number {
  if (!bodyPr || typeof bodyPr !== 'object') return 1;
  const normAutofit = findChild(bodyPr, 'a:normAutofit') as XmlNode | undefined;
  if (!normAutofit) return 1;
  const raw = normAutofit['@fontScale'];
  if (raw === undefined) return 1;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n / 100_000;
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
  relMap: Map<string, string> | null = null,
  fontScale: number = 1,
  isTitle: boolean = false,
  // C16 — for each regular-parsed paragraph at index i,
  // `orderedParaChildren[i]` is the DOM-ordered child list (from
  // fast-xml-parser preserveOrder mode). Used to interleave `<a:r>`
  // runs and `<a:br>` soft line breaks. When provided, `<a:br>` cuts
  // the current paragraph segment and starts a continuation segment
  // with the same paragraphStyle minus bullet + spaceAbove (so
  // multi-line bulleted items don't repeat the bullet on each visual
  // line). When undefined (table cells, legacy callers), the function
  // falls back to runs-only iteration and silently drops `<a:br>`.
  orderedParaChildren?: unknown[][],
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
  // B17 — accumulate hyperlink ranges as we walk runs; rangeId is a
  // per-frame counter so multiple links in one frame stay distinct.
  const customRanges: ICustomRange[] = [];
  let hlinkCounter = 0;
  let cursor = 0;
  let firstRunProps: Partial<ISlideRichTextProps> = {};
  let capturedFirstRun = false;
  // C17 — custom bullet list types accumulated across paragraphs.
  // Each entry is keyed by `bullet.listType` and carries the glyph
  // string + optional textStyle the renderer should use. Built into
  // `documentStyle.lists` at the end so the docs engine can resolve
  // the bullet correctly instead of falling back to PRESET_LIST_TYPE.
  const customLists: Record<string, { glyph: string; level: number; fs?: number; ff?: string }> = {};

  // Extract the tag name from a preserveOrder child entry. Each
  // entry has the shape `{ <tagName>: [children], ':@'?: attrs }`.
  const orderedTagOf = (entry: unknown): string | null => {
    if (!entry || typeof entry !== 'object') return null;
    for (const k of Object.keys(entry as Record<string, unknown>)) {
      if (k !== ':@') return k;
    }
    return null;
  };

  for (let paraIdx = 0; paraIdx < paras.length; paraIdx += 1) {
    const p = paras[paraIdx];
    const runs = toArray(findChild(p, 'a:r'));

    // Paragraph-level style is computed once and shared across every
    // segment produced by this source paragraph (segments only appear
    // when `<a:br>` cuts a paragraph mid-flight).
    const pPr = findChild(p, 'a:pPr');
    const align = parseParagraphAlign(pPr);
    const lineSpacing = parseLineSpacing(pPr);
    const { indentStart, indentFirstLine } = parseIndent(pPr);
    const level = parseLevel(pPr);
    const parsedBullet = parseBullet(pPr, elementId, level, theme);
    const bullet = parsedBullet?.bullet ?? null;
    // C17 — stash any custom glyph metadata so we can synthesise the
    // matching `IListData` entry on the document below.
    if (parsedBullet?.customGlyph) {
      customLists[parsedBullet.bullet.listType] = {
        glyph: parsedBullet.customGlyph,
        level,
        fs: parsedBullet.customFontSize,
        ff: parsedBullet.customFontFamily,
      };
    }
    const spaceAbove = parseSpacePts(findChild(pPr, 'a:spcBef'));
    const spaceBelow = parseSpacePts(findChild(pPr, 'a:spcAft'));

    const rtl = (pPr as XmlNode | undefined)?.['@rtl'];
    const isRtl = rtl === '1' || rtl === 1 || rtl === 'true';

    const baseStyle: IParagraphStyle = {};
    if (align !== null) baseStyle.horizontalAlign = align;
    // Casual Slides — when `<a:lnSpc>` is absent on a paragraph,
    // PowerPoint defaults to single (1.0x) line spacing. Univer's
    // docs engine applies a much more generous default.
    baseStyle.lineSpacing = lineSpacing !== null ? lineSpacing : 1;
    if (indentStart !== undefined) baseStyle.indentStart = { v: indentStart };
    if (indentFirstLine !== undefined) baseStyle.indentFirstLine = { v: indentFirstLine };
    if (spaceAbove !== null) baseStyle.spaceAbove = { v: spaceAbove };
    if (spaceBelow !== null) baseStyle.spaceBelow = { v: spaceBelow };
    if (isRtl) baseStyle.direction = TextDirection.RIGHT_TO_LEFT;

    // Build the walk order. With ordered info, interleave `<a:r>` and
    // `<a:br>` faithfully; without it, treat every child as an `<a:r>`
    // (legacy behaviour, drops `<a:br>` silently).
    const orderedItems = orderedParaChildren?.[paraIdx];
    type ItemTag = 'a:r' | 'a:br';
    const items: ItemTag[] = orderedItems && orderedItems.length > 0
      ? (orderedItems as unknown[])
          .map((e) => orderedTagOf(e))
          .filter((t): t is ItemTag => t === 'a:r' || t === 'a:br')
      : runs.map(() => 'a:r' as const);

    const segmentText: string[] = [];
    let segmentIdx = 0;
    let regularRunIdx = 0;

    // Emit one paragraph entry + the closing `\r`. Used both at
    // `<a:br>` boundaries and at the end of the source paragraph.
    const flushSegment = () => {
      const style: IParagraphStyle = { ...baseStyle };
      if (segmentIdx > 0) {
        // Continuation segment from `<a:br>` — drop spaceAbove so the
        // soft break doesn't add a gap that PowerPoint wouldn't.
        delete style.spaceAbove;
      }
      const paragraph: IParagraph = { startIndex: cursor };
      if (Object.keys(style).length > 0) paragraph.paragraphStyle = style;
      // Bullet attaches to the FIRST segment only — continuation lines
      // sit under the bullet without repeating the marker.
      if (segmentIdx === 0 && bullet) paragraph.bullet = bullet;
      paragraphs.push(paragraph);
      dataStream.push('\r');
      lines.push(segmentText.join(''));
      cursor += 1;
      segmentText.length = 0;
      segmentIdx += 1;
    };

    for (const tag of items) {
      if (tag === 'a:br') {
        flushSegment();
        continue;
      }
      // `<a:r>` — consume the next regular run.
      const r = runs[regularRunIdx];
      regularRunIdx += 1;
      if (!r) continue;
      const tNode = findChild(r, 'a:t');
      let txt = readT(tNode);

      const rPr = findChild(r, 'a:rPr');
      const runStyle = parseRunProps(rPr, theme, isTitle);
      const ts = { ...(fallbackProps ?? {}), ...runStyle };

      // B16 — apply text-caps transform from runStyle._cap (or
      // inherited from fallback). `all` → uppercase, `small` → also
      // uppercase (Univer doesn't have small-caps glyphs; fold to
      // upper for visual proximity). The marker is private so we
      // delete it before the style lands on the textRun.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const effCap = (ts as any)._cap;
      if (typeof effCap === 'string' && (effCap === 'all' || effCap === 'small')) {
        txt = txt.toLocaleUpperCase();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (ts as any)._cap;
      segmentText.push(txt);
      dataStream.push(txt);

      if (txt.length > 0) {
        textRuns.push({ st: cursor, ed: cursor + txt.length, ts });
      }

      // B17 — hyperlinks.
      if (rPr && relMap && txt.length > 0) {
        const hlink = findChild(rPr, 'a:hlinkClick') as XmlNode | undefined;
        const rId = hlink?.['@r:id'] ?? hlink?.['@r:embed'];
        if (typeof rId === 'string') {
          const target = relMap.get(rId);
          if (target && /^https?:\/\//i.test(target)) {
            hlinkCounter += 1;
            customRanges.push({
              startIndex: cursor,
              endIndex: cursor + txt.length,
              rangeId: `${elementId}-hl-${hlinkCounter}`,
              rangeType: CustomRangeType.HYPERLINK,
              properties: { url: target },
            });
          }
        }
      }

      cursor += txt.length;

      if (!capturedFirstRun && Object.keys(runStyle).length > 0) {
        firstRunProps = runStyle;
        capturedFirstRun = true;
      }
    }

    // Close the source paragraph's final segment with its own \r.
    flushSegment();
  }

  // Univer convention: the section-final `\n` sits past the last \r.
  dataStream.push('\n');

  // C10 + C11 — text-frame insets and vertical anchor from `<a:bodyPr>`.
  const bodyPr = findChild(txBody, 'a:bodyPr');
  const docStyle = parseBodyPr(bodyPr) ?? {};

  // C13 — stash the parsed normAutofit fontScale on documentStyle.renderConfig
  // so the engine-render side can multiply at draw time. Non-1 only;
  // skip the no-op identity case to keep IDocumentData minimal.
  if (fontScale !== 1) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (docStyle as any).renderConfig = {
      ...((docStyle as { renderConfig?: object }).renderConfig ?? {}),
      fontScale,
    };
  }

  // C17 — synthesise `lists` entries for any paragraphs that asked
  // for a custom bullet glyph (e.g. `<a:buChar char="➔"/>`). Each
  // entry mirrors the PRESET_LIST_TYPE shape — a 9-level array (one
  // per nesting depth) all using the same glyph at the authored
  // depth, with passthrough glyphs at others. The nesting level the
  // paragraph references is stored on the bullet itself.
  const lists: Record<string, unknown> = {};
  for (const [listType, info] of Object.entries(customLists)) {
    // Univer's bullet renderer indexes into `nestingLevel[paragraph.bullet.nestingLevel]`.
    // We fill 9 slots so unexpected deeper nesting still resolves.
    const nestingLevel = Array.from({ length: 9 }, () => ({
      glyphFormat: ` %${1}`,
      glyphSymbol: info.glyph,
      bulletAlignment: 0, // BulletAlignment.START
      startNumber: 0,
      paragraphProperties: {
        hanging: { v: 21 },
        indentStart: { v: 21 * info.level },
      },
      textStyle: {
        ...(typeof info.fs === 'number' ? { fs: info.fs } : {}),
        ...(typeof info.ff === 'string' ? { ff: info.ff } : {}),
      },
    }));
    lists[listType] = { listType, nestingLevel };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rich: IDocumentData = {
    id: `${elementId}-doc`,
    body: {
      dataStream: dataStream.join(''),
      textRuns,
      paragraphs,
      ...(customRanges.length > 0 ? { customRanges } : {}),
    },
    ...(Object.keys(lists).length > 0 ? { lists } : {}),
    documentStyle: docStyle,
  } as any;

  // Flat fallback fields = layout/master defaults spread under first
  // run's overrides. Run-level wins by field.
  // Note: fontScale (C13) is intentionally NOT applied here. It lives
  // on documentStyle.renderConfig.fontScale and the engine-render
  // glyph creation honors it at draw time. The flat `fs` on the
  // legacy PptxGenJS export path then writes the original (un-shrunk)
  // size back to OOXML, preserving the fontScale round-trip.
  const props: Partial<ISlideRichTextProps> = fallbackProps
    ? { ...fallbackProps, ...firstRunProps }
    : { ...firstRunProps };

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

// D12 — `<a:noFill/>` is a direct child of spPr that means "no fill",
// distinct from an absent fill (which inherits from theme/layout). We
// signal it with the CSS-style transparent string so the renderer reads
// alpha=0; the export side recognises the sentinel and skips PptxGenJS's
// `fill` opt entirely, preserving the no-fill semantics on round-trip.
const TRANSPARENT_FILL = 'rgba(0,0,0,0)';

// F4 — pptx encodes lines (and connectors) with one zero dimension —
// height=0 for a horizontal line, width=0 for a vertical line. The
// bbox-based renderer clips zero-area shapes to nothing, hiding the
// stroke. Inflate the zero side to the stroke width so the line
// survives. Affects `prst="line"` and connector families.
function isLineLikeShape(prst: string): boolean {
  return (
    prst === 'line' ||
    prst.startsWith('straightConnector') ||
    prst.startsWith('bentConnector') ||
    prst.startsWith('curvedConnector')
  );
}

function inflateLineBbox(
  shapeType: string,
  width: number,
  height: number,
  outlineWeightPx: number | null,
): { width: number; height: number } {
  if (!isLineLikeShape(shapeType)) return { width, height };
  const stroke = Math.max(1, outlineWeightPx ?? 1);
  return {
    width: width > 0 ? width : stroke,
    height: height > 0 ? height : stroke,
  };
}

// D17 — read `<a:headEnd>` / `<a:tailEnd>` arrowhead descriptors.
// IArrowhead lands on the fork-patched IOutline (added in wave 7m).
type Arrowhead = { type?: string; w?: 'sm' | 'med' | 'lg'; len?: 'sm' | 'med' | 'lg' };
function parseArrowhead(node: unknown): Arrowhead | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as XmlNode;
  const out: Arrowhead = {};
  const type = n['@type'];
  if (typeof type === 'string' && type.length > 0) out.type = type;
  const w = n['@w'];
  if (w === 'sm' || w === 'med' || w === 'lg') out.w = w;
  const len = n['@len'];
  if (len === 'sm' || len === 'med' || len === 'lg') out.len = len;
  return Object.keys(out).length > 0 ? out : null;
}

// D18 + D19 — read `<a:effectLst>` and decode each child effect. EMU
// values pass through unchanged; the renderer is expected to convert.
interface IEffectListPayload {
  outerShdw?: { color?: { rgb: string }; blurRad?: number; dist?: number; dir?: number };
  innerShdw?: { color?: { rgb: string }; blurRad?: number; dist?: number; dir?: number };
  glow?: { color?: { rgb: string }; rad?: number };
  reflection?: { blurRad?: number; stA?: number; endA?: number };
  blur?: { rad?: number; grow?: boolean };
}
function parseShadow(node: unknown, theme: ThemeMap | null): IEffectListPayload['outerShdw'] | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as XmlNode;
  const out: NonNullable<IEffectListPayload['outerShdw']> = {};
  const color = readColor(n, theme) ?? parseSrgbColor(n);
  if (color) out.color = { rgb: color };
  const blurRadRaw = n['@blurRad'];
  if (typeof blurRadRaw === 'string' || typeof blurRadRaw === 'number') {
    const v = parseInt(String(blurRadRaw), 10);
    if (Number.isFinite(v)) out.blurRad = v;
  }
  const distRaw = n['@dist'];
  if (typeof distRaw === 'string' || typeof distRaw === 'number') {
    const v = parseInt(String(distRaw), 10);
    if (Number.isFinite(v)) out.dist = v;
  }
  const dirRaw = n['@dir'];
  if (typeof dirRaw === 'string' || typeof dirRaw === 'number') {
    const v = parseInt(String(dirRaw), 10);
    if (Number.isFinite(v)) out.dir = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}
function parseEffectList(spPr: unknown, theme: ThemeMap | null): IEffectListPayload | null {
  const effectLst = findChild(spPr, 'a:effectLst');
  if (!effectLst) return null;
  const out: IEffectListPayload = {};

  const outerShdw = parseShadow(findChild(effectLst, 'a:outerShdw'), theme);
  if (outerShdw) out.outerShdw = outerShdw;
  const innerShdw = parseShadow(findChild(effectLst, 'a:innerShdw'), theme);
  if (innerShdw) out.innerShdw = innerShdw;

  const glowNode = findChild(effectLst, 'a:glow') as XmlNode | undefined;
  if (glowNode) {
    const glow: NonNullable<IEffectListPayload['glow']> = {};
    const color = readColor(glowNode, theme) ?? parseSrgbColor(glowNode);
    if (color) glow.color = { rgb: color };
    const radRaw = glowNode['@rad'];
    if (typeof radRaw === 'string' || typeof radRaw === 'number') {
      const v = parseInt(String(radRaw), 10);
      if (Number.isFinite(v)) glow.rad = v;
    }
    if (Object.keys(glow).length > 0) out.glow = glow;
  }

  const reflNode = findChild(effectLst, 'a:reflection') as XmlNode | undefined;
  if (reflNode) {
    const refl: NonNullable<IEffectListPayload['reflection']> = {};
    const readIntAttr = (k: string) => {
      const raw = reflNode[k];
      if (raw === undefined) return;
      const v = parseInt(String(raw), 10);
      return Number.isFinite(v) ? v : undefined;
    };
    const blurRad = readIntAttr('@blurRad');
    if (blurRad !== undefined) refl.blurRad = blurRad;
    const stA = readIntAttr('@stA');
    if (stA !== undefined) refl.stA = stA;
    const endA = readIntAttr('@endA');
    if (endA !== undefined) refl.endA = endA;
    if (Object.keys(refl).length > 0) out.reflection = refl;
  }

  const blurNode = findChild(effectLst, 'a:blur') as XmlNode | undefined;
  if (blurNode) {
    const blur: NonNullable<IEffectListPayload['blur']> = {};
    const radRaw = blurNode['@rad'];
    if (typeof radRaw === 'string' || typeof radRaw === 'number') {
      const v = parseInt(String(radRaw), 10);
      if (Number.isFinite(v)) blur.rad = v;
    }
    const growRaw = blurNode['@grow'];
    if (growRaw === '1' || growRaw === 'true' || growRaw === true) blur.grow = true;
    if (Object.keys(blur).length > 0) out.blur = blur;
  }

  return Object.keys(out).length > 0 ? out : null;
}

// D6 — custom geometry `<a:custGeom>`. PowerPoint expresses arbitrary
// vector outlines as a list of paths, each with a coordinate-space
// `@w` / `@h` (in EMU) and a sequence of path commands:
//   <a:moveTo>     <a:pt x y/>             → SVG M
//   <a:lnTo>       <a:pt x y/>             → SVG L
//   <a:cubicBezTo> three <a:pt> children   → SVG C
//   <a:quadBezTo>  two <a:pt> children     → SVG Q
//   <a:arcTo wR hR stAng swAng/>           → approximated by an SVG cubic
//                                            (the OOXML arc model uses
//                                            radial sweep that doesn't
//                                            map directly to SVG's
//                                            endpoint-based arc; for our
//                                            best-effort pass we emit a
//                                            small `L` to the implied
//                                            endpoint so the path stays
//                                            connected — full arc fidelity
//                                            requires the formula system
//                                            we're deliberately skipping).
//   <a:close/>                              → SVG Z
//
// Coordinates inside each path are relative to that path's coord space,
// not the shape's bounding box. We normalise by dividing by `@w` / `@h`
// so the output is fractional (0..1) — easy for the renderer to scale to
// the shape's actual width / height.
//
// The `<a:avLst>` adjustment-handle / formula system (`<a:gd>`) is
// SKIPPED. In real-world templates, custGeom that PowerPoint emits after
// a user-defined shape has literal point coordinates baked in, so the
// formula system is rarely exercised. Anything that does rely on `<a:gd>`
// formulas falls through to no pathData (visual is the rect fallback).
function parseCustGeomPath(custGeom: unknown): string | null {
  if (!custGeom || typeof custGeom !== 'object') return null;
  const pathLst = findChild(custGeom, 'a:pathLst');
  const paths = toArray(findChild(pathLst, 'a:path'));
  if (paths.length === 0) return null;
  const segments: string[] = [];
  for (const path of paths) {
    if (!path || typeof path !== 'object') continue;
    const pNode = path as XmlNode;
    const wRaw = pNode['@w'];
    const hRaw = pNode['@h'];
    const w = parseInt(String(wRaw ?? '0'), 10);
    const h = parseInt(String(hRaw ?? '0'), 10);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    // Helper: read <a:pt x y/> (children of a path command) into
    // normalised fractional coords. Returns null when the point can't
    // parse — caller skips the command in that case.
    const readPt = (pt: unknown): { x: number; y: number } | null => {
      if (!pt || typeof pt !== 'object') return null;
      const ptNode = pt as XmlNode;
      const x = parseInt(String(ptNode['@x'] ?? ''), 10);
      const y = parseInt(String(ptNode['@y'] ?? ''), 10);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: x / w, y: y / h };
    };
    // Walk the path's children in document order. fast-xml-parser
    // groups same-tag children into arrays so we have to scan known
    // commands. Within a `<a:moveTo>` etc., the inner `<a:pt>` may be
    // a single object or an array depending on count.
    //
    // OOXML doesn't strictly require document order for the commands
    // (the schema names them as a sequence), but in practice PowerPoint
    // emits them in the natural left-to-right order. Object.keys
    // preserves insertion order in V8 — we lean on that.
    for (const key of Object.keys(pNode)) {
      if (key.startsWith('@')) continue;
      if (key === '#text') continue;
      const children = toArray(pNode[key]);
      for (const cmd of children) {
        // <a:close/> is self-closing — fast-xml-parser emits it as an
        // empty string. We need to keep it so the Z command lands.
        if (cmd === undefined || cmd === null) continue;
        switch (key) {
          case 'a:moveTo': {
            const pt = readPt(findChild(cmd, 'a:pt'));
            if (pt) segments.push(`M${pt.x.toFixed(4)},${pt.y.toFixed(4)}`);
            break;
          }
          case 'a:lnTo': {
            const pt = readPt(findChild(cmd, 'a:pt'));
            if (pt) segments.push(`L${pt.x.toFixed(4)},${pt.y.toFixed(4)}`);
            break;
          }
          case 'a:cubicBezTo': {
            const pts = toArray(findChild(cmd, 'a:pt'));
            if (pts.length >= 3) {
              const p1 = readPt(pts[0]);
              const p2 = readPt(pts[1]);
              const p3 = readPt(pts[2]);
              if (p1 && p2 && p3) {
                segments.push(`C${p1.x.toFixed(4)},${p1.y.toFixed(4)} ${p2.x.toFixed(4)},${p2.y.toFixed(4)} ${p3.x.toFixed(4)},${p3.y.toFixed(4)}`);
              }
            }
            break;
          }
          case 'a:quadBezTo': {
            const pts = toArray(findChild(cmd, 'a:pt'));
            if (pts.length >= 2) {
              const p1 = readPt(pts[0]);
              const p2 = readPt(pts[1]);
              if (p1 && p2) {
                segments.push(`Q${p1.x.toFixed(4)},${p1.y.toFixed(4)} ${p2.x.toFixed(4)},${p2.y.toFixed(4)}`);
              }
            }
            break;
          }
          case 'a:arcTo': {
            // Best-effort: skip the arc-curvature math (OOXML's
            // start-angle / sweep-angle radial form doesn't map cleanly
            // to SVG's endpoint arc). Future work can synthesise an SVG
            // A command using wR/hR if a deck shows up where arc
            // fidelity matters.
            break;
          }
          case 'a:close': {
            segments.push('Z');
            break;
          }
          default:
            // Unknown command tag (e.g. extLst) — skip.
            break;
        }
      }
    }
  }
  return segments.length > 0 ? segments.join(' ') : null;
}

function parseShapeAppearance(spPr: unknown, theme: ThemeMap | null = null): {
  shapeType: string;
  pathData: string | null;
  fillRgb: string | null;
  fillGradient: IGradientFill | null;
  outlineRgb: string | null;
  outlineWeightPx: number | null;
  outlineDash: BorderStyleTypes | null;
  outlineCap: 'flat' | 'rnd' | 'sq' | null;
  headEnd: Arrowhead | null;
  tailEnd: Arrowhead | null;
  effectLst: IEffectListPayload | null;
  // D7 — adjustment values from `<a:prstGeom><a:avLst><a:gd name="adjN" fmla="val M"/>`.
  // PowerPoint shapes with tunable handles (wedgeRectCallout pointer
  // position, roundRect corner radius, chevron arrow head, etc.) store
  // each handle as `adj1`, `adj2`, ... in 1/100000 of the shape
  // width/height. The renderer can read these to draw the correct path.
  prstAdjustments: Record<string, number> | null;
} {
  const prstGeom = findChild(spPr, 'a:prstGeom') as XmlNode | undefined;
  const prstAttr = prstGeom?.['@prst'];
  // D7 — adjustment values. Each `<a:gd>` carries `@name="adjN"` and
  // `@fmla="val M"`. We parse the integer out of the formula.
  let prstAdjustments: Record<string, number> | null = null;
  const avLst = findChild(prstGeom, 'a:avLst');
  if (avLst) {
    for (const gd of toArray(findChild(avLst, 'a:gd'))) {
      if (!gd || typeof gd !== 'object') continue;
      const node = gd as XmlNode;
      const name = node['@name'];
      const fmla = node['@fmla'];
      if (typeof name !== 'string' || typeof fmla !== 'string') continue;
      // Only the `val N` shape is supported today — formula
      // expressions (`*/ adj1 1 2` etc.) would need a small evaluator.
      const m = fmla.match(/^val\s+(-?\d+)$/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n)) continue;
      prstAdjustments = prstAdjustments ?? {};
      prstAdjustments[name] = n;
    }
  }
  // D6 — custom geometry. When `<a:custGeom>` is present alongside (or
  // instead of) `<a:prstGeom>`, parse the path commands into an SVG
  // path string. The renderer can use this in place of the prst lookup
  // for shapes PowerPoint authored with the freeform / scribble tool.
  // We keep emitting a prst shapeType — the renderer falls back to it
  // when pathData is absent.
  const custGeom = findChild(spPr, 'a:custGeom');
  const pathData = custGeom ? parseCustGeomPath(custGeom) : null;
  const shapeType = typeof prstAttr === 'string' && prstAttr.length > 0
    ? prstAttr
    : (pathData ? 'custGeom' : 'rect');

  // D12 first — explicit `<a:noFill/>` beats any inherited / solid fill.
  // Line-like shapes also conceptually carry no fill (only a stroke);
  // emit transparent so they don't paint a phantom rectangle behind
  // the stroke when the OOXML omits `<a:noFill/>`.
  const hasNoFill =
    findChild(spPr, 'a:noFill') !== undefined || isLineLikeShape(shapeType);
  const fillRgb = hasNoFill
    ? TRANSPARENT_FILL
    : readColor(spPr, theme) ?? parseSrgbColor(spPr);
  // A3 / D9 — harvest the full gradient stops. Renderer-side work will
  // pick this up; the flat fillRgb above stays as the first-stop
  // degradation so older render paths keep their colour.
  const fillGradient = hasNoFill ? null : readGradientStops(spPr, theme);

  let outlineRgb: string | null = null;
  let outlineWeightPx: number | null = null;
  let outlineDash: BorderStyleTypes | null = null;
  let outlineCap: 'flat' | 'rnd' | 'sq' | null = null;
  let headEnd: Arrowhead | null = null;
  let tailEnd: Arrowhead | null = null;
  const ln = findChild(spPr, 'a:ln') as XmlNode | undefined;
  if (ln) {
    outlineRgb = readColor(ln, theme) ?? parseSrgbColor(ln);
    outlineDash = parsePrstDash(ln);
    // D16 — `<a:ln cap="flat|rnd|sq">` lands on the patched `IOutline.cap`.
    // 'flat' is the OOXML default, so we only emit explicit non-default
    // values to keep the shape model lean.
    const capAttr = ln['@cap'];
    if (capAttr === 'rnd' || capAttr === 'sq' || capAttr === 'flat') {
      outlineCap = capAttr;
    }
    // D17 — arrowheads.
    headEnd = parseArrowhead(findChild(ln, 'a:headEnd'));
    tailEnd = parseArrowhead(findChild(ln, 'a:tailEnd'));
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

  // D18 + D19 — `<a:effectLst>` shadow / glow / reflection / blur.
  const effectLst = parseEffectList(spPr, theme);

  return { shapeType, pathData, fillRgb, fillGradient, outlineRgb, outlineWeightPx, outlineDash, outlineCap, headEnd, tailEnd, effectLst, prstAdjustments };
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

// Slide-side placeholder lookup with the same key-fan-out as the
// indexer's `indexUnderAllKeys`. A slide-side `<p:ph idx="N" type="T">`
// tries, in order:
//   `T|N`  exact
//   `T|`   type-only (master/layout often omit idx)
//   `|N`   idx-only (slides sometimes drop @type for numbered slots)
//   `|0`   bare default
// This unblocks decks like the sample one where slide 2's title uses
// `<p:ph idx="4294967295" type="title">` while master defines just
// `<p:ph type="title">` (no idx). Without the fan-out the exact key
// missed and the slide lost its inherited bold + Raleway font.
function getPlaceholderInherited(
  map: Map<string, PlaceholderRect>,
  sp: unknown,
): PlaceholderRect | null {
  const nvSpPr = findChild(sp, 'p:nvSpPr');
  const nvPr = findChild(nvSpPr, 'p:nvPr');
  const ph = findChild(nvPr, 'p:ph') as XmlNode | undefined;
  if (!ph) return null;
  const type = ph['@type'];
  const idx = ph['@idx'];
  const t = type === undefined ? '' : String(type);
  const i = idx === undefined ? '' : String(idx);
  const candidates: string[] = [];
  if (t || i) candidates.push(`${t}|${i}`);
  if (t) candidates.push(`${t}|`);
  if (i) candidates.push(`|${i}`);
  if (!t && !i) candidates.push('|0');
  // Also try class aliases (title↔ctrTitle, body↔subTitle).
  if (t && PLACEHOLDER_TYPE_ALIASES[t]) {
    for (const alias of PLACEHOLDER_TYPE_ALIASES[t]) {
      if (i) candidates.push(`${alias}|${i}`);
      candidates.push(`${alias}|`);
    }
  }
  for (const key of candidates) {
    const hit = map.get(key);
    if (hit) return hit;
  }
  return null;
}

// Layout/master placeholder lookup is tolerant to (type, idx) shape
// mismatches between the slide and its layout. OOXML lets either side
// drop @idx (titles typically) or @type (numbered body slots) and
// still expects them to match. We index every layout/master placeholder
// under up to three keys so any slide-side variant lands the same rect:
//   `${type}|${idx}` — exact
//   `${type}|`      — type-only (matches slide `<p:ph type=…>` with no idx)
//   `|${idx}`       — idx-only (matches slide `<p:ph idx=…>` with no type)
// Slide lookup keeps the simple `${type}|${idx}` shape; one of the
// three layout-side indexes is the match.
// OOXML places related placeholder types in the same inheritance class
// per §17.7.5. A slide's `<p:ph type="ctrTitle">` inherits from the
// master's `<p:ph type="title">`; `subTitle` inherits from `body`; etc.
// When indexing, we alias each type under every member of its class so
// a slide-side `ctrTitle` lookup also lands the master's `title`-keyed
// rect (with the layout's `ctrTitle` overrides merged on top).
const PLACEHOLDER_TYPE_ALIASES: Record<string, string[]> = {
  title: ['ctrTitle'],
  ctrTitle: ['title'],
  body: ['subTitle'],
  subTitle: ['body'],
};

function indexUnderAllKeys(map: Map<string, PlaceholderRect>, ph: XmlNode | undefined, rect: PlaceholderRect): void {
  if (!ph) return;
  const type = ph['@type'];
  const idx = ph['@idx'];
  const t = type === undefined ? '' : String(type);
  const i = idx === undefined ? '' : String(idx);
  // Exact key
  map.set(`${t}|${i}`, rect);
  // Type-only key (matches slide `<p:ph type=…>` w/ no idx)
  if (t) map.set(`${t}|`, rect);
  // Idx-only key (matches slide `<p:ph idx=…>` w/ no type)
  if (i) map.set(`|${i}`, rect);
  // Bare placeholder default
  if (!t && !i) map.set('|0', rect);
  // J5 — inheritance aliasing across related placeholder types so
  // master's `title` rect/defaults are visible under `ctrTitle` keys
  // (and similar) when the slide picks the specialised type but
  // master only declared the generic one.
  if (t && PLACEHOLDER_TYPE_ALIASES[t]) {
    for (const alias of PLACEHOLDER_TYPE_ALIASES[t]) {
      map.set(`${alias}|${i}`, rect);
      map.set(`${alias}|`, rect);
    }
  }
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
    const nvSpPr = findChild(sp, 'p:nvSpPr');
    const nvPr = findChild(nvSpPr, 'p:nvPr');
    const ph = findChild(nvPr, 'p:ph') as XmlNode | undefined;
    if (!ph) continue;
    const spPr = findChild(sp, 'p:spPr');
    const xfrm = findChild(spPr, 'a:xfrm');
    const off = xfrm ? (findChild(xfrm, 'a:off') as XmlNode | undefined) : undefined;
    const ext = xfrm ? (findChild(xfrm, 'a:ext') as XmlNode | undefined) : undefined;

    // I4 — default run properties live at
    // <p:txBody><a:lstStyle><a:lvl1pPr><a:defRPr ...>.
    // Use lvl1 as our canonical placeholder default; deeper levels
    // (a:lvl2pPr etc.) matter once bullets land in wave 6.
    //
    // J3 — title-type placeholders fall back to the major font; everything
    // else to the minor font. parseRunProps consults the flag when the
    // defRPr has no explicit `<a:latin>` / `<a:ea>` / `<a:cs>`.
    const phType = ph['@type'];
    const isTitlePh = phType === 'title' || phType === 'ctrTitle';
    let defaultRunProps: Partial<ISlideRichTextProps> | undefined;
    const txBody = findChild(sp, 'p:txBody');
    const lstStyle = findChild(txBody, 'a:lstStyle');
    const lvl1pPr = findChild(lstStyle, 'a:lvl1pPr');
    const defRPr = findChild(lvl1pPr, 'a:defRPr');
    if (defRPr) {
      const parsed = parseRunProps(defRPr, theme, isTitlePh);
      if (Object.keys(parsed).length > 0) defaultRunProps = parsed;
    } else if (theme) {
      // No defRPr but we still want the theme font fallback so the
      // placeholder's inherited default reflects the deck's heading /
      // body typeface. Emit a minimal ff-only defaultRunProps.
      const themeFont = isTitlePh ? theme.get(FONT_MAJOR_KEY) : theme.get(FONT_MINOR_KEY);
      if (themeFont) defaultRunProps = { ff: themeFont };
    }

    // Either an xfrm rect or text-style defaults is enough to be worth
    // recording — a placeholder with neither carries no inheritance.
    if (!off || !ext) {
      if (defaultRunProps) {
        indexUnderAllKeys(map, ph, {
          left: 0, top: 0, width: 0, height: 0,
          defaultRunProps,
        });
      }
      continue;
    }

    indexUnderAllKeys(map, ph, {
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

// I5 — footer / date / page-number "service" placeholders. Layouts and
// masters routinely declare `<p:sp>` with `<p:ph type="ftr">`,
// `<p:ph type="dt">` (date), or `<p:ph type="sldNum">` carrying both
// geometry AND the displayed text ("‹#›" for slide number, "&[Date]" for
// the dynamic date, "Footer" or an authored brand string for ftr).
// When the slide doesn't declare its own version, the user still
// expects these to render. PowerPoint resolves them through the
// header-footer system; we approximate by emitting the layout/master
// content as a TEXT element on import.
interface ServicePlaceholder {
  type: 'ftr' | 'dt' | 'sldNum';
  rect: PlaceholderRect;
  text: string;
  props: Partial<ISlideRichTextProps>;
  rich: IDocumentData | null;
}

// Walk a `<p:sldLayout>` or `<p:sldMaster>` XML and collect every
// footer/date/sldNum placeholder along with its rendered text. Returns
// a map keyed by the placeholder type so the caller can look up
// "what's the master-supplied footer text?".
function extractServicePlaceholders(layoutOrMasterXml: string, theme: ThemeMap | null = null): Map<'ftr' | 'dt' | 'sldNum', ServicePlaceholder> {
  const parsed = parser.parse(layoutOrMasterXml) as XmlNode;
  const root =
    (findChild(parsed, 'p:sldLayout') as XmlNode | undefined) ??
    (findChild(parsed, 'p:sldMaster') as XmlNode | undefined);
  const map = new Map<'ftr' | 'dt' | 'sldNum', ServicePlaceholder>();
  if (!root) return map;
  const spTree = findChild(findChild(root, 'p:cSld'), 'p:spTree');
  for (const sp of toArray(findChild(spTree, 'p:sp'))) {
    if (!sp || typeof sp !== 'object') continue;
    const nvSpPr = findChild(sp, 'p:nvSpPr');
    const nvPr = findChild(nvSpPr, 'p:nvPr');
    const ph = findChild(nvPr, 'p:ph') as XmlNode | undefined;
    if (!ph) continue;
    const phType = ph['@type'];
    if (phType !== 'ftr' && phType !== 'dt' && phType !== 'sldNum') continue;

    const spPr = findChild(sp, 'p:spPr');
    const xfrm = findChild(spPr, 'a:xfrm');
    const off = xfrm ? (findChild(xfrm, 'a:off') as XmlNode | undefined) : undefined;
    const ext = xfrm ? (findChild(xfrm, 'a:ext') as XmlNode | undefined) : undefined;

    const lstStyle = findChild(findChild(sp, 'p:txBody'), 'a:lstStyle');
    const lvl1pPr = findChild(lstStyle, 'a:lvl1pPr');
    const defRPr = findChild(lvl1pPr, 'a:defRPr');
    let defaultRunProps: Partial<ISlideRichTextProps> | undefined;
    if (defRPr) {
      const parsedDef = parseRunProps(defRPr, theme);
      if (Object.keys(parsedDef).length > 0) defaultRunProps = parsedDef;
    }

    const rect: PlaceholderRect = {
      left: emu2px(off?.['@x'] as string | undefined),
      top: emu2px(off?.['@y'] as string | undefined),
      width: emu2px(ext?.['@cx'] as string | undefined),
      height: emu2px(ext?.['@cy'] as string | undefined),
      defaultRunProps,
    };

    // Pull text + run formatting via the existing shared extractor so
    // multi-run formatting in the master/layout placeholder (e.g. a
    // styled "&[Date]" run) lands the same way as a slide-side run.
    const txBody = findChild(sp, 'p:txBody');
    let { text, props, rich } = extractRichDoc(
      txBody,
      `service-${phType}`,
      defaultRunProps,
      theme,
      null,
      1,
      false,
    );

    // `<a:fld>` (text field — slide number / date placeholders use it)
    // doesn't get walked by extractRichDoc since the run loop only
    // iterates `<a:r>`. As a pragmatic fallback, when the placeholder
    // text came back empty AND the txBody contains an `<a:fld>` with
    // visible text, use that. Live substitution (replacing the field
    // with the actual slide number / date) is renderer work.
    if (text.trim().length === 0 && txBody) {
      const paras = toArray(findChild(txBody, 'a:p'));
      const fldTexts: string[] = [];
      for (const p of paras) {
        for (const fld of toArray(findChild(p, 'a:fld'))) {
          if (!fld || typeof fld !== 'object') continue;
          const t = (fld as XmlNode)['a:t'];
          if (typeof t === 'string') fldTexts.push(t);
          else if (t && typeof t === 'object') {
            const inner = (t as XmlNode)['#text'];
            if (typeof inner === 'string') fldTexts.push(inner);
          }
        }
      }
      if (fldTexts.length > 0) {
        text = fldTexts.join('');
        // Use the placeholder's default run props as the run's style
        // (best we can do without parsing the fld's own rPr).
        props = { ...(defaultRunProps ?? {}) };
        rich = null;
      }
    }

    // Only emit the service placeholder when it actually carries
    // visible text. An empty footer placeholder in the master is a
    // common "reserved slot" — we don't want to paint blank text boxes
    // when the slide deliberately omits the footer.
    if (text.trim().length === 0) continue;

    map.set(phType, { type: phType, rect, text, props, rich });
  }
  return map;
}

// Resolve a slide's layout (then master) and merge their service
// placeholders. Layout entries win over master (same precedence as
// buildPlaceholderMap).
async function buildServicePlaceholders(
  slideRelsXml: string | null,
  zip: JSZip,
  theme: ThemeMap | null,
): Promise<Map<'ftr' | 'dt' | 'sldNum', ServicePlaceholder>> {
  if (!slideRelsXml) return new Map();
  const layoutTarget = findRelTargetByType(slideRelsXml, '/slideLayout');
  if (!layoutTarget) return new Map();
  const layoutPath = resolveRelTarget(layoutTarget, 'ppt/slides/');
  const layoutXml = await zip.file(layoutPath)?.async('string');
  if (!layoutXml) return new Map();

  const layoutDir = layoutPath.slice(0, layoutPath.lastIndexOf('/') + 1);
  const layoutName = layoutPath.split('/').pop() ?? '';
  const layoutRelsXml = await zip.file(`${layoutDir}_rels/${layoutName}.rels`)?.async('string');

  let masterMap = new Map<'ftr' | 'dt' | 'sldNum', ServicePlaceholder>();
  if (layoutRelsXml) {
    const masterTarget = findRelTargetByType(layoutRelsXml, '/slideMaster');
    if (masterTarget) {
      const masterPath = resolveRelTarget(masterTarget, layoutDir);
      const masterXml = await zip.file(masterPath)?.async('string');
      if (masterXml) masterMap = extractServicePlaceholders(masterXml, theme);
    }
  }

  const layoutMap = extractServicePlaceholders(layoutXml, theme);
  // Master first, then layout overrides (per OOXML order).
  const merged = new Map<'ftr' | 'dt' | 'sldNum', ServicePlaceholder>(masterMap);
  for (const [k, v] of layoutMap) merged.set(k, v);
  return merged;
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
  /** Deck-level `<p:defaultTextStyle>` lvl1pPr/defRPr — lowest-priority text defaults (K3) */
  deckDefaultRunProps?: Partial<ISlideRichTextProps>;
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

async function processSpTree(
  spTree: unknown,
  reg: ImageRegistry,
  pageOrdinal: number,
  groupXfrm: GroupXfrm,
  z: ZCounter,
  out: IPageElement[],
  // Casual Slides — preserveOrder representation of THIS spTree's
  // children. Used to compute each element's source-XML DOM rank so a
  // post-pass in extractElementsFromSlideXml can sort the output by
  // DOM order (matching PowerPoint's z-stacking rules) instead of by
  // the type-grouped order the loops below produce. Recursion through
  // <p:grpSp> threads the group's own ordered children.
  orderedChildren: unknown[] = [],
  parentRankPrefix: number[] = [],
  // When true, skip any `<p:sp>` / `<p:pic>` carrying a `<p:ph>` — used
  // when extracting layout/master background shapes so we don't double-
  // emit placeholders that are already inherited via I3 / I4. Non-
  // placeholder shapes (like the orange right-half rectangle on
  // slide-16's layout) become slide-bg elements that paint BELOW the
  // slide's own content.
  skipPlaceholders: boolean = false,
): Promise<void> {
  // Build DOM-rank lookup: for each tag we care about, an array where
  // domRanks[tag][nthOccurrence] = position-in-spTree-children.
  const domRanks: Record<string, number[]> = {
    'p:sp': [], 'p:cxnSp': [], 'p:pic': [], 'p:graphicFrame': [], 'p:grpSp': [],
  };
  {
    const perTag = new Map<string, number>();
    orderedChildren.forEach((child, position) => {
      if (!child || typeof child !== 'object') return;
      const tag = Object.keys(child as Record<string, unknown>).find((k) => k !== ':@');
      if (!tag) return;
      const count = perTag.get(tag) ?? 0;
      perTag.set(tag, count + 1);
      if (tag in domRanks) domRanks[tag][count] = position;
    });
  }
  // After each per-tag loop iteration we stamp every element pushed
  // during that iteration with its `_sourceRank` — the composite
  // [parent...,thisRank] tuple. extractElementsFromSlideXml sorts by
  // these and re-stamps zIndex.
  const stampPushed = (lenBefore: number, tag: string, idxWithinTag: number) => {
    const myRank = domRanks[tag]?.[idxWithinTag] ?? idxWithinTag;
    const composite = [...parentRankPrefix, myRank];
    for (let i = lenBefore; i < out.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out[i] as any)._sourceRank = composite;
    }
  };
  // C16 — pre-build a list of `<p:sp>` ordered entries so each regular
  // sp[i] can match orderedSpEntries[i] (fast-xml-parser preserves
  // same-tag array order across both regular and ordered modes). From
  // that, derive per-paragraph DOM-ordered children for the
  // `<a:r>` / `<a:br>` interleaving extractRichDoc needs.
  const orderedSpEntries: unknown[] = orderedChildren.filter(
    (c) => c && typeof c === 'object' && 'p:sp' in (c as Record<string, unknown>),
  );
  // <p:sp>
  let _spLoopIdx = 0;
  for (const sp of toArray(findChild(spTree, 'p:sp'))) {
    const _myIdx = _spLoopIdx++;
    const _lenBefore = out.length;
    if (!sp || typeof sp !== 'object') continue;
    if (skipPlaceholders) {
      // Skip any sp tagged as a placeholder — its content is inherited
      // separately via the placeholder map. Non-placeholder shapes
      // (layout background rectangles, decorative shapes) flow through.
      const _nvSpPr = findChild(sp, 'p:nvSpPr');
      const _nvPr = findChild(_nvSpPr, 'p:nvPr');
      if (findChild(_nvPr, 'p:ph') !== undefined) continue;
    }
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
    const phInherited = getPlaceholderInherited(reg.placeholderRects, sp);
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
    // Casual Slides — `<p:sp>` with an EMPTY `<p:txBody>` is a SHAPE
    // (e.g. a layout's decorative rectangle that happens to declare an
    // empty placeholder text body for authoring affordance). We should
    // fall through to the shape branch so its fill / outline render
    // instead of emitting a transparent zero-text TEXT element that
    // drops the shape's fill colour. Detect "actual text content"
    // via any non-empty `<a:t>` in the body.
    const hasRealText = (() => {
      if (!txBody) return false;
      const ps = toArray(findChild(txBody, 'a:p'));
      for (const p of ps) {
        for (const r of toArray(findChild(p, 'a:r'))) {
          const t = findChild(r, 'a:t');
          if (typeof t === 'string' && t.length > 0) return true;
          if (t && typeof t === 'object' && typeof (t as XmlNode)['#text'] === 'string' && ((t as XmlNode)['#text'] as string).length > 0) return true;
        }
      }
      return false;
    })();
    if (txBody && hasRealText) {
      const elId = `s${pageOrdinal}-el-${zIndex}`;
      // C13 — read `<a:bodyPr><a:normAutofit fontScale="…"/></a:bodyPr>`
      // before walking runs so the autofit shrink applies to every per-run
      // `fs` (including those inherited from placeholder defaults).
      const txBodyPr = findChild(txBody, 'a:bodyPr');
      const fontScale = parseBodyPrFontScale(txBodyPr);
      // J3 — title-type placeholders inherit the theme's major Latin
      // font; everything else picks up the minor Latin font. The flag
      // also feeds parseRunProps for inline `+mj-lt` / `+mn-lt` sentinels.
      const nvSpPr = findChild(sp, 'p:nvSpPr');
      const nvPr = findChild(nvSpPr, 'p:nvPr');
      const ph = findChild(nvPr, 'p:ph') as XmlNode | undefined;
      const phType = ph?.['@type'];
      const isTitle = phType === 'title' || phType === 'ctrTitle';
      // K3 — fallback priority: deck-default < master/layout placeholder default.
      // The placeholder default (already merged across layout > master in
      // buildPlaceholderMap) wins field-by-field on top of the deck default.
      const fallback = reg.deckDefaultRunProps || phInherited?.defaultRunProps
        ? { ...(reg.deckDefaultRunProps ?? {}), ...(phInherited?.defaultRunProps ?? {}) }
        : undefined;
      // C16 — derive DOM-ordered child lists for each paragraph in
      // this sp's txBody, so extractRichDoc can interleave `<a:r>` +
      // `<a:br>` faithfully. Falls through quietly if the ordered
      // entry shape doesn't match (e.g. when called from contexts
      // without an ordered XML parse).
      const orderedSp = orderedSpEntries[_myIdx] as Record<string, unknown> | undefined;
      const _orderedParaChildren: unknown[][] = (() => {
        if (!orderedSp || typeof orderedSp !== 'object') return [];
        const spKids = orderedSp['p:sp'];
        if (!Array.isArray(spKids)) return [];
        const txBodyEntry = spKids.find(
          (c) => c && typeof c === 'object' && 'p:txBody' in (c as Record<string, unknown>),
        );
        if (!txBodyEntry) return [];
        const txBodyKids = (txBodyEntry as Record<string, unknown>)['p:txBody'];
        if (!Array.isArray(txBodyKids)) return [];
        const paraEntries = txBodyKids.filter(
          (c) => c && typeof c === 'object' && 'a:p' in (c as Record<string, unknown>),
        );
        return paraEntries.map((pe) => {
          const kids = (pe as Record<string, unknown>)['a:p'];
          return Array.isArray(kids) ? kids : [];
        });
      })();
      const { text, props, rich } = extractRichDoc(
        txBody,
        elId,
        fallback,
        reg.theme,
        reg.imageRelMap,
        fontScale,
        isTitle,
        _orderedParaChildren,
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
      stampPushed(_lenBefore, 'p:sp', _myIdx);
      continue;
    }

    if (spPr) {
      const { shapeType, pathData, fillRgb, fillGradient, outlineRgb, outlineWeightPx, outlineDash, outlineCap, headEnd, tailEnd, effectLst, prstAdjustments } = parseShapeAppearance(spPr, reg.theme);
      const inflated = inflateLineBbox(shapeType, width, height, outlineWeightPx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shapeProperties: any = {};
      if (fillRgb) shapeProperties.shapeBackgroundFill = { rgb: fillRgb };
      // D9 — full gradient stops alongside the flat fillRgb (which keeps
      // the first-stop degradation). Renderer agent picks this up.
      if (fillGradient) shapeProperties.gradientFill = fillGradient;
      // D6 — custGeom path data (SVG-style commands, coordinates
      // normalised 0..1 against the shape's bbox).
      if (pathData) shapeProperties.pathData = pathData;
      if (prstAdjustments) shapeProperties.prstAdjustments = prstAdjustments;
      if (outlineRgb || outlineWeightPx !== null || outlineDash !== null || outlineCap !== null || headEnd !== null || tailEnd !== null) {
        shapeProperties.outline = {
          outlineFill: outlineRgb ? { rgb: outlineRgb } : undefined,
          weight: outlineWeightPx ?? 1,
          ...(outlineDash !== null ? { dashStyle: outlineDash } : {}),
          ...(outlineCap !== null ? { cap: outlineCap } : {}),
          ...(headEnd !== null ? { headEnd } : {}),
          ...(tailEnd !== null ? { tailEnd } : {}),
        };
      }
      if (effectLst !== null) shapeProperties.effectLst = effectLst;
      out.push({
        id: `s${pageOrdinal}-shape-${zIndex}`,
        zIndex,
        left,
        top,
        width: inflated.width,
        height: inflated.height,
        angle,
        flipX,
        flipY,
        title: '',
        description: '',
        type: PageElementType.SHAPE,
        shape: { shapeType: shapeType as never, text: '', shapeProperties },
      });
    }
    stampPushed(_lenBefore, 'p:sp', _myIdx);
  }

  // F3 — `<p:cxnSp>` connectors. Same geometry shape as `<p:sp>` minus
  // the text body. PowerPoint emits `prst="line"`, `"straightConnector1"`,
  // `"bentConnector3"`, etc. — pass through to Univer's shapeType so
  // future renderer work picks them up. Position + outline + flips all
  // flow through the same branches as a regular shape.
  let _cxnLoopIdx = 0;
  for (const cxn of toArray(findChild(spTree, 'p:cxnSp'))) {
    const _myIdx = _cxnLoopIdx++;
    const _lenBefore = out.length;
    if (!cxn || typeof cxn !== 'object') continue;
    const spPr = findChild(cxn, 'p:spPr');
    if (!spPr) continue;
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

    const zIndex = z.next;
    z.next += 1;
    const { shapeType, pathData, fillRgb, fillGradient, outlineRgb, outlineWeightPx, outlineDash, outlineCap, headEnd, tailEnd, effectLst, prstAdjustments } = parseShapeAppearance(spPr, reg.theme);
    const inflated = inflateLineBbox(shapeType, width, height, outlineWeightPx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shapeProperties: any = {};
    if (fillRgb) shapeProperties.shapeBackgroundFill = { rgb: fillRgb };
    if (fillGradient) shapeProperties.gradientFill = fillGradient;
    if (pathData) shapeProperties.pathData = pathData;
    if (prstAdjustments) shapeProperties.prstAdjustments = prstAdjustments;
    if (outlineRgb || outlineWeightPx !== null || outlineDash !== null || outlineCap !== null || headEnd !== null || tailEnd !== null) {
      shapeProperties.outline = {
        outlineFill: outlineRgb ? { rgb: outlineRgb } : undefined,
        weight: outlineWeightPx ?? 1,
        ...(outlineDash !== null ? { dashStyle: outlineDash } : {}),
        ...(outlineCap !== null ? { cap: outlineCap } : {}),
        ...(headEnd !== null ? { headEnd } : {}),
        ...(tailEnd !== null ? { tailEnd } : {}),
      };
    }
    if (effectLst !== null) shapeProperties.effectLst = effectLst;
    out.push({
      id: `s${pageOrdinal}-cxn-${zIndex}`,
      zIndex,
      left,
      top,
      width: inflated.width,
      height: inflated.height,
      angle,
      flipX,
      flipY,
      title: '',
      description: '',
      type: PageElementType.SHAPE,
      shape: { shapeType: shapeType as never, text: '', shapeProperties },
    });
    stampPushed(_lenBefore, 'p:cxnSp', _myIdx);
  }

  // <p:pic>
  let _picLoopIdx = 0;
  for (const pic of toArray(findChild(spTree, 'p:pic'))) {
    const _myIdx = _picLoopIdx++;
    const _lenBefore = out.length;
    if (!pic || typeof pic !== 'object') continue;
    if (skipPlaceholders) {
      const _nvPicPr = findChild(pic, 'p:nvPicPr');
      const _nvPr = findChild(_nvPicPr, 'p:nvPr');
      if (findChild(_nvPr, 'p:ph') !== undefined) continue;
    }
    const result = await processPicNode(pic, reg, groupXfrm, pageOrdinal, z);
    if (result) out.push(result);
    stampPushed(_lenBefore, 'p:pic', _myIdx);
  }

  // G1-G4 + H1 — `<p:graphicFrame>` wraps tables (via `<a:tbl>`) and
  // charts (via `<c:chart>`). Both share the graphicFrame xfrm + a
  // `<a:graphicData>` with a uri discriminator. Walk once and dispatch
  // per uri.
  let _gfLoopIdx = 0;
  for (const gf of toArray(findChild(spTree, 'p:graphicFrame'))) {
    const _myIdx = _gfLoopIdx++;
    const _lenBefore = out.length;
    if (!gf || typeof gf !== 'object') continue;
    const result = await processGraphicFrame(gf, reg, groupXfrm, pageOrdinal, z);
    if (result) out.push(result);
    stampPushed(_lenBefore, 'p:graphicFrame', _myIdx);
  }

  // <p:grpSp> — recurse. Compose this group's xfrm with the inherited
  // group transform so nested groups stack correctly. The group's own
  // children get a composite rank prefix so the post-sort places them
  // exactly where the group was in source XML.
  let _grpLoopIdx = 0;
  for (const grp of toArray(findChild(spTree, 'p:grpSp'))) {
    const _myIdx = _grpLoopIdx++;
    if (!grp || typeof grp !== 'object') continue;
    const grpSpPr = findChild(grp, 'p:grpSpPr');
    const innerXfrm = readGroupXfrm(grpSpPr);
    const childXfrm = composeXfrm(groupXfrm, innerXfrm);
    // Find THIS group's preserveOrder children to thread into the
    // recursive call.
    let nthSeen = 0;
    let grpOrdered: unknown[] = [];
    for (const c of orderedChildren) {
      if (c && typeof c === 'object' && 'p:grpSp' in (c as Record<string, unknown>)) {
        if (nthSeen === _myIdx) {
          const v = (c as Record<string, unknown>)['p:grpSp'];
          if (Array.isArray(v)) grpOrdered = v;
          break;
        }
        nthSeen++;
      }
    }
    const newPrefix = [...parentRankPrefix, domRanks['p:grpSp']?.[_myIdx] ?? _myIdx];
    // The group itself is structural — only its children produce
    // IPageElements. Univer has no native "group" page-element type in
    // the OSS model (Gap 3 candidate), so we flatten and let z-order
    // preserve the visual stack.
    await processSpTree(grp, reg, pageOrdinal, childXfrm, z, out, grpOrdered, newPrefix, skipPlaceholders);
  }
}

// G1-G4 — table parser. `<a:tbl>` carries:
//   <a:tblGrid><a:gridCol w="EMU"/>…</a:tblGrid>  (column widths)
//   <a:tr h="EMU">                                 (rows; h is row height)
//     <a:tc gridSpan="N" rowSpan="N" hMerge vMerge>
//       <a:txBody>…</a:txBody>                     (cell text)
//       <a:tcPr>
//         <a:solidFill><a:srgbClr val=…/></a:solidFill>  (cell fill)
//         <a:lnL>…</a:lnL> / lnR / lnT / lnB         (per-edge borders;
//                                                    we collapse to a
//                                                    single colour/weight)
//       </a:tcPr>
//     </a:tc>
//   </a:tr>
function parseTableCellAppearance(tcPr: unknown, theme: ThemeMap | null): { fillRgb?: string; outlineRgb?: string; outlineWeight?: number } {
  if (!tcPr) return {};
  const out: { fillRgb?: string; outlineRgb?: string; outlineWeight?: number } = {};
  const fill = readColor(tcPr, theme) ?? parseSrgbColor(tcPr);
  if (fill) out.fillRgb = fill;
  // Borders — left edge wins if present, else top, else right, else bottom.
  // This is lossy on a per-edge basis but matches our single-colour cell
  // border model. A future widening could surface per-edge.
  for (const k of ['a:lnL', 'a:lnT', 'a:lnR', 'a:lnB'] as const) {
    const ln = findChild(tcPr, k) as XmlNode | undefined;
    if (!ln) continue;
    const rgb = readColor(ln, theme) ?? parseSrgbColor(ln);
    if (rgb && !out.outlineRgb) out.outlineRgb = rgb;
    const w = ln['@w'];
    if ((typeof w === 'string' || typeof w === 'number') && out.outlineWeight === undefined) {
      const emu = parseInt(String(w), 10);
      if (Number.isFinite(emu)) out.outlineWeight = emu / EMU_PER_PIXEL;
    }
    if (out.outlineRgb && out.outlineWeight !== undefined) break;
  }
  return out;
}

function parseTable(tbl: unknown, reg: ImageRegistry, elementId: string): { rows: Array<{ height?: number; cells: Array<{ text?: string; richText?: unknown; fillRgb?: string; outlineRgb?: string; outlineWeight?: number; colSpan?: number; rowSpan?: number; hMerge?: boolean; vMerge?: boolean }> }>; columnWidths?: number[] } {
  const rows: Array<{ height?: number; cells: Array<{ text?: string; richText?: unknown; fillRgb?: string; outlineRgb?: string; outlineWeight?: number; colSpan?: number; rowSpan?: number; hMerge?: boolean; vMerge?: boolean }> }> = [];
  const columnWidths: number[] = [];
  const tblGrid = findChild(tbl, 'a:tblGrid');
  for (const col of toArray(findChild(tblGrid, 'a:gridCol'))) {
    if (!col || typeof col !== 'object') continue;
    const w = (col as XmlNode)['@w'];
    if (typeof w === 'string' || typeof w === 'number') {
      const emu = parseInt(String(w), 10);
      if (Number.isFinite(emu)) columnWidths.push(emu / EMU_PER_PIXEL);
    }
  }
  let rowIdx = 0;
  for (const tr of toArray(findChild(tbl, 'a:tr'))) {
    if (!tr || typeof tr !== 'object') continue;
    const trNode = tr as XmlNode;
    const hRaw = trNode['@h'];
    const height = typeof hRaw === 'string' || typeof hRaw === 'number'
      ? (Number.isFinite(parseInt(String(hRaw), 10)) ? parseInt(String(hRaw), 10) / EMU_PER_PIXEL : undefined)
      : undefined;
    const cells: Array<{ text?: string; richText?: unknown; fillRgb?: string; outlineRgb?: string; outlineWeight?: number; colSpan?: number; rowSpan?: number; hMerge?: boolean; vMerge?: boolean }> = [];
    let cellIdx = 0;
    for (const tc of toArray(findChild(tr, 'a:tc'))) {
      if (!tc || typeof tc !== 'object') continue;
      const tcNode = tc as XmlNode;
      const gridSpan = tcNode['@gridSpan'];
      const rowSpan = tcNode['@rowSpan'];
      const cell: { text?: string; richText?: unknown; fillRgb?: string; outlineRgb?: string; outlineWeight?: number; colSpan?: number; rowSpan?: number; hMerge?: boolean; vMerge?: boolean } = {};
      if (typeof gridSpan === 'string' || typeof gridSpan === 'number') {
        const n = parseInt(String(gridSpan), 10);
        if (Number.isFinite(n) && n > 1) cell.colSpan = n;
      }
      if (typeof rowSpan === 'string' || typeof rowSpan === 'number') {
        const n = parseInt(String(rowSpan), 10);
        if (Number.isFinite(n) && n > 1) cell.rowSpan = n;
      }
      if (tcNode['@hMerge'] === '1' || tcNode['@hMerge'] === 1 || tcNode['@hMerge'] === 'true') cell.hMerge = true;
      if (tcNode['@vMerge'] === '1' || tcNode['@vMerge'] === 1 || tcNode['@vMerge'] === 'true') cell.vMerge = true;
      const tcPr = findChild(tc, 'a:tcPr');
      Object.assign(cell, parseTableCellAppearance(tcPr, reg.theme));
      const txBody = findChild(tc, 'a:txBody');
      if (txBody) {
        const cellElId = `${elementId}-r${rowIdx}-c${cellIdx}`;
        const { text, props, rich } = extractRichDoc(txBody, cellElId, undefined, reg.theme, reg.imageRelMap);
        if (text) cell.text = text;
        if (rich) cell.richText = { text, ...props, rich };
      }
      cells.push(cell);
      cellIdx += 1;
    }
    rows.push({ ...(height !== undefined ? { height } : {}), cells });
    rowIdx += 1;
  }
  return { rows, ...(columnWidths.length > 0 ? { columnWidths } : {}) };
}

// H2 + H3 — parse `<c:chart>` XML payload into a structured IChart so
// the UI can read chart type + series labels + numeric values without
// re-walking the OOXML. Goal: "see the chart data on screen", not
// "edit the chart". We pull:
//   • chartType — first child of <c:plotArea> matching a known chart
//     element (barChart / lineChart / pieChart / scatterChart /
//     areaChart / doughnutChart / radarChart / surfaceChart / bubbleChart).
//   • categories — <c:cat><c:strRef> or <c:numRef> values from the FIRST
//     series (PowerPoint repeats categories across series, so the first
//     is sufficient).
//   • series — each <c:ser>:
//       - name from <c:tx><c:strRef><c:strCache><c:pt><c:v> or <c:tx><c:v>
//       - values from <c:val><c:numRef><c:numCache><c:pt><c:v> in order
//   These are enough to drive a basic bar/line/pie chart UI without
//   touching the chart's full OOXML.
const CHART_TYPE_TAGS = [
  'c:barChart', 'c:bar3DChart',
  'c:lineChart', 'c:line3DChart',
  'c:pieChart', 'c:pie3DChart', 'c:doughnutChart',
  'c:scatterChart',
  'c:areaChart', 'c:area3DChart',
  'c:radarChart',
  'c:surfaceChart', 'c:surface3DChart',
  'c:bubbleChart',
  'c:stockChart',
  'c:ofPieChart',
] as const;

interface IChartSeries {
  name?: string;
  values: number[];
}

interface IChartStructured {
  chartId: string;
  chartPath?: string;
  // H3 — chart type (e.g. 'bar', 'line', 'pie', 'scatter'). Stripped of
  // the 'c:' prefix and the trailing 'Chart' suffix so consumers can
  // switch on a clean enum-ish string.
  chartType?: string;
  categories?: string[];
  series?: IChartSeries[];
}

function readChartCellValues(ref: unknown, cacheKey: string): { values: string[]; numeric: number[] } {
  // Both <c:strRef> and <c:numRef> wrap a <c:strCache> / <c:numCache>
  // with a <c:ptCount @val> + repeating <c:pt idx><c:v>VALUE</c:v></c:pt>.
  // Index ordering matters for line / bar charts (X-axis position) — sort
  // by @idx ascending so the array index lines up.
  const values: string[] = [];
  const numeric: number[] = [];
  const cache = findChild(ref, cacheKey);
  if (!cache) return { values, numeric };
  const pts = toArray(findChild(cache, 'c:pt'));
  const sorted = pts.slice().sort((a, b) => {
    const ia = parseInt(String((a as XmlNode)['@idx'] ?? '0'), 10);
    const ib = parseInt(String((b as XmlNode)['@idx'] ?? '0'), 10);
    return (Number.isFinite(ia) ? ia : 0) - (Number.isFinite(ib) ? ib : 0);
  });
  for (const pt of sorted) {
    const v = findChild(pt, 'c:v');
    let text: string;
    if (typeof v === 'string') text = v;
    else if (typeof v === 'number') text = String(v);
    else if (v && typeof v === 'object') {
      const inner = (v as XmlNode)['#text'];
      text = inner === undefined ? '' : String(inner);
    } else {
      text = '';
    }
    values.push(text);
    const n = parseFloat(text);
    numeric.push(Number.isFinite(n) ? n : 0);
  }
  return { values, numeric };
}

function parseChartXml(chartXml: string, chartId: string, chartPath?: string): IChartStructured {
  const out: IChartStructured = { chartId, ...(chartPath ? { chartPath } : {}) };
  const parsed = parser.parse(chartXml) as XmlNode;
  const chartSpace = findChild(parsed, 'c:chartSpace');
  const chart = findChild(chartSpace, 'c:chart');
  const plotArea = findChild(chart, 'c:plotArea');
  if (!plotArea) return out;

  // H3 — chart type. Walk known chart child tags; the first match wins.
  // Stripping the prefix / suffix gives us a clean identifier:
  //   'c:barChart' → 'bar', 'c:line3DChart' → 'line3D', 'c:pieChart' → 'pie'.
  let chartContainer: unknown | undefined;
  for (const tag of CHART_TYPE_TAGS) {
    const node = findChild(plotArea, tag);
    if (node) {
      const stripped = tag.replace(/^c:/, '').replace(/Chart$/, '');
      out.chartType = stripped;
      chartContainer = node;
      break;
    }
  }
  if (!chartContainer) return out;

  // H2 — categories + series. Walk every <c:ser>; per OOXML, scatter +
  // bubble charts use <c:xVal> + <c:yVal> instead of <c:cat> + <c:val>,
  // so handle both.
  const sers = toArray(findChild(chartContainer, 'c:ser'));
  const series: IChartSeries[] = [];
  let categories: string[] | undefined;
  for (const ser of sers) {
    if (!ser || typeof ser !== 'object') continue;
    const s: IChartSeries = { values: [] };

    // Series name — <c:tx> wraps either <c:strRef> (cell ref + cached
    // string) or a literal <c:v>.
    const tx = findChild(ser, 'c:tx');
    if (tx) {
      const strRef = findChild(tx, 'c:strRef');
      if (strRef) {
        const { values } = readChartCellValues(strRef, 'c:strCache');
        if (values.length > 0) s.name = values[0];
      } else {
        const v = findChild(tx, 'c:v');
        const txt = typeof v === 'string' ? v : (v && typeof v === 'object' ? ((v as XmlNode)['#text'] as string | undefined) : undefined);
        if (txt) s.name = txt;
      }
    }

    // Categories — read off the first series only (they repeat).
    if (categories === undefined) {
      const cat = findChild(ser, 'c:cat');
      if (cat) {
        const strRef = findChild(cat, 'c:strRef');
        const numRef = findChild(cat, 'c:numRef');
        if (strRef) categories = readChartCellValues(strRef, 'c:strCache').values;
        else if (numRef) categories = readChartCellValues(numRef, 'c:numCache').values;
      } else {
        // scatter / bubble — x-axis is the "category" for our purposes.
        const xVal = findChild(ser, 'c:xVal');
        if (xVal) {
          const numRef = findChild(xVal, 'c:numRef');
          if (numRef) categories = readChartCellValues(numRef, 'c:numCache').values;
        }
      }
    }

    // Values — y values for line/bar/pie/area/radar; yVal for scatter/bubble.
    const val = findChild(ser, 'c:val') ?? findChild(ser, 'c:yVal');
    if (val) {
      const numRef = findChild(val, 'c:numRef');
      if (numRef) s.values = readChartCellValues(numRef, 'c:numCache').numeric;
    }

    series.push(s);
  }
  if (categories && categories.length > 0) out.categories = categories;
  if (series.length > 0) out.series = series;
  return out;
}

// G1-G4 + H1 — graphicFrame dispatch. Returns a TABLE or CHART
// IPageElement based on the `<a:graphicData uri>` discriminator.
async function processGraphicFrame(
  gf: unknown,
  reg: ImageRegistry,
  groupXfrm: GroupXfrm,
  pageOrdinal: number,
  z: ZCounter,
): Promise<IPageElement | null> {
  // graphicFrame uses `<p:xfrm>` (not `<p:spPr><a:xfrm>`). Position +
  // size come from the same `<a:off>` / `<a:ext>` child structure.
  const xfrm = findChild(gf, 'p:xfrm');
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

  const graphic = findChild(gf, 'a:graphic');
  const graphicData = findChild(graphic, 'a:graphicData') as XmlNode | undefined;
  const uri = graphicData?.['@uri'];

  const zIndex = z.next;
  z.next += 1;

  // G1-G4 — table.
  const tbl = findChild(graphicData, 'a:tbl');
  if (tbl) {
    const elId = `s${pageOrdinal}-tbl-${zIndex}`;
    const table = parseTable(tbl, reg, elId);
    return {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: 6 as any, // PageElementType.TABLE (added via fork patch)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      table: table as any,
    } as unknown as IPageElement;
  }

  // H1 — chart. The chart payload (categories, series, type) lives in
  // ppt/charts/chartN.xml. We resolve the rId via slide rels to the
  // chart path inside the zip, then fetch + parse it into a structured
  // IChart (H2 + H3) so the UI can read chart type / series / values.
  // The full XML still rides via passthrough so authored fidelity
  // survives the round-trip.
  const chartNode = findChild(graphicData, 'c:chart') as XmlNode | undefined;
  if (chartNode && typeof uri === 'string' && uri.endsWith('/chart')) {
    const chartId = (chartNode['@r:id'] as string | undefined) ?? '';
    const chartTarget = chartId ? reg.imageRelMap.get(chartId) : undefined;
    const elId = `s${pageOrdinal}-chart-${zIndex}`;
    let structured: IChartStructured = { chartId, ...(chartTarget ? { chartPath: chartTarget } : {}) };
    if (chartTarget) {
      // chartTarget is rels-relative (e.g. '../charts/chart1.xml');
      // resolve against the slide's dir to a zip path.
      const chartPath = chartTarget.startsWith('/')
        ? chartTarget.slice(1)
        : resolveRelTarget(chartTarget, 'ppt/slides/');
      const chartXml = await reg.zip.file(chartPath)?.async('string');
      if (chartXml) {
        try {
          structured = parseChartXml(chartXml, chartId, chartTarget);
        } catch {
          // Malformed chart XML — fall back to id-only. Authored payload
          // still survives via passthrough so the export round-trip is
          // unaffected.
        }
      }
    }
    return {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: 7 as any, // PageElementType.CHART
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chart: structured as any,
    } as unknown as IPageElement;
  }

  return null;
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
  // E3 — image cropping. `<a:srcRect l="…" t="…" r="…" b="…"/>` carries
  // crop offsets as percentages * 1000 (e.g. l="25000" = 25 % from
  // left). Univer's `cropProperties` uses normalised fractions (0..1)
  // matching what the renderer expects.
  const srcRect = findChild(blipFill, 'a:srcRect') as XmlNode | undefined;
  let cropProperties: { offsetLeft: number; offsetRight: number; offsetTop: number; offsetBottom: number; angle: number } | null = null;
  if (srcRect) {
    const readPct = (key: string): number => {
      const v = srcRect[key];
      if (v === undefined) return 0;
      const n = parseInt(String(v), 10);
      return Number.isFinite(n) ? n / 100_000 : 0;
    };
    const cropL = readPct('@l');
    const cropT = readPct('@t');
    const cropR = readPct('@r');
    const cropB = readPct('@b');
    if (cropL || cropT || cropR || cropB) {
      cropProperties = {
        offsetLeft: cropL,
        offsetRight: cropR,
        offsetTop: cropT,
        offsetBottom: cropB,
        angle: 0,
      };
    }
  }
  const blip = findChild(blipFill, 'a:blip') as XmlNode | undefined;
  const rEmbed = blip?.['@r:embed'] as string | undefined;
  const rLink = blip?.['@r:link'] as string | undefined;

  // E4 — `<a:blip><a:alphaModFix amt="N"/></a:blip>` (where `amt` is in
  // thousandths of a percent — 50000 = 50 %) keeps `amt` of the
  // original alpha. Univer's `IImageProperties.transparency` is the
  // *removed* fraction (0..1), so we invert: transparency = 1 - amt/100000.
  // Absent attribute = fully opaque (transparency 0), so we omit the
  // field entirely.
  const alphaModFix = findChild(blip, 'a:alphaModFix') as XmlNode | undefined;
  let transparency: number | undefined;
  if (alphaModFix) {
    const amtRaw = alphaModFix['@amt'];
    const amt = typeof amtRaw === 'string' || typeof amtRaw === 'number'
      ? parseInt(String(amtRaw), 10)
      : 100_000;
    if (Number.isFinite(amt) && amt < 100_000) {
      transparency = Math.max(0, Math.min(1, 1 - amt / 100_000));
    }
  }

  // E5 — image colour adjust children of `<a:blip>`:
  //   <a:lum bright="N" contrast="N"/> — N is thousandths of a percent
  //                                      (e.g. 20000 = +20 %, -10000 = -10 %).
  //                                      Both attrs are independent and
  //                                      either may be absent (defaults 0).
  //   <a:grayscl/>                     — render the image as grayscale.
  //                                      Univer has no native grayscale flag;
  //                                      we approximate via brightness=-1
  //                                      sentinel + a duotone-like reduction
  //                                      is too aggressive, so we instead
  //                                      stash `grayscale: true` under
  //                                      imageProperties for future renderer
  //                                      work. Doesn't affect existing
  //                                      brightness / contrast consumers.
  //   <a:duotone>…</a:duotone>          — two-colour map; we capture the
  //                                      pair of resolved hexes as
  //                                      imageProperties.duotone = [hex, hex]
  //                                      so the renderer can apply the
  //                                      duotone shader (also additive —
  //                                      brightness / contrast still flow).
  // PowerPoint stores brightness / contrast as signed fractions: -1..1
  // after dividing by 100000. Univer's IImageProperties has plain
  // `brightness` + `contrast` numbers — pass through the fractional form
  // since the renderer interprets sign + magnitude.
  let brightness: number | undefined;
  let contrast: number | undefined;
  const lum = findChild(blip, 'a:lum') as XmlNode | undefined;
  if (lum) {
    const brightRaw = lum['@bright'];
    if (brightRaw !== undefined) {
      const n = parseInt(String(brightRaw), 10);
      if (Number.isFinite(n) && n !== 0) brightness = n / 100_000;
    }
    const contrastRaw = lum['@contrast'];
    if (contrastRaw !== undefined) {
      const n = parseInt(String(contrastRaw), 10);
      if (Number.isFinite(n) && n !== 0) contrast = n / 100_000;
    }
  }
  const grayscale = findChild(blip, 'a:grayscl') !== undefined;
  const duotoneNode = findChild(blip, 'a:duotone') as XmlNode | undefined;
  let duotone: [string, string] | undefined;
  if (duotoneNode) {
    // <a:duotone> contains two colour-choice children (srgbClr / schemeClr).
    // fast-xml-parser groups same-named children into arrays — read both
    // by scanning known carriers.
    const colours: string[] = [];
    for (const tag of ['a:srgbClr', 'a:schemeClr', 'a:prstClr', 'a:sysClr'] as const) {
      const nodes = toArray((duotoneNode as XmlNode)[tag]);
      for (const node of nodes) {
        if (!node) continue;
        // Wrap under the original tag so readColor's direct-child path can
        // pick it up.
        const wrapped = { [tag]: node } as XmlNode;
        const col = readColor(wrapped, reg.theme);
        if (col) colours.push(col);
      }
      if (colours.length >= 2) break;
    }
    if (colours.length >= 2) duotone = [colours[0], colours[1]];
  }

  // E2 — linked images. `<a:blip r:link="rIdN"/>` resolves to an
  // external Target URL via the slide's rels (rather than embedded
  // bytes under `ppt/media/`). For http(s) URLs we pass the URL
  // through to `imageProperties.contentUrl` directly — no fetch, no
  // data-URI conversion. Local-path links (unusual, point at the
  // author's filesystem) are skipped.
  let contentUrl: string | null = null;
  if (rEmbed) {
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
    contentUrl = dataUri;
  } else if (rLink) {
    const linkTarget = reg.imageRelMap.get(rLink);
    if (!linkTarget) return null;
    if (/^https?:\/\//i.test(linkTarget)) {
      contentUrl = linkTarget;
    } else {
      // Local-path link — we don't load author-filesystem assets.
      return null;
    }
  } else {
    return null;
  }

  // E6 — image effectLst (drop shadow, glow, reflection, blur). Same
  // decoder as the wave-7m shape effectLst; lands on
  // imageProperties.effectLst (additive — Univer's IImageProperties
  // doesn't declare the field but the renderer can read it off the
  // pageElement and Object.assign with the future fork patch).
  const picSpPr = findChild(pic, 'p:spPr');
  const picEffectLst = parseEffectList(picSpPr, reg.theme);

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
      imageProperties: {
        contentUrl,
        ...(cropProperties ? { cropProperties } : {}),
        ...(transparency !== undefined ? { transparency } : {}),
        ...(brightness !== undefined ? { brightness } : {}),
        ...(contrast !== undefined ? { contrast } : {}),
        ...(grayscale ? { grayscale: true } : {}),
        ...(duotone ? { duotone } : {}),
        ...(picEffectLst ? { effectLst: picEffectLst } : {}),
      } as any,
    },
  };
}

// Extract NON-placeholder shapes from a slideLayout or slideMaster XML
// as background-layer page elements. Placeholders are inherited via
// the I3/I4 path; this picks up decorative shapes (e.g. the orange
// right-half rectangle on Google Slides' SECTION_TITLE layout that
// makes layout-driven backdrops appear).
//
// Returns elements with their own sort scope (already sorted by source
// XML order); caller stacks them BELOW the slide's own elements.
async function extractBgShapesFromXml(
  xml: string,
  zip: JSZip,
  xmlPath: string,
  baseReg: ImageRegistry,
  pageOrdinal: number,
  rootTag: 'p:sldLayout' | 'p:sldMaster',
  idPrefix: string,
): Promise<IPageElement[]> {
  // Build a per-source ImageRegistry — same zip / theme / caches but
  // with the layout's (or master's) own image rels, since `<p:pic>`
  // r:embed refs point at this part's rels file, not the slide's.
  const dir = xmlPath.slice(0, xmlPath.lastIndexOf('/') + 1);
  const name = xmlPath.split('/').pop() ?? '';
  const relsPath = `${dir}_rels/${name}.rels`;
  const relsXml = await zip.file(relsPath)?.async('string');
  const imageRelMap = relsXml ? extractRelMap(relsXml) : new Map<string, string>();
  const bgReg: ImageRegistry = { ...baseReg, imageRelMap };

  const parsed = parser.parse(xml) as XmlNode;
  const spTree = findChild(findChild(findChild(parsed, rootTag), 'p:cSld'), 'p:spTree');
  const elements: IPageElement[] = [];
  const z: ZCounter = { next: 1 };

  let spTreeOrderedChildren: unknown[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ordered = orderedParser.parse(xml) as unknown as Array<Record<string, unknown>>;
    const root = ordered.find((c) => c && rootTag in (c as Record<string, unknown>)) as Record<string, unknown> | undefined;
    const rootChildren = root ? (root[rootTag] as unknown[]) : [];
    const cSld = rootChildren.find((c) => c && typeof c === 'object' && 'p:cSld' in (c as Record<string, unknown>)) as Record<string, unknown> | undefined;
    const cSldChildren = cSld ? (cSld['p:cSld'] as unknown[]) : [];
    const spTreeNode = cSldChildren.find((c) => c && typeof c === 'object' && 'p:spTree' in (c as Record<string, unknown>)) as Record<string, unknown> | undefined;
    if (spTreeNode) {
      const v = spTreeNode['p:spTree'];
      if (Array.isArray(v)) spTreeOrderedChildren = v as unknown[];
    }
  } catch { /* fallback to legacy order */ }

  await processSpTree(spTree, bgReg, pageOrdinal, IDENTITY_XFRM, z, elements, spTreeOrderedChildren, [], /* skipPlaceholders */ true);

  // Sort + strip _sourceRank like extractElementsFromSlideXml does, but
  // KEEP zIndex unstamped — caller will renumber across both bg and
  // slide elements.
  const lexCompare = (a: number[], b: number[]) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  };
  elements.sort((a, b) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ra = ((a as any)._sourceRank as number[] | undefined) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rb = ((b as any)._sourceRank as number[] | undefined) ?? [];
    return lexCompare(ra, rb);
  });
  elements.forEach((el) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (el as any)._sourceRank;
    // Re-stamp the id with the bg prefix so debugging / dedup tools
    // can tell layout / master shapes apart from slide-authored ones.
    el.id = `${idPrefix}-${el.id}`;
  });

  return elements;
}

// Walk slide → layout (and master) rels to extract decorative shapes
// from each level. Returned elements are stacked layout-shapes-first,
// then master-shapes (master shapes paint OVER layout if both have
// content — matches PowerPoint's inheritance: layout overrides master).
// Wait — PowerPoint actually paints master FIRST (bottom-most), then
// layout on top of master. We honour that.
async function extractInheritedBgShapes(
  slideRelsXml: string | null,
  zip: JSZip,
  baseReg: ImageRegistry,
  pageOrdinal: number,
): Promise<IPageElement[]> {
  if (!slideRelsXml) return [];
  const result: IPageElement[] = [];

  const layoutTarget = findRelTargetByType(slideRelsXml, '/slideLayout');
  if (!layoutTarget) return result;
  const layoutPath = resolveRelTarget(layoutTarget, 'ppt/slides/');
  const layoutXml = await zip.file(layoutPath)?.async('string');
  if (!layoutXml) return result;

  // Layout rels → master path
  const layoutDir = layoutPath.slice(0, layoutPath.lastIndexOf('/') + 1);
  const layoutName = layoutPath.split('/').pop() ?? '';
  const layoutRelsXml = await zip.file(`${layoutDir}_rels/${layoutName}.rels`)?.async('string');
  let masterShapes: IPageElement[] = [];
  if (layoutRelsXml) {
    const masterTarget = findRelTargetByType(layoutRelsXml, '/slideMaster');
    if (masterTarget) {
      const masterPath = resolveRelTarget(masterTarget, layoutDir);
      const masterXml = await zip.file(masterPath)?.async('string');
      if (masterXml) {
        masterShapes = await extractBgShapesFromXml(masterXml, zip, masterPath, baseReg, pageOrdinal, 'p:sldMaster', 'master');
      }
    }
  }
  const layoutShapes = await extractBgShapesFromXml(layoutXml, zip, layoutPath, baseReg, pageOrdinal, 'p:sldLayout', 'layout');

  // Master first (lowest z), then layout on top of master.
  return [...masterShapes, ...layoutShapes];
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

  // Pull spTree's preserveOrder children so processSpTree can stamp
  // each pushed element with its source-XML DOM rank. OOXML's z-order
  // is determined by child order within spTree (later child = painted
  // on top); our previous type-grouped loops collapsed that order, so
  // text frames painted under images that appeared LATER in the source.
  let spTreeOrderedChildren: unknown[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ordered = orderedParser.parse(slideXml) as unknown as Array<Record<string, unknown>>;
    const sld = ordered.find((c) => c && 'p:sld' in c);
    const sldChildren = sld ? (sld['p:sld'] as unknown[]) : [];
    const cSld = sldChildren.find((c) => c && typeof c === 'object' && 'p:cSld' in (c as Record<string, unknown>)) as Record<string, unknown> | undefined;
    const cSldChildren = cSld ? (cSld['p:cSld'] as unknown[]) : [];
    const spTreeNode = cSldChildren.find((c) => c && typeof c === 'object' && 'p:spTree' in (c as Record<string, unknown>)) as Record<string, unknown> | undefined;
    if (spTreeNode) {
      const v = spTreeNode['p:spTree'];
      if (Array.isArray(v)) spTreeOrderedChildren = v as unknown[];
    }
  } catch {
    // If preserveOrder parse fails for any reason, fall back to the
    // legacy type-grouped behaviour (elements still appear, just with
    // wrong z-stacking on slides that interleave types).
    spTreeOrderedChildren = [];
  }

  await processSpTree(spTree, reg, pageOrdinal, IDENTITY_XFRM, z, elements, spTreeOrderedChildren, []);

  // Sort by composite _sourceRank (lexicographic on number arrays) and
  // re-assign zIndex monotonically so the slides renderer paints in
  // source-XML order. Strip the _sourceRank field before returning.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lexCompare = (a: number[], b: number[]) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  };
  elements.sort((a, b) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ra = ((a as any)._sourceRank as number[] | undefined) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rb = ((b as any)._sourceRank as number[] | undefined) ?? [];
    return lexCompare(ra, rb);
  });
  elements.forEach((el, i) => {
    el.zIndex = i + 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (el as any)._sourceRank;
  });

  return elements;
}

// I5 — collect the set of placeholder types declared in the slide's own
// `<p:spTree>`. Used to decide which service placeholders (ftr / dt /
// sldNum) need to be synthesised from the layout / master.
function extractSlideDeclaredPlaceholderTypes(slideXml: string): Set<string> {
  const declared = new Set<string>();
  const parsed = parser.parse(slideXml) as XmlNode;
  const spTree = findChild(findChild(findChild(parsed, 'p:sld'), 'p:cSld'), 'p:spTree');
  if (!spTree) return declared;
  const walk = (tree: unknown): void => {
    for (const sp of toArray(findChild(tree, 'p:sp'))) {
      if (!sp || typeof sp !== 'object') continue;
      const ph = findChild(findChild(findChild(sp, 'p:nvSpPr'), 'p:nvPr'), 'p:ph') as XmlNode | undefined;
      const t = ph?.['@type'];
      if (typeof t === 'string') declared.add(t);
    }
    for (const grp of toArray(findChild(tree, 'p:grpSp'))) walk(grp);
  };
  walk(spTree);
  return declared;
}

// A2 — read `<p:cSld><p:bg>` for the slide background. Resolves both
// `<p:bgPr><a:solidFill><a:srgbClr>` and `<p:bgPr><a:solidFill><a:schemeClr>`
// (J2) — the latter via the theme map. Gradient (`<a:gradFill>`),
// picture (`<a:blipFill>`), and `<p:bgRef>` (theme background indexes)
// are deferred to later waves (A3 / A4 / A5-ref).
// A6 — `<p:sld show="0">` (or `show="false"`) marks the slide as hidden.
// We pass through to `ISlideProperties.isSkipped` so renderers / present
// modes can honour it. Absent attribute and `show="1"` / `"true"` both
// mean visible (the OOXML default).
function extractSlideHidden(slideXml: string): boolean {
  const parsed = parser.parse(slideXml) as XmlNode;
  const sld = findChild(parsed, 'p:sld') as XmlNode | undefined;
  const show = sld?.['@show'];
  return show === '0' || show === 0 || show === 'false';
}

// K4 — per-slide header / footer / date / slide-number toggles.
// OOXML lets a slide carry `<p:hf sldNum="0|1" hdr="0|1" ftr="0|1"
// dt="0|1"/>` (defaults to "1" when omitted — i.e. show that placeholder
// if the layout/master declared one). When the slide opts out (sets a
// flag to "0"), we skip synthesising the matching service placeholder
// from the master even though I5 would otherwise emit it.
//
// PowerPoint also uses these toggles on layouts + masters; we read only
// the slide-level version since the service-placeholder synthesis in I5
// is driven by the slide's intent. Most decks rely on the default
// (everything visible), so the function returns a Set of types the
// slide explicitly opts OUT of.
type HfFlag = 'ftr' | 'dt' | 'sldNum';
function extractSlideHfOptOuts(slideXml: string): Set<HfFlag> {
  const out = new Set<HfFlag>();
  const parsed = parser.parse(slideXml) as XmlNode;
  const sld = findChild(parsed, 'p:sld') as XmlNode | undefined;
  const hf = findChild(sld, 'p:hf') as XmlNode | undefined;
  if (!hf) return out;
  const isOff = (v: unknown): boolean => v === '0' || v === 0 || v === 'false';
  if (isOff(hf['@ftr'])) out.add('ftr');
  if (isOff(hf['@dt'])) out.add('dt');
  if (isOff(hf['@sldNum'])) out.add('sldNum');
  return out;
}

// Read the `<p:cSld><p:bg>` block off any root (`<p:sld>`,
// `<p:sldLayout>`, `<p:sldMaster>`). Returns the resolved hex colour
// or null.
//
// PowerPoint's <p:bg> wraps one of:
//   <p:bgPr>  — direct fill (solidFill, gradFill, blipFill — pictures
//               handled separately via extractSlideBackgroundImage).
//   <p:bgRef idx="…"> — index into theme's `<a:bgFillStyleLst>`. The
//                       inner <a:schemeClr> tints whatever the indexed
//                       entry produces. For our v1 we resolve the
//                       inner schemeClr directly — that's the colour
//                       PowerPoint actually paints in most templates.
//                       Full bgFillStyleLst lookup is a follow-up.
function extractBgFromXml(xml: string, theme: ThemeMap | null): string | null {
  const parsed = parser.parse(xml) as XmlNode;
  const root =
    (findChild(parsed, 'p:sld') as XmlNode | undefined) ??
    (findChild(parsed, 'p:sldLayout') as XmlNode | undefined) ??
    (findChild(parsed, 'p:sldMaster') as XmlNode | undefined);
  if (!root) return null;
  const cSld = findChild(root, 'p:cSld');
  const bg = findChild(cSld, 'p:bg');
  if (!bg) return null;
  const bgPr = findChild(bg, 'p:bgPr');
  if (bgPr) return readColor(bgPr, theme) ?? parseSrgbColor(bgPr);
  // A5-idx — `<p:bgRef idx>` carries an inline schemeClr/srgbClr child
  // (no <a:solidFill> wrapper). resolveSchemeColor handles bare
  // schemeClr; an inline srgbClr falls through to parseSrgbColor
  // (which also accepts the unwrapped form).
  const bgRef = findChild(bg, 'p:bgRef') as XmlNode | undefined;
  if (bgRef) {
    // A5-idx — when bgRef carries an `@idx`, the indexed fill in the
    // theme's `<a:fmtScheme>` is what PowerPoint actually paints. The
    // inner `<a:schemeClr>` on the bgRef is a colour seed for the
    // indexed style (some styles tint or recolour the entry); we let
    // the indexed entry win because that matches the rendered output
    // for the overwhelming majority of authored decks.
    if (bgRef['@idx'] !== undefined) {
      const indexed = resolveBgRefIdx(bgRef, theme);
      if (indexed) return indexed;
    }
    const schemed = resolveSchemeColor(bgRef, theme);
    if (schemed) return schemed;
    // Bare srgbClr child (rare on bgRef but legal).
    const srgb = findChild(bgRef, 'a:srgbClr') as XmlNode | undefined;
    const val = srgb?.['@val'];
    if (typeof val === 'string' && /^[0-9a-fA-F]{6}$/.test(val)) {
      return applyColorModifiers(`#${val.toUpperCase()}`, srgb);
    }
  }
  return null;
}

// A3 — slide-background gradient harvest. Walks the same slide → layout
// → master chain as resolveSlideBackground but returns the full
// gradient stops when the bg uses `<a:gradFill>`. Renderer-side picks
// this up; the existing hex-only resolveSlideBackground still answers
// the IColorStyle slot with the degraded first-stop colour.
function extractBgGradientFromXml(xml: string, theme: ThemeMap | null): IGradientFill | null {
  const parsed = parser.parse(xml) as XmlNode;
  const root =
    (findChild(parsed, 'p:sld') as XmlNode | undefined) ??
    (findChild(parsed, 'p:sldLayout') as XmlNode | undefined) ??
    (findChild(parsed, 'p:sldMaster') as XmlNode | undefined);
  if (!root) return null;
  const cSld = findChild(root, 'p:cSld');
  const bg = findChild(cSld, 'p:bg');
  if (!bg) return null;
  const bgPr = findChild(bg, 'p:bgPr');
  if (bgPr) {
    const grad = readGradientStops(bgPr, theme);
    if (grad) return grad;
  }
  // bgRef → bgFillStyleLst entry can itself be a gradient.
  const bgRef = findChild(bg, 'p:bgRef') as XmlNode | undefined;
  if (bgRef && theme) {
    const cache = themeFmtSchemeCache.get(theme);
    if (cache) {
      const idxRaw = bgRef['@idx'];
      const idx = idxRaw !== undefined ? parseInt(String(idxRaw), 10) : NaN;
      let entry: XmlNode | undefined;
      if (Number.isFinite(idx)) {
        if (idx >= 1001) entry = cache.bgFillStyleLst[idx - 1001];
        else if (idx >= 1) entry = cache.fillStyleLst[idx - 1];
      }
      if (entry) {
        const grad = readGradientStops(entry, theme);
        if (grad) return grad;
      }
    }
  }
  return null;
}

async function resolveSlideBackgroundGradient(
  slideXml: string,
  slideRelsXml: string | null,
  zip: JSZip,
  theme: ThemeMap | null,
): Promise<IGradientFill | null> {
  const own = extractBgGradientFromXml(slideXml, theme);
  if (own) return own;
  if (!slideRelsXml) return null;
  const layoutTarget = findRelTargetByType(slideRelsXml, '/slideLayout');
  if (!layoutTarget) return null;
  const layoutPath = resolveRelTarget(layoutTarget, 'ppt/slides/');
  const layoutXml = await zip.file(layoutPath)?.async('string');
  if (layoutXml) {
    const lay = extractBgGradientFromXml(layoutXml, theme);
    if (lay) return lay;
  }
  const layoutDir = layoutPath.slice(0, layoutPath.lastIndexOf('/') + 1);
  const layoutName = layoutPath.split('/').pop() ?? '';
  const layoutRelsXml = await zip.file(`${layoutDir}_rels/${layoutName}.rels`)?.async('string');
  if (!layoutRelsXml) return null;
  const masterTarget = findRelTargetByType(layoutRelsXml, '/slideMaster');
  if (!masterTarget) return null;
  const masterPath = resolveRelTarget(masterTarget, layoutDir);
  const masterXml = await zip.file(masterPath)?.async('string');
  if (!masterXml) return null;
  return extractBgGradientFromXml(masterXml, theme);
}

// I6 — slide background inheritance. PowerPoint themes routinely put
// `<p:bg>` on the slideMaster or slideLayout, not the slide. Without
// inheritance, every themed deck imports as a stack of white slides.
// Walks slide → layout → master, returning the first non-null bg.
async function resolveSlideBackground(
  slideXml: string,
  slideRelsXml: string | null,
  zip: JSZip,
  theme: ThemeMap | null,
): Promise<string | null> {
  // 1. Slide's own bg (A2).
  const own = extractBgFromXml(slideXml, theme);
  if (own) return own;

  if (!slideRelsXml) return null;

  // 2. Layout's bg (I6 — first inheritance step).
  const layoutTarget = findRelTargetByType(slideRelsXml, '/slideLayout');
  if (!layoutTarget) return null;
  const layoutPath = resolveRelTarget(layoutTarget, 'ppt/slides/');
  const layoutXml = await zip.file(layoutPath)?.async('string');
  if (layoutXml) {
    const lay = extractBgFromXml(layoutXml, theme);
    if (lay) return lay;
  }

  // 3. Master's bg (I6 — second inheritance step).
  const layoutDir = layoutPath.slice(0, layoutPath.lastIndexOf('/') + 1);
  const layoutName = layoutPath.split('/').pop() ?? '';
  const layoutRelsXml = await zip.file(`${layoutDir}_rels/${layoutName}.rels`)?.async('string');
  if (!layoutRelsXml) return null;
  const masterTarget = findRelTargetByType(layoutRelsXml, '/slideMaster');
  if (!masterTarget) return null;
  const masterPath = resolveRelTarget(masterTarget, layoutDir);
  const masterXml = await zip.file(masterPath)?.async('string');
  if (!masterXml) return null;
  return extractBgFromXml(masterXml, theme);
}


// A4 — picture background. Univer's `ISlidePage.pageBackgroundFill` is
// an `IColorStyle` and can't carry an image, so we synthesise a backdrop
// IMAGE element at z-index 0 covering the whole slide. The other element
// extractors start their ZCounter at 1, so a z=0 IMAGE always sits below
// the authored content. Stretch / tile / `<a:srcRect>` on bgPr deferred;
// first pass renders edge-to-edge stretch which matches the most common
// authoring intent.
async function extractSlideBackgroundImage(
  slideXml: string,
  reg: ImageRegistry,
  pageOrdinal: number,
  pageSize: { width: number; height: number },
): Promise<IPageElement | null> {
  const parsed = parser.parse(slideXml) as XmlNode;
  const cSld = findChild(findChild(parsed, 'p:sld'), 'p:cSld');
  const bg = findChild(cSld, 'p:bg');
  if (!bg) return null;
  const bgPr = findChild(bg, 'p:bgPr');
  if (!bgPr) return null;
  const blipFill = findChild(bgPr, 'a:blipFill');
  if (!blipFill) return null;
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

  return {
    id: `s${pageOrdinal}-bg`,
    zIndex: 0,
    left: 0,
    top: 0,
    width: pageSize.width,
    height: pageSize.height,
    angle: 0,
    flipX: false,
    flipY: false,
    title: '',
    description: '',
    type: PageElementType.IMAGE,
    image: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      imageProperties: {
        contentUrl: dataUri,
      } as any,
    },
  };
}

// K3 — `<p:presentation><p:defaultTextStyle>` carries per-level
// (`<p:lvl1pPr>`, `<p:lvl2pPr>`, …) `<a:defRPr>` defaults that apply
// when nothing else up the chain (run → paragraph → placeholder layout
// → placeholder master) supplies an override. PowerPoint uses this for
// "all-text on this deck defaults to Calibri 18 pt" style settings.
//
// We parse the `<p:lvl1pPr><a:defRPr>` only — matching the existing I4
// behaviour where lvl1 is treated as the canonical placeholder default.
// Deeper levels (lvl2pPr etc.) would matter when we surface a richer
// per-level cascade; that's deferred.
//
// Returned as `Partial<ISlideRichTextProps>` so it slots in alongside
// `phInherited?.defaultRunProps`. Layout/master placeholder defaults
// still win on top (per OOXML order: deck-level < master < layout <
// slide / run).
function extractDeckDefaultRunProps(presentation: XmlNode | undefined, theme: ThemeMap | null): Partial<ISlideRichTextProps> | undefined {
  const dts = findChild(presentation, 'p:defaultTextStyle') as XmlNode | undefined;
  if (!dts) return undefined;
  const lvl1pPr = findChild(dts, 'a:lvl1pPr') as XmlNode | undefined;
  const defRPr = findChild(lvl1pPr, 'a:defRPr');
  if (!defRPr) return undefined;
  const parsed = parseRunProps(defRPr, theme);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

// K1 — read `docProps/core.xml` for `<dc:title>`. When present (and
// non-empty), this becomes the deck's display title instead of the
// filename. Other metadata (creator / description / subject) is
// captured here too in case future UI surfaces them; for now we only
// thread the title back into `snapshot.title`.
function extractCoreProps(coreXml: string): { title?: string; creator?: string; description?: string; subject?: string } {
  const out: { title?: string; creator?: string; description?: string; subject?: string } = {};
  const parsed = parser.parse(coreXml) as XmlNode;
  const root = findChild(parsed, 'cp:coreProperties') as XmlNode | undefined;
  if (!root) return out;
  const readText = (key: string): string | undefined => {
    const node = findChild(root, key);
    if (typeof node === 'string') return node;
    if (node && typeof node === 'object') {
      const t = (node as XmlNode)['#text'];
      if (typeof t === 'string') return t;
    }
    return undefined;
  };
  const title = readText('dc:title');
  const creator = readText('dc:creator');
  const description = readText('dc:description');
  const subject = readText('dc:subject');
  if (title && title.length > 0) out.title = title;
  if (creator && creator.length > 0) out.creator = creator;
  if (description && description.length > 0) out.description = description;
  if (subject && subject.length > 0) out.subject = subject;
  return out;
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

  // K1 — `docProps/core.xml` → snapshot.title (via <dc:title>). When
  // absent / empty, we fall back to the filename below. Reading happens
  // up here so it's available alongside pageSize before the slide loop.
  const coreXml = await zip.file('docProps/core.xml')?.async('string');
  const coreProps = coreXml ? extractCoreProps(coreXml) : {};

  // K2 — `docProps/custom.xml` is the schema-defined slot for author-
  // attached custom metadata (`<Properties><property name="…">…</property>`).
  // We don't parse it — just capture the XML bytes for the passthrough
  // round-trip so author-defined fields survive an open/save cycle.
  const customPropsXml = await zip.file('docProps/custom.xml')?.async('string');

  // K3 — `<p:presentation><p:defaultTextStyle>` lvl1pPr/defRPr → the
  // lowest-priority text defaults. Layout/master placeholder defaults
  // still win on top; this only kicks in when nothing else in the
  // placeholder / run chain supplies an override (e.g. a free-floating
  // text frame with a bare `<a:r>`). We pass `null` for theme here so
  // any schemeClr references inside the defRPr fall through; this is
  // rare in practice and matches the "no theme on docProps" defaults
  // most decks emit.
  const deckDefaultRunProps = extractDeckDefaultRunProps(presentation, null);

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

  // I1 + I2 + J1 — capture raw OOXML for layouts / masters / themes so
  // the round-trip can re-emit parts we don't natively model. Stored on
  // ISlideData.resources under CASUAL_SLIDES_PPTX_RAW (matches the
  // ARCHITECTURE.md plan). Keyed by zip-path so the export side can
  // splice them back in unchanged.
  //
  // Wave 7n — also capture notesSlides (A9), comments (K5),
  // diagrams (K7 SmartArt), and ink (K8) plus their `_rels` files
  // so the export side can restore them verbatim. PptxGenJS doesn't
  // touch any of these categories, so the inject-on-export pass can
  // splice them in without breaking the generated zip.
  const rawLayouts: Record<string, string> = {};
  const rawMasters: Record<string, string> = {};
  const rawThemes: Record<string, string> = {};
  const rawNotesSlides: Record<string, string> = {};
  const rawComments: Record<string, string> = {};
  const rawDiagrams: Record<string, string> = {};
  const rawInk: Record<string, string> = {};
  // H1 — `ppt/charts/chartN.xml` carries the chart's full series + style.
  // Captured via passthrough and re-injected on export so the round-trip
  // preserves authored charts even though our IChart only stores the rId.
  const rawCharts: Record<string, string> = {};
  const rawRels: Record<string, string> = {};
  // K6 — binary parts (audio / video media + chart-embedded xlsx).
  // Captured as base64 because the resources slot is JSON-stringified
  // and JSON can't carry raw bytes. `restorePassthrough` decodes back
  // to binary before writing to the exported zip. Covers
  // `ppt/media/*` (images are also under here, but they're already
  // captured per-element via processPicNode → contentUrl; the
  // duplication here is fine — zip.file() overwrites) and
  // `ppt/embeddings/*` (chart data xlsx + ole-object payloads).
  const rawMediaBin: Record<string, string> = {};

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

    const reg: ImageRegistry = { imageRelMap, cache: imageCache, zip, placeholderRects, theme, deckDefaultRunProps };
    const pageOrdinal = i + 1;
    const pageId = `page-${pageOrdinal}`;
    // Layout / master decorative shapes (non-placeholder) inherit as a
    // background layer painted UNDER slide-authored content. Without
    // this, slides built on themed layouts (e.g. Google Slides
    // SECTION_TITLE layout with an orange right-half rectangle) come
    // out with a plain white right half and the silhouette images
    // floating against nothing.
    const bgShapes = await extractInheritedBgShapes(slideRelsXml, zip, reg, pageOrdinal);
    const elements = await extractElementsFromSlideXml(slideXml, reg, pageOrdinal);
    // Concatenate bg + slide; reassign zIndex monotonically so bg
    // paints first (lowest z) and slide paints on top.
    const allElements = [...bgShapes, ...elements];
    allElements.forEach((el, idx) => { el.zIndex = idx + 1; });
    const elementMap: Record<string, IPageElement> = {};
    for (const el of allElements) elementMap[el.id] = el;

    // I5 — synthesise footer / date / slide-number placeholders from the
    // layout / master when the slide doesn't declare them. K4 — honour
    // the per-slide `<p:hf sldNum="0|1" ftr="0|1" dt="0|1"/>` toggles so
    // a slide that opts out of (say) the page-number doesn't get the
    // synthesised one painted on top.
    const declaredPhTypes = extractSlideDeclaredPlaceholderTypes(slideXml);
    const hfOptOuts = extractSlideHfOptOuts(slideXml);
    const servicePhs = await buildServicePlaceholders(slideRelsXml, zip, theme);
    let serviceCounter = 0;
    for (const [phType, svc] of servicePhs) {
      if (declaredPhTypes.has(phType)) continue;
      if (hfOptOuts.has(phType)) continue;
      serviceCounter += 1;
      const elId = `s${pageOrdinal}-svc-${phType}-${serviceCounter}`;
      // C18 — `<a:fld type="slidenum">` carries the literal placeholder
      // text ‹#› (OOXML's slide-number sentinel; PptxGenJS uses
      // `<#>`). PowerPoint and LibreOffice substitute the actual slide
      // number at render time. We do the substitution at import time
      // for sldNum service placeholders so the rendered text shows the
      // real page number instead of the sentinel. Date and footer
      // placeholders keep their authored content (footer is user text;
      // date sentinels are a follow-up — would need locale + format).
      const SLIDENUM_RX = /[‹<]#[›>]/g;
      const substitute = phType === 'sldNum'
        ? (s: string) => s.replace(SLIDENUM_RX, String(pageOrdinal))
        : (s: string) => s;
      const substitutedText = substitute(svc.text);
      // If we have a rich body, the same substitution has to happen on
      // dataStream + every textRun's [st, ed] needs adjusting because
      // ‹#› (3 chars) → "1" (1-2 chars) shifts indices. Easiest: rewrite
      // the dataStream and the runs in one pass.
      let substitutedRich: IDocumentData | undefined;
      if (svc.rich) {
        const body = svc.rich.body;
        if (body && typeof body.dataStream === 'string' && SLIDENUM_RX.test(body.dataStream)) {
          // Build a delta map: char index → cumulative shift after that
          // index. Then walk runs and adjust.
          const replaced = String(pageOrdinal);
          // Find every occurrence of ‹#› and pre-compute resulting indices.
          const matches: Array<{ start: number; len: number }> = [];
          // Reset the regex (it has /g state).
          const rx = /[‹<]#[›>]/g;
          let m: RegExpExecArray | null;
          while ((m = rx.exec(body.dataStream)) !== null) {
            matches.push({ start: m.index, len: m[0].length });
          }
          const shiftAt = (idx: number) => {
            let delta = 0;
            for (const mt of matches) {
              if (mt.start + mt.len <= idx) delta += replaced.length - mt.len;
              else if (mt.start < idx) delta += replaced.length - (idx - mt.start);
            }
            return delta;
          };
          const newDataStream = body.dataStream.replace(SLIDENUM_RX, replaced);
          const newTextRuns = (body.textRuns ?? []).map((r) => ({
            ...r,
            st: r.st + shiftAt(r.st),
            ed: r.ed + shiftAt(r.ed),
          }));
          const newParagraphs = (body.paragraphs ?? []).map((p) => ({
            ...p,
            startIndex: p.startIndex + shiftAt(p.startIndex),
          }));
          substitutedRich = {
            ...svc.rich,
            id: `${elId}-doc`,
            body: { ...body, dataStream: newDataStream, textRuns: newTextRuns, paragraphs: newParagraphs },
          };
        } else {
          substitutedRich = { ...svc.rich, id: `${elId}-doc` };
        }
      }
      const richText: ISlideRichTextProps = {
        text: substitutedText,
        ...svc.props,
        ...(substitutedRich ? { rich: substitutedRich } : {}),
      } as ISlideRichTextProps;
      // Service placeholders sit ABOVE the authored content so the
      // footer / page number paints over a backdrop image. zIndex picks
      // up from the slide's last element + 1 to keep tree order intact.
      const maxZ = elements.reduce((m, e) => Math.max(m, e.zIndex), 0);
      elementMap[elId] = {
        id: elId,
        zIndex: maxZ + serviceCounter,
        left: svc.rect.left,
        top: svc.rect.top,
        width: svc.rect.width,
        height: svc.rect.height,
        angle: 0,
        flipX: false,
        flipY: false,
        title: '',
        description: '',
        type: PageElementType.TEXT,
        richText,
      };
    }

    // A4 — picture background. Synthesised as an IMAGE element at
    // z-index 0 so it sits beneath the authored content (extractor
    // starts at z=1). Only fires when `<p:bgPr><a:blipFill>` is
    // present; solid-fill backgrounds keep going through A2 below.
    const bgImage = await extractSlideBackgroundImage(slideXml, reg, pageOrdinal, pageSize);
    if (bgImage) elementMap[bgImage.id] = bgImage;

    // A2 + I6 — slide background, with layout / master inheritance.
    // PowerPoint themes usually put `<p:bg>` on the master rather than
    // on each slide; without the chain walk every themed deck imported
    // as a stack of white slides. resolveSlideBackground tries slide →
    // layout → master and returns the first non-null fill.
    const slideBg = await resolveSlideBackground(slideXml, slideRelsXml, zip, theme);
    // A3 — full gradient stops for `<a:gradFill>` backgrounds. The
    // existing `slideBg` carries the degraded first-stop colour for the
    // IColorStyle slot; the gradient payload rides on a separate field
    // so the renderer can paint the real gradient when ready.
    const slideBgGradient = await resolveSlideBackgroundGradient(slideXml, slideRelsXml, zip, theme);

    // A6 — only emit slideProperties when the slide is actually hidden,
    // so visible slides keep their lean page model. layoutObjectId /
    // masterObjectId are required by ISlideProperties but we don't
    // track them here yet (I3 reads them but doesn't surface the IDs
    // back); set empty strings until the placeholder map exposes them.
    const isHidden = extractSlideHidden(slideXml);

    pages[pageId] = {
      id: pageId,
      pageType: PageType.SLIDE,
      zIndex: pageOrdinal,
      title: `Slide ${pageOrdinal}`,
      description: '',
      pageBackgroundFill: {
        rgb: slideBg ?? 'rgb(255, 255, 255)',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(slideBgGradient ? ({ gradientFill: slideBgGradient } as any) : {}),
      },
      pageElements: elementMap,
      ...(isHidden
        ? { slideProperties: { layoutObjectId: '', masterObjectId: '', isSkipped: true } }
        : {}),
    };
    pageOrder.push(pageId);
  }

  // I1 + I2 + J1 — harvest every layout / master / theme part by walking
  // the zip's known prefixes. We do this once after the slide loop so the
  // resources slot carries the full set even when no slide references
  // them (handles decks where Office authored extra layouts).
  zip.forEach((zipPath, entry) => {
    if (entry.dir) return;
    if (zipPath.startsWith('ppt/slideLayouts/_rels/') || zipPath.startsWith('ppt/slideMasters/_rels/') ||
        zipPath.startsWith('ppt/notesSlides/_rels/') || zipPath.startsWith('ppt/notesMasters/_rels/') ||
        zipPath.startsWith('ppt/diagrams/_rels/') || zipPath.startsWith('ppt/theme/_rels/') ||
        zipPath.startsWith('ppt/comments/_rels/') || zipPath.startsWith('ppt/ink/_rels/') ||
        zipPath.startsWith('ppt/charts/_rels/')) {
      // _rels files come along for the ride — they wire the captured
      // parts together. Export-side injection writes them verbatim.
      rawRels[zipPath] = '';
    } else if (zipPath.startsWith('ppt/slideLayouts/') && zipPath.endsWith('.xml')) {
      rawLayouts[zipPath] = '';
    } else if (zipPath.startsWith('ppt/slideMasters/') && zipPath.endsWith('.xml')) {
      rawMasters[zipPath] = '';
    } else if (zipPath.startsWith('ppt/theme/') && zipPath.endsWith('.xml')) {
      rawThemes[zipPath] = '';
    } else if ((zipPath.startsWith('ppt/notesSlides/') || zipPath.startsWith('ppt/notesMasters/')) && zipPath.endsWith('.xml')) {
      rawNotesSlides[zipPath] = '';
    } else if (zipPath.startsWith('ppt/comments/') && zipPath.endsWith('.xml')) {
      rawComments[zipPath] = '';
    } else if (zipPath.startsWith('ppt/diagrams/') && zipPath.endsWith('.xml')) {
      rawDiagrams[zipPath] = '';
    } else if (zipPath.startsWith('ppt/ink/') && zipPath.endsWith('.xml')) {
      rawInk[zipPath] = '';
    } else if (zipPath.startsWith('ppt/charts/') && zipPath.endsWith('.xml')) {
      rawCharts[zipPath] = '';
    } else if (
      // K6 — audio / video media (anything under ppt/media/ that
      // ISN'T already captured as an image data URI on the element).
      // Excluding common image extensions keeps the payload lean
      // since processPicNode already preserves them per-element.
      (zipPath.startsWith('ppt/media/') && !/\.(png|jpg|jpeg|gif|bmp|svg|webp)$/i.test(zipPath)) ||
      // Chart-embedded xlsx + OLE object payloads.
      zipPath.startsWith('ppt/embeddings/')
    ) {
      rawMediaBin[zipPath] = '';
    }
  });
  const readAll = async (bucket: Record<string, string>) => {
    await Promise.all(
      Object.keys(bucket).map(async (p) => {
        bucket[p] = (await zip.file(p)?.async('string')) ?? '';
      }),
    );
  };
  // K6 — binary parts read as base64 since JSON can't carry raw bytes.
  // `restorePassthrough` on the export side decodes back to binary
  // before writing to the produced zip.
  const readAllBinary = async (bucket: Record<string, string>) => {
    await Promise.all(
      Object.keys(bucket).map(async (p) => {
        bucket[p] = (await zip.file(p)?.async('base64')) ?? '';
      }),
    );
  };
  await Promise.all([
    readAll(rawLayouts),
    readAll(rawMasters),
    readAll(rawThemes),
    readAll(rawNotesSlides),
    readAll(rawComments),
    readAll(rawDiagrams),
    readAll(rawInk),
    readAll(rawCharts),
    readAll(rawRels),
    readAllBinary(rawMediaBin),
  ]);

  const hasCustomProps = customPropsXml !== undefined && customPropsXml.length > 0;
  const hasPassthrough =
    Object.keys(rawLayouts).length > 0 ||
    Object.keys(rawMasters).length > 0 ||
    Object.keys(rawThemes).length > 0 ||
    Object.keys(rawNotesSlides).length > 0 ||
    Object.keys(rawComments).length > 0 ||
    Object.keys(rawDiagrams).length > 0 ||
    Object.keys(rawInk).length > 0 ||
    Object.keys(rawCharts).length > 0 ||
    Object.keys(rawMediaBin).length > 0 ||
    hasCustomProps;

  // K1 — prefer the deck-authored title from docProps/core.xml; fall
  // back to filename when absent so legacy decks still round-trip.
  const title = coreProps.title ?? fileName.replace(/\.pptx$/i, '');

  const snapshot: ISlideData = {
    id: `imported-${Date.now().toString(36)}`,
    title,
    pageSize,
    body: { pages, pageOrder },
    ...(hasPassthrough
      ? {
          resources: [
            {
              name: 'CASUAL_SLIDES_PPTX_RAW',
              data: JSON.stringify({
                layouts: rawLayouts,
                masters: rawMasters,
                themes: rawThemes,
                notesSlides: rawNotesSlides,
                comments: rawComments,
                diagrams: rawDiagrams,
                ink: rawInk,
                charts: rawCharts,
                rels: rawRels,
                // K6 — base64-encoded binary parts (audio / video media +
                // chart-embedded xlsx + OLE payloads). restorePassthrough
                // decodes back to binary before injecting into the
                // exported zip.
                ...(Object.keys(rawMediaBin).length > 0
                  ? { mediaBin: rawMediaBin }
                  : {}),
                // K2 — opaque passthrough of docProps/custom.xml. Only
                // emitted when the source deck carried one so most
                // pptxs (which omit custom.xml entirely) stay lean.
                ...(hasCustomProps
                  ? { customProps: { 'docProps/custom.xml': customPropsXml! } }
                  : {}),
              }),
            },
          ],
        }
      : {}),
  } as ISlideData;

  // Font loading happens in pptx/client.ts on the MAIN thread —
  // calling loadFontsForSnapshot here is a no-op because `document`
  // is not defined inside the pptx web worker.

  return snapshot;
}

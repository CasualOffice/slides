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

  // Font family (B3 + B4): prefer `<a:latin>`, then fall back to
  // `<a:ea>` (East-Asian) and `<a:cs>` (complex-script). Univer's
  // IStyleBase has a single `ff` slot, so the priority order picks the
  // one most likely to render the run's glyphs. CJK-only decks that
  // omit `<a:latin>` previously fell through to the renderer default —
  // now they get the authored typeface.
  const latin = findChild(node, 'a:latin') as XmlNode | undefined;
  const ea = findChild(node, 'a:ea') as XmlNode | undefined;
  const cs = findChild(node, 'a:cs') as XmlNode | undefined;
  const typeface =
    (typeof latin?.['@typeface'] === 'string' && latin['@typeface']) ||
    (typeof ea?.['@typeface'] === 'string' && ea['@typeface']) ||
    (typeof cs?.['@typeface'] === 'string' && cs['@typeface']) ||
    '';
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
      // C13 — apply `<a:normAutofit fontScale>` to the run's font
      // size at import. Scale both the explicit run override and the
      // inherited fallback so frames that rely on placeholder defaults
      // still shrink correctly. Round to 0.1 pt to keep numbers tidy.
      if (fontScale !== 1) {
        if (typeof runStyle.fs === 'number') {
          runStyle.fs = Math.round(runStyle.fs * fontScale * 10) / 10;
        }
      }
      const ts = { ...(fallbackProps ?? {}), ...runStyle };
      if (fontScale !== 1 && typeof ts.fs === 'number' && runStyle.fs === undefined) {
        // Run didn't override fs; scale the inherited value so the
        // autofit shrink still applies.
        ts.fs = Math.round(ts.fs * fontScale * 10) / 10;
      }

      if (txt.length > 0) {
        textRuns.push({ st: cursor, ed: cursor + txt.length, ts });
      }

      // B17 — `<a:rPr><a:hlinkClick r:id="rIdN"/></a:rPr>` resolves
      // through the slide's rels file to either an http(s) URL or a
      // slide-internal jump. We pass http(s) URLs through to Univer's
      // hyperlink custom range; slide-internal jumps need the slide
      // model's pageId, which we don't surface here, so they're
      // skipped today (treated as plain text).
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

    // Paragraph-level (C2 + C3 + C4 + C5 + C6 + C7 + C8).
    const pPr = findChild(p, 'a:pPr');
    const align = parseParagraphAlign(pPr);
    const lineSpacing = parseLineSpacing(pPr);
    const { indentStart, indentFirstLine } = parseIndent(pPr);
    const level = parseLevel(pPr);
    const bullet = parseBullet(pPr, elementId, level);
    const spaceAbove = parseSpacePts(findChild(pPr, 'a:spcBef'));
    const spaceBelow = parseSpacePts(findChild(pPr, 'a:spcAft'));

    // C9 — `<a:pPr rtl="1">` (or `"true"`) flips the paragraph to RTL.
    // OOXML's default is LTR, matching Univer's renderer default; we
    // only emit `direction` when the deck explicitly opts in so the
    // produced IDocumentData stays minimal.
    const rtl = (pPr as XmlNode | undefined)?.['@rtl'];
    const isRtl = rtl === '1' || rtl === 1 || rtl === 'true';

    const paragraphStyle: IParagraphStyle = {};
    if (align !== null) paragraphStyle.horizontalAlign = align;
    if (lineSpacing !== null) paragraphStyle.lineSpacing = lineSpacing;
    if (indentStart !== undefined) paragraphStyle.indentStart = { v: indentStart };
    if (indentFirstLine !== undefined) paragraphStyle.indentFirstLine = { v: indentFirstLine };
    if (spaceAbove !== null) paragraphStyle.spaceAbove = { v: spaceAbove };
    if (spaceBelow !== null) paragraphStyle.spaceBelow = { v: spaceBelow };
    if (isRtl) paragraphStyle.direction = TextDirection.RIGHT_TO_LEFT;

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

  // C10 + C11 — text-frame insets and vertical anchor from `<a:bodyPr>`.
  const bodyPr = findChild(txBody, 'a:bodyPr');
  const docStyle = parseBodyPr(bodyPr) ?? {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rich: IDocumentData = {
    id: `${elementId}-doc`,
    body: {
      dataStream: dataStream.join(''),
      textRuns,
      paragraphs,
      ...(customRanges.length > 0 ? { customRanges } : {}),
    },
    documentStyle: docStyle,
  } as any;

  // Flat fallback fields = layout/master defaults spread under first
  // run's overrides. Run-level wins by field.
  const props: Partial<ISlideRichTextProps> = fallbackProps
    ? { ...fallbackProps, ...firstRunProps }
    : { ...firstRunProps };
  // C13 — if the first run didn't carry an explicit fs but the
  // placeholder fallback did, the flat `fs` exposed to legacy paths
  // (PptxGenJS export + non-rich renderer) still needs to reflect the
  // autofit shrink. Scale once at the end so we don't double-apply.
  if (fontScale !== 1 && typeof props.fs === 'number' && firstRunProps.fs === undefined) {
    props.fs = Math.round(props.fs * fontScale * 10) / 10;
  }

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

function parseShapeAppearance(spPr: unknown, theme: ThemeMap | null = null): {
  shapeType: string;
  fillRgb: string | null;
  outlineRgb: string | null;
  outlineWeightPx: number | null;
  outlineDash: BorderStyleTypes | null;
  outlineCap: 'flat' | 'rnd' | 'sq' | null;
  headEnd: Arrowhead | null;
  tailEnd: Arrowhead | null;
  effectLst: IEffectListPayload | null;
} {
  const prstGeom = findChild(spPr, 'a:prstGeom') as XmlNode | undefined;
  const prstAttr = prstGeom?.['@prst'];
  const shapeType = typeof prstAttr === 'string' && prstAttr.length > 0 ? prstAttr : 'rect';

  // D12 first — explicit `<a:noFill/>` beats any inherited / solid fill.
  // Line-like shapes also conceptually carry no fill (only a stroke);
  // emit transparent so they don't paint a phantom rectangle behind
  // the stroke when the OOXML omits `<a:noFill/>`.
  const hasNoFill =
    findChild(spPr, 'a:noFill') !== undefined || isLineLikeShape(shapeType);
  const fillRgb = hasNoFill
    ? TRANSPARENT_FILL
    : readColor(spPr, theme) ?? parseSrgbColor(spPr);

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

  return { shapeType, fillRgb, outlineRgb, outlineWeightPx, outlineDash, outlineCap, headEnd, tailEnd, effectLst };
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
      // C13 — read `<a:bodyPr><a:normAutofit fontScale="…"/></a:bodyPr>`
      // before walking runs so the autofit shrink applies to every per-run
      // `fs` (including those inherited from placeholder defaults).
      const txBodyPr = findChild(txBody, 'a:bodyPr');
      const fontScale = parseBodyPrFontScale(txBodyPr);
      const { text, props, rich } = extractRichDoc(
        txBody,
        elId,
        phInherited?.defaultRunProps,
        reg.theme,
        reg.imageRelMap,
        fontScale,
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
      const { shapeType, fillRgb, outlineRgb, outlineWeightPx, outlineDash, outlineCap, headEnd, tailEnd, effectLst } = parseShapeAppearance(spPr, reg.theme);
      const inflated = inflateLineBbox(shapeType, width, height, outlineWeightPx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shapeProperties: any = {};
      if (fillRgb) shapeProperties.shapeBackgroundFill = { rgb: fillRgb };
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
  }

  // F3 — `<p:cxnSp>` connectors. Same geometry shape as `<p:sp>` minus
  // the text body. PowerPoint emits `prst="line"`, `"straightConnector1"`,
  // `"bentConnector3"`, etc. — pass through to Univer's shapeType so
  // future renderer work picks them up. Position + outline + flips all
  // flow through the same branches as a regular shape.
  for (const cxn of toArray(findChild(spTree, 'p:cxnSp'))) {
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
    const { shapeType, fillRgb, outlineRgb, outlineWeightPx, outlineDash, outlineCap, headEnd, tailEnd, effectLst } = parseShapeAppearance(spPr, reg.theme);
    const inflated = inflateLineBbox(shapeType, width, height, outlineWeightPx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shapeProperties: any = {};
    if (fillRgb) shapeProperties.shapeBackgroundFill = { rgb: fillRgb };
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
  }

  // <p:pic>
  for (const pic of toArray(findChild(spTree, 'p:pic'))) {
    if (!pic || typeof pic !== 'object') continue;
    const result = await processPicNode(pic, reg, groupXfrm, pageOrdinal, z);
    if (result) out.push(result);
  }

  // G1-G4 + H1 — `<p:graphicFrame>` wraps tables (via `<a:tbl>`) and
  // charts (via `<c:chart>`). Both share the graphicFrame xfrm + a
  // `<a:graphicData>` with a uri discriminator. Walk once and dispatch
  // per uri.
  for (const gf of toArray(findChild(spTree, 'p:graphicFrame'))) {
    if (!gf || typeof gf !== 'object') continue;
    const result = processGraphicFrame(gf, reg, groupXfrm, pageOrdinal, z);
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

// G1-G4 + H1 — graphicFrame dispatch. Returns a TABLE or CHART
// IPageElement based on the `<a:graphicData uri>` discriminator.
function processGraphicFrame(
  gf: unknown,
  reg: ImageRegistry,
  groupXfrm: GroupXfrm,
  pageOrdinal: number,
  z: ZCounter,
): IPageElement | null {
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
  // ppt/charts/chartN.xml, captured via the resources passthrough. Here
  // we only emit the reference id so the renderer / hit-test layer can
  // locate it.
  const chartNode = findChild(graphicData, 'c:chart') as XmlNode | undefined;
  if (chartNode && typeof uri === 'string' && uri.endsWith('/chart')) {
    const chartId = (chartNode['@r:id'] as string | undefined) ?? '';
    const chartTarget = chartId ? reg.imageRelMap.get(chartId) : undefined;
    const elId = `s${pageOrdinal}-chart-${zIndex}`;
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
      chart: { chartId, ...(chartTarget ? { chartPath: chartTarget } : {}) } as any,
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
      } as any,
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

function extractSlideBackground(slideXml: string, theme: ThemeMap | null): string | null {
  const parsed = parser.parse(slideXml) as XmlNode;
  const cSld = findChild(findChild(parsed, 'p:sld'), 'p:cSld');
  const bg = findChild(cSld, 'p:bg');
  if (!bg) return null;
  const bgPr = findChild(bg, 'p:bgPr');
  if (!bgPr) return null;
  return readColor(bgPr, theme) ?? parseSrgbColor(bgPr);
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

    // A4 — picture background. Synthesised as an IMAGE element at
    // z-index 0 so it sits beneath the authored content (extractor
    // starts at z=1). Only fires when `<p:bgPr><a:blipFill>` is
    // present; solid-fill backgrounds keep going through A2 below.
    const bgImage = await extractSlideBackgroundImage(slideXml, reg, pageOrdinal, pageSize);
    if (bgImage) elementMap[bgImage.id] = bgImage;

    // A2 — slide background. Theme- and layout-inherited backgrounds
    // are still TODO (A5 / I6); when this slide has no `<p:bg>` we
    // keep the historical white default.
    const slideBg = extractSlideBackground(slideXml, theme);

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
      pageBackgroundFill: { rgb: slideBg ?? 'rgb(255, 255, 255)' },
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
    }
  });
  const readAll = async (bucket: Record<string, string>) => {
    await Promise.all(
      Object.keys(bucket).map(async (p) => {
        bucket[p] = (await zip.file(p)?.async('string')) ?? '';
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
  ]);

  const hasPassthrough =
    Object.keys(rawLayouts).length > 0 ||
    Object.keys(rawMasters).length > 0 ||
    Object.keys(rawThemes).length > 0 ||
    Object.keys(rawNotesSlides).length > 0 ||
    Object.keys(rawComments).length > 0 ||
    Object.keys(rawDiagrams).length > 0 ||
    Object.keys(rawInk).length > 0 ||
    Object.keys(rawCharts).length > 0;

  return {
    id: `imported-${Date.now().toString(36)}`,
    title: fileName.replace(/\.pptx$/i, ''),
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
              }),
            },
          ],
        }
      : {}),
  };
}

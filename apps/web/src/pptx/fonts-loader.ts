import type { ISlideData } from '@univerjs/slides';

// Dynamic font loader. Scans an imported snapshot for every distinct
// `ff` (font family) value referenced by any text run or text-element
// fallback, then asks Google Fonts to ship them via a single CSS link.
//
// Why dynamic: any curated preload list will miss something — there
// are thousands of fonts in the Google Fonts catalog and authors pick
// idiosyncratic ones. The bulk preload in index.html keeps the top
// ~50 most-popular families warm for first paint; this scanner picks
// up everything else after import so the canvas paints with the right
// typefaces on the second redraw.
//
// Fonts not in Google Fonts fail silently (display=swap → fall back to
// system + Arial). We don't currently host or sideload `.ttf` files;
// the LICENSE column dictates a Google Fonts pull only.

// Families we never request from Google Fonts — either they're system
// fonts that browsers resolve locally, generic CSS keywords, or
// already preloaded in index.html.
const SKIP_FAMILIES = new Set<string>([
  '', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  // Web-safe system fonts
  'Arial', 'Helvetica', 'Helvetica Neue', 'Times', 'Times New Roman',
  'Courier', 'Courier New', 'Verdana', 'Georgia', 'Tahoma',
  'Trebuchet MS', 'Impact', 'Comic Sans MS', 'Palatino', 'Garamond',
  'Bookman', 'Avant Garde', 'Lucida Console', 'Lucida Sans Unicode',
  // Already loaded in index.html — adding them again is harmless but
  // avoids a duplicate fetch on the deck-import code path.
  'Inter', 'Open Sans', 'Lato', 'Roboto', 'Source Sans 3', 'Source Sans Pro',
  'Noto Sans', 'Noto Serif', 'Montserrat', 'Merriweather',
  'Playfair Display', 'PT Sans', 'Roboto Slab', 'Roboto Mono',
  'Carlito', 'Caladea',
  'Raleway', 'Poppins', 'Oswald', 'Bebas Neue', 'Quicksand',
  'Nunito', 'Nunito Sans', 'Work Sans', 'Rubik', 'Mulish',
  'Inconsolata', 'Crimson Text', 'Libre Baskerville', 'Cormorant Garamond',
  'DM Sans', 'DM Serif Display', 'EB Garamond', 'Fira Sans', 'Manrope',
  'Bitter', 'Karla', 'Cabin', 'Josefin Sans', 'Archivo', 'Anton',
  'Heebo', 'Hind', 'Barlow', 'PT Serif',
]);

// MS-proprietary families → metric-compatible open-source replacements.
// Kept in sync with pptx-import.ts's FONT_SUBSTITUTION_MAP; we run the
// same substitution at injection time so requests for "Calibri" don't
// 404 on Google Fonts.
const FONT_SUBSTITUTION: Record<string, string> = {
  'Calibri': 'Carlito',
  'Calibri Light': 'Carlito',
  'Calibri Bold': 'Carlito',
  'Cambria': 'Caladea',
  'Cambria Math': 'Caladea',
};

function normaliseFamily(raw: string): string | null {
  let f = raw.trim();
  if (!f) return null;
  // Strip surrounding quotes some authors include.
  f = f.replace(/^['"]|['"]$/g, '').trim();
  // The truthiness check on the indexed access also narrows it to string.
  const sub = FONT_SUBSTITUTION[f];
  if (sub) f = sub;
  if (SKIP_FAMILIES.has(f)) return null;
  // Reject anything with characters Google Fonts can't accept in the
  // family= URL param — only Latin letters, digits, spaces and `+`.
  if (!/^[A-Za-z0-9 +-]+$/.test(f)) return null;
  return f;
}

// Walk an ISlideData snapshot and harvest every distinct font family
// referenced. Reads both the flat `richText.ff` and per-run
// `richText.rich.body.textRuns[*].ts.ff`. Plus shape text + table cells
// when the model carries them.
export function collectFontsFromSnapshot(snapshot: ISlideData): Set<string> {
  const out = new Set<string>();
  const pages = snapshot.body?.pages ?? {};
  for (const page of Object.values(pages)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const elements = Object.values((page as any)?.pageElements ?? {}) as any[];
    for (const el of elements) {
      const rt = el?.richText;
      if (rt) {
        if (typeof rt.ff === 'string') {
          const n = normaliseFamily(rt.ff);
          if (n) out.add(n);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const runs = (rt as any)?.rich?.body?.textRuns as Array<{ ts?: { ff?: string } }> | undefined;
        if (runs) {
          for (const r of runs) {
            if (typeof r?.ts?.ff === 'string') {
              const n = normaliseFamily(r.ts.ff);
              if (n) out.add(n);
            }
          }
        }
      }
      // Table cell text (G1-G4)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tableRows = (el as any)?.table?.rows;
      if (Array.isArray(tableRows)) {
        for (const row of tableRows) {
          for (const cell of (row?.cells ?? [])) {
            const cellRuns = cell?.richText?.body?.textRuns as Array<{ ts?: { ff?: string } }> | undefined;
            if (cellRuns) {
              for (const r of cellRuns) {
                if (typeof r?.ts?.ff === 'string') {
                  const n = normaliseFamily(r.ts.ff);
                  if (n) out.add(n);
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

// Build a Google Fonts CSS2 URL for a set of family names. Each family
// is requested in 400 + 700 weights, italic + roman; the renderer
// synthesises additional weights via canvas font-weight resolution.
//
// Google Fonts CSS2 caps URL length around ~8 KB; chunk to be safe.
export function buildGoogleFontsUrls(fonts: Set<string>): string[] {
  if (fonts.size === 0) return [];
  const families = Array.from(fonts);
  const chunks: string[][] = [];
  // Aim for ~20 families per chunk — each `family=` param is ~60 chars
  // (with weight axes), so 20 × 60 = 1.2 KB, well under any URL limit.
  for (let i = 0; i < families.length; i += 20) chunks.push(families.slice(i, i + 20));
  return chunks.map((chunk) => {
    const params = chunk
      .map((f) => `family=${encodeURIComponent(f.replace(/ /g, '+'))}:ital,wght@0,400;0,700;1,400;1,700`)
      .join('&');
    return `https://fonts.googleapis.com/css2?${params}&display=swap`;
  });
}

// Inject <link rel="stylesheet"> tags for each font URL. Idempotent —
// existing identical hrefs are skipped, and previous dynamic loaders
// from a prior import are replaced (their families may have changed
// across decks).
export function injectFontLinks(urls: string[]): void {
  if (typeof document === 'undefined') return;
  // Wipe previous dynamic loaders before adding new ones.
  for (const el of Array.from(document.querySelectorAll('link[data-casual-slides-fonts]'))) {
    el.remove();
  }
  for (const url of urls) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.setAttribute('data-casual-slides-fonts', 'dynamic');
    document.head.appendChild(link);
  }
}

// Convenience: scan snapshot + inject in one go. Returns the set of
// families requested so callers can log / debug.
export function loadFontsForSnapshot(snapshot: ISlideData): Set<string> {
  const fonts = collectFontsFromSnapshot(snapshot);
  if (fonts.size === 0) return fonts;
  injectFontLinks(buildGoogleFontsUrls(fonts));
  return fonts;
}

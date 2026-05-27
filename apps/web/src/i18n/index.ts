import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

// Re-export `useTranslation` so consumers can pull it from the local
// `./i18n` barrel — keeps imports symmetrical with our local config and
// makes a future swap (e.g. to a custom hook) a one-line change here.
export { useTranslation } from 'react-i18next';

// i18n foundation for Casual Slides.
//
// Why this shape:
//   - One JSON per locale, mirroring the sheet pattern. Locale files are
//     pure data — no import-side effects — so they can be lazy-loaded
//     when we add `es`, `zh`, etc. in a later wave.
//   - Top-level keys are NAMESPACES (chrome, toolbar, dialogs, slideshow,
//     errors, menu, statusbar, notes). `useTranslation('toolbar')` returns
//     a `t()` scoped to that namespace; cross-namespace lookups go through
//     `t('namespace:key')`.
//   - `escapeValue: false` because React already escapes interpolated
//     children — i18next's default double-escape mangles ampersands.
//   - `fallbackLng: 'en'`. If a future locale ships without a key, we
//     render the English source instead of the raw key.
//
// To add a locale:
//   1. Copy `locales/en.json` to `locales/<code>.json` and translate.
//   2. Import it here and add to the `resources` map.
//   3. Optionally expose a language picker; until then we honour the
//      browser's `navigator.language` via i18next's detector (not wired
//      yet — keep it explicit while the key surface is still settling).

export const I18N_NAMESPACES = [
  'chrome',
  'toolbar',
  'dialogs',
  'slideshow',
  'errors',
  'menu',
  'statusbar',
  'notes',
] as const;

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

void i18n.use(initReactI18next).init({
  resources: {
    en,
  },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'chrome',
  ns: I18N_NAMESPACES as unknown as string[],
  interpolation: {
    // React escapes children by default; i18next would double-escape.
    escapeValue: false,
  },
  // We ship a single bundled `en` resource; no dynamic loader yet.
  returnNull: false,
});

export default i18n;

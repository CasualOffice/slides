import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ja from './locales/ja.json';
import zhCN from './locales/zh-cn.json';
import zhTW from './locales/zh-tw.json';

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

export type AppLocale = 'ja' | 'en' | 'zh-cn' | 'zh-tw' | 'fr' | 'es';

const SUPPORTED_LOCALES: AppLocale[] = ['ja', 'en', 'zh-cn', 'zh-tw', 'fr', 'es'];

function normalizeLocale(raw: string | null | undefined): AppLocale | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase().replace(/_/g, '-');
  if ((SUPPORTED_LOCALES as string[]).includes(value)) return value as AppLocale;
  if (value.startsWith('zh')) {
    return /(?:tw|hk|mo|hant)/.test(value) ? 'zh-tw' : 'zh-cn';
  }
  const base = value.split('-', 1)[0] ?? value;
  return (SUPPORTED_LOCALES as string[]).includes(base) ? (base as AppLocale) : null;
}

// The hub CTA passes `?lang=`. Read it synchronously before React mounts so
// the editor never flashes English first. Stored/browser language remain
// useful for direct visits to the editor URL.
export function detectAppLocale(): AppLocale {
  if (typeof window === 'undefined') return 'en';
  try {
    const requested = normalizeLocale(new URL(window.location.href).searchParams.get('lang'));
    if (requested) return requested;
  } catch {
    /* use the next source */
  }
  try {
    const stored = normalizeLocale(window.localStorage.getItem('ruru_locale'));
    if (stored) return stored;
  } catch {
    /* use the browser locale */
  }
  return normalizeLocale(window.navigator.language) ?? 'en';
}

export const appLocale = detectAppLocale();

void i18n.use(initReactI18next).init({
  resources: {
    en,
    es,
    fr,
    ja,
    'zh-cn': zhCN,
    'zh-tw': zhTW,
  },
  lng: appLocale,
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LOCALES,
  lowerCaseLng: true,
  load: 'currentOnly',
  defaultNS: 'chrome',
  ns: I18N_NAMESPACES as unknown as string[],
  interpolation: {
    // React escapes children by default; i18next would double-escape.
    escapeValue: false,
  },
  returnNull: false,
});

if (typeof document !== 'undefined') {
  document.documentElement.lang = appLocale;
  try {
    window.localStorage.setItem('ruru_locale', appLocale);
  } catch {
    /* private storage or storage disabled */
  }
}

export default i18n;

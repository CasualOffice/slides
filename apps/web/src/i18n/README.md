# i18n

`react-i18next` wiring for Casual Slides. English (`en`) only today; structure is locale-agnostic.

## Layout

```
i18n/
  index.ts         # initialises i18next, exports the configured instance
  locales/
    en.json        # source-of-truth English bundle, grouped by namespace
  README.md
```

## Namespaces

Top-level keys in each locale JSON ARE the namespaces:

- `chrome` — title bar, brand, action buttons, collab pill
- `menu` — File / Edit / View / Insert / Help dropdowns + their shortcuts
- `toolbar` — toolbar buttons, shape menu, slideshow CTA
- `statusbar` — slide count, view mode tooltips, zoom controls
- `notes` — speaker-notes panel
- `dialogs` — every modal (theme, background, layout, properties, recent, about, slide-context)
- `slideshow` — presenter-mode strings
- `errors` — user-facing error copy

Pick the namespace that fits the surface; don't cross-cut. Add sub-objects freely (`dialogs.theme.names.classic`).

## Migrating a literal in 3 lines

```tsx
import { useTranslation } from 'react-i18next';
const { t } = useTranslation('toolbar');
return <button title={t('tools.undoTooltip')}>{t('tools.undo')}</button>;
```

For interpolation: `t('statusbar.slideCount', { current: 3, total: 10 })`.

## Adding a key

1. Open `locales/en.json` and add the key under the right namespace.
2. Use the key with `t('namespace.subpath.key')` (or via `useTranslation(ns)` and `t('subpath.key')`).
3. When a non-`en` locale is added, mirror the key there too.

## Adding a new locale

1. Copy `locales/en.json` to `locales/<code>.json`; translate values, keep keys identical.
2. Import it in `index.ts` and add it to the `resources` map.
3. Wire a language picker or a detector when the catalogue is real.

## Rules

- English copy follows Google Slides / Material Design 3 vocabulary.
- No unicode arrows / icon characters in values — spell them out (`Arrow right`, `Shift+Del`).
- Pluralisation uses i18next's `_other` suffix.

import { useCallback, useEffect, useRef } from 'react';
import type { Univer } from '@univerjs/core';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { PageElementType } from '@univerjs/slides';
import { dispatchSlideCommand } from '../univer/commands';
import { useTranslation } from '../i18n';
import { Icon } from './icons';
import { useFocusTrap } from './use-focus-trap';

// Curated theme catalog. A theme is a full design system — background +
// heading font + body font + accent + default text colour — cascaded
// across every slide. Background goes through slide.mutation.update-page;
// the text cascade writes richText.ff / .cl on each TEXT element directly
// on the snapshot (Univer v0.24.0 has no element-style mutation reachable
// from outside docs-ui) + incrementRev to repaint. TODO(collab): the text
// cascade bypasses the command bus; replace once a fork-side mutation lands.

export interface Theme {
  id: string;
  name: string;
  background: string;     // CSS rgb() for the page fill
  swatch: string;         // hex / rgb for the preview tile
  accent: string;         // accent / heading colour
  headingFont: string;    // CSS font-family for headings
  bodyFont: string;       // CSS font-family for body text
  headingRgb: string;     // heading text colour (hex)
  bodyRgb: string;        // body text colour (hex)
}

export const THEMES: Theme[] = [
  { id: 'classic',  name: 'Classic',  background: 'rgb(255, 255, 255)', swatch: '#ffffff', accent: '#0D9488', headingFont: 'Inter',            bodyFont: 'Inter',          headingRgb: '#1F2937', bodyRgb: '#374151' },
  { id: 'paper',    name: 'Paper',    background: 'rgb(250, 248, 244)', swatch: '#faf8f4', accent: '#5b4636', headingFont: 'Merriweather',     bodyFont: 'PT Sans',        headingRgb: '#3b2f25', bodyRgb: '#5b4636' },
  { id: 'sky',      name: 'Sky',      background: 'rgb(230, 244, 255)', swatch: '#e6f4ff', accent: '#1a73e8', headingFont: 'Montserrat',       bodyFont: 'Open Sans',      headingRgb: '#0b3d91', bodyRgb: '#1f3a5f' },
  { id: 'mint',     name: 'Mint',     background: 'rgb(230, 250, 240)', swatch: '#e6faf0', accent: '#107c41', headingFont: 'Poppins',          bodyFont: 'Lato',           headingRgb: '#0c5c30', bodyRgb: '#1f4a35' },
  { id: 'sunset',   name: 'Sunset',   background: 'rgb(255, 244, 230)', swatch: '#fff4e6', accent: '#d97706', headingFont: 'Playfair Display', bodyFont: 'Source Sans 3',  headingRgb: '#7c3f06', bodyRgb: '#5c4326' },
  { id: 'lavender', name: 'Lavender', background: 'rgb(244, 240, 252)', swatch: '#f4f0fc', accent: '#7c3aed', headingFont: 'Raleway',          bodyFont: 'Nunito Sans',    headingRgb: '#4c1d95', bodyRgb: '#4b3a66' },
  { id: 'graphite', name: 'Graphite', background: 'rgb(34, 38, 45)',    swatch: '#22262d', accent: '#fafafa', headingFont: 'Roboto Slab',      bodyFont: 'Roboto',         headingRgb: '#fafafa', bodyRgb: '#d1d5db' },
  { id: 'ocean',    name: 'Ocean',    background: 'rgb(20, 38, 58)',    swatch: '#14263a', accent: '#7dd3fc', headingFont: 'Oswald',           bodyFont: 'Work Sans',      headingRgb: '#e0f2fe', bodyRgb: '#bae6fd' },
];

export interface ThemePickerProps {
  open: boolean;
  onClose: () => void;
}

function getModel(): SlideDataModel | null {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return null;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    return instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE) ?? null;
  } catch {
    return null;
  }
}

// A text element reads as a heading when it's large (fs >= 28) or bold.
// Everything else takes the body style.
function isHeading(fs: number | undefined, bl: number | undefined): boolean {
  return (fs ?? 0) >= 28 || bl === 1;
}

async function applyTheme(theme: Theme) {
  const model = getModel();
  if (!model) return;
  const order = model.getPageOrder();
  if (!order) return;

  // 1) Background per page — goes through the command bus (collab-ready).
  for (const pageId of order) {
    await dispatchSlideCommand('slide.mutation.update-page', {
      pageId,
      patch: { pageBackgroundFill: { rgb: theme.background } },
    });
  }

  // 2) Text cascade — font + colour per TEXT element. Written directly on
  //    the snapshot because Univer v0.24.0 exposes no element-style
  //    mutation outside docs-ui. TODO(collab): bypasses the command bus.
  const snapshot = model.getSnapshot();
  const pages = snapshot.body?.pages ?? {};
  let touched = false;
  for (const pageId of order) {
    const page = pages[pageId];
    if (!page) continue;
    for (const el of Object.values(page.pageElements ?? {})) {
      if (el.type !== PageElementType.TEXT || !el.richText) continue;
      const heading = isHeading(el.richText.fs, el.richText.bl);
      el.richText.ff = heading ? theme.headingFont : theme.bodyFont;
      el.richText.cl = { rgb: heading ? theme.headingRgb : theme.bodyRgb };
      touched = true;
    }
  }
  if (touched) {
    model.incrementRev();
    const active = model.getActivePage();
    if (active) model.setActivePage(active);
  }
}

export function ThemePicker({ open, onClose }: ThemePickerProps) {
  const { t } = useTranslation('dialogs');
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialogRef);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!dialogRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const handlePick = useCallback(async (theme: Theme) => {
    await applyTheme(theme);
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div className="cs-themepicker__backdrop" role="dialog" aria-modal="true" aria-label={t('theme.ariaLabel')}>
      <div className="cs-themepicker" ref={dialogRef} tabIndex={-1}>
        <header className="cs-themepicker__header">
          <Icon name="palette" size={16} />
          <h2 className="cs-themepicker__title">{t('theme.title')}</h2>
          <span className="cs-themepicker__hint">{t('theme.hint')}</span>
          <button type="button" className="cs-themepicker__close" onClick={onClose} title={t('theme.closeTooltip')}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="cs-themepicker__grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className="cs-themepicker__card"
              onClick={() => void handlePick(theme)}
              title={theme.name}
            >
              <div
                className="cs-themepicker__swatch"
                style={{ background: theme.swatch }}
              >
                {/* Live "Aa" preview in the theme's heading font + accent. */}
                <span
                  className="cs-themepicker__aa"
                  style={{ color: theme.accent, fontFamily: `'${theme.headingFont}', sans-serif` }}
                >
                  Aa
                </span>
                <span
                  className="cs-themepicker__line"
                  style={{ background: theme.accent, opacity: 0.85 }}
                />
                <span
                  className="cs-themepicker__line cs-themepicker__line--short"
                  style={{ background: theme.accent, opacity: 0.55 }}
                />
              </div>
              <span className="cs-themepicker__name">{theme.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

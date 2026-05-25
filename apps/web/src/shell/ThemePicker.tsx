import { useCallback, useEffect, useRef } from 'react';
import type { Univer } from '@univerjs/core';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { dispatchSlideCommand } from '../univer/commands';
import { Icon } from './icons';

// Curated theme catalog — 8 cards. Each theme applies a page background
// fill across all slides in the deck via slide.mutation.update-page.
//
// Future cascades (text-on-dark contrast, accent-coloured shapes, font
// family swap) need additional element-level updates; tracked on the
// Design tab roadmap. For now, theme = background. Visual win without
// the multi-element-mutation batch.

export interface Theme {
  id: string;
  name: string;
  background: string;    // CSS rgb()
  swatch: string;        // hex / rgb for the preview tile
  accent: string;        // for the swatch corner pip
}

export const THEMES: Theme[] = [
  { id: 'classic',   name: 'Classic',   background: 'rgb(255, 255, 255)', swatch: '#ffffff', accent: '#B7472A' },
  { id: 'paper',     name: 'Paper',     background: 'rgb(250, 248, 244)', swatch: '#faf8f4', accent: '#5b4636' },
  { id: 'sky',       name: 'Sky',       background: 'rgb(230, 244, 255)', swatch: '#e6f4ff', accent: '#1a73e8' },
  { id: 'mint',      name: 'Mint',      background: 'rgb(230, 250, 240)', swatch: '#e6faf0', accent: '#107c41' },
  { id: 'sunset',    name: 'Sunset',    background: 'rgb(255, 244, 230)', swatch: '#fff4e6', accent: '#d97706' },
  { id: 'lavender',  name: 'Lavender',  background: 'rgb(244, 240, 252)', swatch: '#f4f0fc', accent: '#7c3aed' },
  { id: 'graphite',  name: 'Graphite',  background: 'rgb(34, 38, 45)',    swatch: '#22262d', accent: '#fafafa' },
  { id: 'ocean',     name: 'Ocean',     background: 'rgb(20, 38, 58)',    swatch: '#14263a', accent: '#7dd3fc' },
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

async function applyTheme(theme: Theme) {
  const model = getModel();
  if (!model) return;
  const order = model.getPageOrder();
  if (!order) return;
  // Dispatch one mutation per page. They run synchronously through
  // ICommandService and each fires onMutationExecutedForCollab — so when
  // P2 lands, each peer receives the same set of update-page mutations.
  for (const pageId of order) {
    await dispatchSlideCommand('slide.mutation.update-page', {
      pageId,
      patch: { pageBackgroundFill: { rgb: theme.background } },
    });
  }
}

export function ThemePicker({ open, onClose }: ThemePickerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

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
    <div className="cs-themepicker__backdrop" role="dialog" aria-label="Choose a theme">
      <div className="cs-themepicker" ref={dialogRef}>
        <header className="cs-themepicker__header">
          <Icon name="palette" size={16} />
          <h2 className="cs-themepicker__title">Themes</h2>
          <span className="cs-themepicker__hint">Applies to every slide</span>
          <button type="button" className="cs-themepicker__close" onClick={onClose} title="Close (Esc)">
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
                <span
                  className="cs-themepicker__pip"
                  style={{ background: theme.accent }}
                />
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

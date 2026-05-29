import { useCallback, useEffect, useRef, useState } from 'react';
import type { Univer } from '@univerjs/core';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { PageElementType } from '@univerjs/slides';
import { dispatchSlideCommand } from '../univer/commands';
import { Icon } from './icons';

// Background color picker — popover anchored to the Toolbar Background
// button. Active slide by default; "Apply to all slides" toggle cascades.
// Dispatches slide.mutation.update-page, so changes broadcast on the
// collab bus.

export interface BackgroundPickerProps {
  anchorRect: DOMRect | null;
  onClose: () => void;
}

interface ColorChip {
  name: string;
  rgb: string;
}

// Curated palette inspired by Google Slides' Slide → Background dialog.
// Two rows of 8: neutrals + accent colors.
const PALETTE: ColorChip[] = [
  { name: 'White',       rgb: 'rgb(255, 255, 255)' },
  { name: 'Light gray',  rgb: 'rgb(243, 244, 246)' },
  { name: 'Gray',        rgb: 'rgb(156, 163, 175)' },
  { name: 'Dark gray',   rgb: 'rgb(75, 85, 99)' },
  { name: 'Near black',  rgb: 'rgb(34, 38, 45)' },
  { name: 'Cream',       rgb: 'rgb(250, 248, 244)' },
  { name: 'Sky',         rgb: 'rgb(230, 244, 255)' },
  { name: 'Mint',        rgb: 'rgb(230, 250, 240)' },
  { name: 'Red',         rgb: 'rgb(220, 38, 38)' },
  { name: 'Orange',      rgb: 'rgb(234, 88, 12)' },
  { name: 'Yellow',      rgb: 'rgb(234, 179, 8)' },
  { name: 'Green',       rgb: 'rgb(22, 163, 74)' },
  { name: 'Blue',        rgb: 'rgb(37, 99, 235)' },
  { name: 'Indigo',      rgb: 'rgb(79, 70, 229)' },
  { name: 'Purple',      rgb: 'rgb(124, 58, 237)' },
  { name: 'Pink',        rgb: 'rgb(219, 39, 119)' },
];

function getModel(): SlideDataModel | null {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return null;
  try {
    return univer.__getInjector().get(IUniverInstanceService)
      .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE) ?? null;
  } catch {
    return null;
  }
}

// Parse "#rrggbb" / "#rgb" into our model's "rgb(r, g, b)" form. PptxGenJS
// + Univer's renderer both accept either, but normalising one way keeps the
// snapshot stable for diff-based tests.
function hexToRgb(hex: string): string | null {
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// Convert "rgb(r,g,b)" → "#rrggbb" for the native <input type=color>.
// Univer's `Nullable<T>` includes `void`; widen the accept type.
function rgbToHex(rgb: string | null | undefined | void): string {
  if (!rgb) return '#ffffff';
  const m = rgb.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (!m) return '#ffffff';
  const toHex = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`.toUpperCase();
}

export function BackgroundPicker({ anchorRect, onClose }: BackgroundPickerProps) {
  const [applyAll, setApplyAll] = useState(false);
  const [customHex, setCustomHex] = useState('#ffffff');
  const popoverRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Initial colour reflects the active slide's current background, if any.
  useEffect(() => {
    const model = getModel();
    const rgb = model?.getActivePage()?.pageBackgroundFill?.rgb;
    setCustomHex(rgbToHex(rgb));
  }, []);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!anchorRect) return;
    const onClick = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) onClose();
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
  }, [anchorRect, onClose]);

  const apply = useCallback(async (rgb: string, all: boolean) => {
    const model = getModel();
    if (!model) return;
    if (all) {
      const order = model.getPageOrder() ?? [];
      for (const pageId of order) {
        await dispatchSlideCommand('slide.mutation.update-page', {
          pageId,
          patch: { pageBackgroundFill: { rgb } },
        });
      }
    } else {
      const activeId = model.getActivePage()?.id;
      if (!activeId) return;
      await dispatchSlideCommand('slide.mutation.update-page', {
        pageId: activeId,
        patch: { pageBackgroundFill: { rgb } },
      });
    }
    onClose();
  }, [onClose]);

  // Image background. Univer's pageBackgroundFill is colour-only, so (like
  // the pptx importer for picture backgrounds) we drop a full-slide IMAGE
  // element at zIndex 0 — it sits below the authored content. Inserted via
  // slide.mutation.insert-element, which repaints. Applies to the active
  // slide, or every slide when "Apply to all" is on.
  const applyImage = useCallback((dataUrl: string, all: boolean) => {
    const model = getModel();
    if (!model) return;
    const snapshot = model.getSnapshot();
    const pageSize = {
      width: snapshot.pageSize?.width ?? 960,
      height: snapshot.pageSize?.height ?? 540,
    };
    const unitId = model.getUnitId();
    const targets = all
      ? (model.getPageOrder() ?? [])
      : ([model.getActivePage()?.id].filter(Boolean) as string[]);
    for (const pageId of targets) {
      const element = {
        id: `bg-img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        zIndex: 0,
        left: 0,
        top: 0,
        width: pageSize.width,
        height: pageSize.height,
        title: '',
        description: '',
        type: PageElementType.IMAGE,
        image: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          imageProperties: { contentUrl: dataUrl } as any,
        },
      };
      void dispatchSlideCommand('slide.mutation.insert-element', {
        unitId,
        pageId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        element: element as any,
      });
    }
    onClose();
  }, [onClose]);

  const onImageFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') applyImage(reader.result, applyAll);
      };
      reader.readAsDataURL(file);
    },
    [applyImage, applyAll],
  );

  if (!anchorRect) return null;

  // Position below the toolbar button, right-aligned to keep wide popover
  // from overflowing off the right edge.
  const left = Math.min(anchorRect.left, window.innerWidth - 320);
  const top = anchorRect.bottom + 6;

  return (
    <div
      ref={popoverRef}
      className="cs-bg-picker"
      data-testid="bg-picker"
      role="dialog"
      aria-label="Background color"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="cs-bg-picker__header">
        <span className="cs-bg-picker__title">Background</span>
        <button
          type="button"
          className="cs-bg-picker__nofill"
          onClick={() => imageInputRef.current?.click()}
          title="Image background"
        >
          <Icon name="image" size={14} />
          <span>Image</span>
        </button>
        <button
          type="button"
          className="cs-bg-picker__nofill"
          onClick={() => void apply('', applyAll)}
          title="No fill"
        >
          <Icon name="format_color_reset" size={14} />
          <span>No fill</span>
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: 'none' }}
          onChange={onImageFile}
        />
      </div>
      <div className="cs-bg-picker__grid" role="listbox" aria-label="Color presets">
        {PALETTE.map((chip) => (
          <button
            key={chip.rgb}
            type="button"
            className="cs-bg-picker__chip"
            style={{ background: chip.rgb }}
            title={chip.name}
            aria-label={chip.name}
            onClick={() => void apply(chip.rgb, applyAll)}
          />
        ))}
      </div>
      <div className="cs-bg-picker__custom">
        <label className="cs-bg-picker__custom-label" htmlFor="bg-custom">
          <span>Custom</span>
          <input
            id="bg-custom"
            type="color"
            value={customHex}
            onChange={(e) => setCustomHex(e.target.value)}
            className="cs-bg-picker__custom-input"
          />
        </label>
        <button
          type="button"
          className="cs-btn cs-btn--ghost cs-bg-picker__apply"
          onClick={() => {
            const rgb = hexToRgb(customHex);
            if (rgb) void apply(rgb, applyAll);
          }}
        >
          Apply
        </button>
      </div>
      <label className="cs-bg-picker__option">
        <input
          type="checkbox"
          checked={applyAll}
          onChange={(e) => setApplyAll(e.target.checked)}
          data-testid="bg-picker-apply-all"
        />
        <span>Apply to all slides</span>
      </label>
      <button
        type="button"
        className="cs-bg-picker__close"
        onClick={onClose}
        title="Close"
        aria-label="Close"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

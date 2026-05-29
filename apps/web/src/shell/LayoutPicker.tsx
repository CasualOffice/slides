import { useEffect, useRef, useState } from 'react';
import type { Univer } from '@univerjs/core';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { dispatchSlideCommand } from '../univer/commands';
import { useTranslation } from '../i18n';
import { LAYOUT_TEMPLATES, PREVIEW_VIEWBOX, buildPageFromLayout } from './layouts';
import type { LayoutTemplate } from './layouts';

type LayoutMode = 'insert' | 'apply';

// Replace the ACTIVE page's elements with the chosen layout's placeholder
// elements ("Change layout"). Direct snapshot write + incrementRev, the same
// pattern the theme cascade / slide reorder use. Univer v0.24.0 has no
// change-layout mutation. TODO(collab): not collab-safe until the fork
// mutation lands.
function applyLayoutToCurrent(template: LayoutTemplate): void {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    if (!model) return;
    const active = model.getActivePage();
    if (!active) return;
    // Swap the page's elements for the template's placeholders; keep the
    // existing background fill so a themed deck doesn't reset to white.
    active.pageElements = template.buildElements();
    model.incrementRev();
    model.setActivePage(active);
  } catch {
    /* model not ready — nothing to do */
  }
}

// Anchored popover for the toolbar's "Layout" button. Shows the six
// layout templates as mini SVG previews; clicking one inserts a new
// slide carrying that template's placeholder elements right after the
// active page (matches PowerPoint behaviour).
//
// We render INTO the toolbar's existing popover slot — same idiom as
// the Shapes menu. CSS in styles.css gives us the column grid.

export interface LayoutPickerProps {
  anchorRect: DOMRect | null;
  onClose: () => void;
}

function insertSlideWithLayout(template: LayoutTemplate): void {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    if (!model) return;
    const unitId = model.getUnitId();

    // Insert right after the active page so the new slide flows from
    // the user's current position. Falls back to append (no index) if
    // the active page can't be located.
    const snapshot = model.getSnapshot();
    const active = model.getActivePage();
    const order = snapshot.body?.pageOrder ?? [];
    const activeIdx = active ? order.indexOf(active.id) : -1;
    const insertIdx = activeIdx >= 0 ? activeIdx + 1 : order.length;

    // zIndex on the new page = max existing + 1 (matches the
    // SlideInsertPageMutation default for Univer-minted pages).
    const maxZ = order.reduce((m, id) => Math.max(m, snapshot.body?.pages?.[id]?.zIndex ?? 0), 0);
    const page = buildPageFromLayout(template, maxZ + 1);

    void dispatchSlideCommand('slide.mutation.insert-page', {
      unitId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: page as any,
      index: insertIdx,
    });
  } catch {
    /* model not ready — nothing to do */
  }
}

export function LayoutPicker({ anchorRect, onClose }: LayoutPickerProps) {
  const { t } = useTranslation('dialogs');
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<LayoutMode>('insert');

  useEffect(() => {
    if (!anchorRect) return;
    const onMouse = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRect, onClose]);

  if (!anchorRect) return null;

  return (
    <div
      ref={ref}
      className="cs-layout-picker"
      style={{ top: anchorRect.bottom + 4, left: anchorRect.left }}
      role="menu"
      data-testid="layout-picker"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="cs-layout-picker__header">
        {mode === 'insert' ? t('layout.headerInsert') : t('layout.headerApply')}
      </div>
      <div className="cs-layout-picker__modes" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'insert'}
          className={`cs-layout-picker__mode ${mode === 'insert' ? 'is-active' : ''}`}
          onClick={() => setMode('insert')}
        >
          {t('layout.modeInsert')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'apply'}
          className={`cs-layout-picker__mode ${mode === 'apply' ? 'is-active' : ''}`}
          onClick={() => setMode('apply')}
        >
          {t('layout.modeApply')}
        </button>
      </div>
      <div className="cs-layout-picker__grid">
        {LAYOUT_TEMPLATES.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            className="cs-layout-picker__tile"
            data-testid={`layout-${tpl.id}`}
            onClick={() => {
              if (mode === 'insert') insertSlideWithLayout(tpl);
              else applyLayoutToCurrent(tpl);
              onClose();
            }}
            title={tpl.label}
          >
            <svg
              viewBox={`0 0 ${PREVIEW_VIEWBOX.w} ${PREVIEW_VIEWBOX.h}`}
              className="cs-layout-picker__preview"
              aria-hidden="true"
            >
              <rect x={0} y={0} width={PREVIEW_VIEWBOX.w} height={PREVIEW_VIEWBOX.h} fill="#FFFFFF" stroke="#E5E7EB" />
              {tpl.preview.map((p, i) => (
                <rect
                  key={i}
                  x={p.x}
                  y={p.y}
                  width={p.w}
                  height={p.h}
                  rx={1}
                  fill={p.kind === 'title' ? '#1F2937' : '#D1D5DB'}
                  opacity={p.kind === 'title' ? 0.85 : 0.6}
                />
              ))}
            </svg>
            <span className="cs-layout-picker__label">{tpl.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

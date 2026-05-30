// Right-side Format pane — appears when an element is selected on the slide
// canvas, hides when selection is cleared.
//
// Architecture
//   The pane lives outside App's prop tree, mounted next to ShortcutsProvider
//   in main.tsx. It reads selection state directly from Univer's render
//   pipeline:
//
//     1. SlideDataModel.activePage$ → which page is focused
//     2. CanvasView.getRenderUnitByPageId(pageId, unitId).scene.getTransformer()
//        → the transformer for that page's canvas
//     3. transformer.createControl$ → fires when a user selects an element
//        transformer.clearControl$  → fires when selection is dropped
//        transformer.changing$      → fires during drag/resize/rotate
//
//   Same hook the upstream TransformPanel + SlidePopupMenuController use
//   (see node_modules/@univerjs/slides-ui/lib/es/index.js around line 2767).
//   No new dependency, no fork-patch needed for the read side.
//
// Shape styling (fill / border / shadow)
//   Position + size go through UpdateSlideElementOperation (the only props
//   it whitelists in v0.24.0). Fill / outline / shadow have NO element-style
//   mutation reachable from outside docs-ui, so — exactly like ThemePicker's
//   text cascade — we write the property directly on the SlideDataModel
//   snapshot and repaint with `incrementRev()` + `setActivePage(active)`.
//   The ShapeAdaptor reads `shapeProperties.shapeBackgroundFill`,
//   `shapeProperties.outline.{outlineFill,weight,dashStyle}` and
//   `shapeProperties.effectLst.outerShdw` on every render pass (see
//   node_modules/@univerjs/slides/lib/es/index.js ShapeAdaptor.convert),
//   so a snapshot write + rev bump visibly re-renders the shape.
//   TODO(collab): these direct writes bypass the command bus; swap to a
//   fork-side mutation when one lands (docs/UNIVER_SLIDES_GAPS.md).
//
//   Opacity is intentionally absent: neither IPageElement nor IShapeProperties
//   carries an alpha field in v0.24.0 and the ShapeAdaptor never sets the
//   engine-render `opacity` prop on shapes — so an opacity control could not
//   change anything on the canvas. Removed rather than shipped disabled.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Univer } from '@univerjs/core';
import {
  BorderStyleTypes,
  ICommandService,
  IUniverInstanceService,
  UniverInstanceType,
} from '@univerjs/core';
import type { IShapeProperties } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { CanvasView } from '@univerjs/slides-ui';
import type { BaseObject } from '@univerjs/engine-render';
import { setSelectedElement } from './selection';
// Inline subscription shape — rxjs isn't a direct dep of apps/web (it
// arrives transitively via @univerjs). Importing the type directly from
// 'rxjs' won't resolve under TS strict; the shape we need is just
// `{ unsubscribe(): void }`.
type Subscription = { unsubscribe(): void };

import { Icon } from './icons';
import { useTranslation } from '../i18n';
import { hexToRgb, rgbToHex } from './toolbar/popover-utils';
import { dispatchSlideCommand } from '../univer/commands';

/* ============================================================ helpers === */

interface UniverWin {
  univer?: Univer;
}

function getUniver(): Univer | null {
  return ((globalThis as UniverWin).univer ?? null) as Univer | null;
}

function getSlideModel(univer: Univer): SlideDataModel | null {
  try {
    return (
      univer
        .__getInjector()
        .get(IUniverInstanceService)
        .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE) ??
      null
    );
  } catch {
    return null;
  }
}

// Pixel→EMU and degree→OOXML-angle conversions for the shadow effect — the
// ShapeAdaptor decodes `effectLst.outerShdw` from EMU (dist/blurRad) and a
// 60000ths-of-a-degree clockwise direction (dir). We invert that here so the
// pane can speak in px offsets.
const EMU_PER_PX = 9525;

// Snapshot of the shape style fields the pane edits, read off the model for
// initial control values. Colours come back as the model's stored rgb
// string (or null when unset).
interface ShapeStyle {
  fill: string | null;
  borderColor: string | null;
  borderWidth: number;
  borderDash: BorderStyleTypes;
  shadowEnabled: boolean;
  shadowColor: string | null;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowBlur: number;
}

const DEFAULT_SHAPE_STYLE: ShapeStyle = {
  fill: null,
  borderColor: null,
  borderWidth: 1,
  borderDash: BorderStyleTypes.THIN,
  shadowEnabled: false,
  shadowColor: '#000000',
  shadowOffsetX: 2,
  shadowOffsetY: 2,
  shadowBlur: 4,
};

// Resolve the selected shape's IShapeProperties on the live snapshot.
// Returns null when the unit / page / element / shape is missing.
function getShapeProperties(
  model: SlideDataModel,
  pageId: string,
  elementId: string,
): IShapeProperties | null {
  const page = model.getPage(pageId);
  const el = page?.pageElements?.[elementId];
  return el?.shape?.shapeProperties ?? null;
}

// Read the current style off the model for seeding the controls.
function readShapeStyle(
  model: SlideDataModel,
  pageId: string,
  elementId: string,
): ShapeStyle {
  const sp = getShapeProperties(model, pageId, elementId);
  if (!sp) return { ...DEFAULT_SHAPE_STYLE };
  const outline = sp.outline;
  const shdw = sp.effectLst?.outerShdw;
  let offX = DEFAULT_SHAPE_STYLE.shadowOffsetX;
  let offY = DEFAULT_SHAPE_STYLE.shadowOffsetY;
  let blur = DEFAULT_SHAPE_STYLE.shadowBlur;
  if (shdw) {
    const distPx = (shdw.dist ?? 0) / EMU_PER_PX;
    const angleRad = ((shdw.dir ?? 0) / 60000) * (Math.PI / 180);
    offX = Math.round(distPx * Math.cos(angleRad));
    offY = Math.round(distPx * Math.sin(angleRad));
    blur = Math.round((shdw.blurRad ?? 0) / EMU_PER_PX / 2);
  }
  return {
    fill: sp.shapeBackgroundFill?.rgb ?? null,
    borderColor: outline?.outlineFill?.rgb ?? null,
    borderWidth: outline?.weight ?? DEFAULT_SHAPE_STYLE.borderWidth,
    borderDash: outline?.dashStyle ?? DEFAULT_SHAPE_STYLE.borderDash,
    shadowEnabled: !!shdw,
    shadowColor: shdw?.color?.rgb ?? DEFAULT_SHAPE_STYLE.shadowColor,
    shadowOffsetX: offX,
    shadowOffsetY: offY,
    shadowBlur: blur,
  };
}

// Mutate the selected shape's properties in place on the snapshot and
// repaint. Same pattern as ThemePicker's text cascade — the ShapeAdaptor
// reads these fields on every render, so a snapshot write + incrementRev +
// setActivePage visibly re-renders the shape.
// TODO(collab): direct snapshot write, not collab-safe.
function mutateShape(
  pageId: string,
  elementId: string,
  patch: (sp: IShapeProperties) => void,
): void {
  const univer = getUniver();
  if (!univer) return;
  const model = getSlideModel(univer);
  if (!model) return;
  const page = model.getPage(pageId);
  const el = page?.pageElements?.[elementId];
  if (!el?.shape) return;
  if (!el.shape.shapeProperties) {
    el.shape.shapeProperties = { shapeBackgroundFill: {} } as IShapeProperties;
  }
  patch(el.shape.shapeProperties);
  model.incrementRev();
  const active = model.getActivePage();
  if (active) model.setActivePage(active);
}

// Build an `effectLst.outerShdw` payload from px offsets. dist is the
// hypotenuse (px→EMU), dir is the clockwise angle from east in
// 60000ths-of-a-degree, blurRad is px→EMU then ×2 to invert the adaptor's
// /2 blur scaling.
function buildOuterShadow(
  color: string,
  offsetX: number,
  offsetY: number,
  blurPx: number,
): NonNullable<IShapeProperties['effectLst']>['outerShdw'] {
  const distPx = Math.hypot(offsetX, offsetY);
  const angleDeg = (Math.atan2(offsetY, offsetX) * 180) / Math.PI;
  return {
    color: { rgb: color },
    dist: Math.round(distPx * EMU_PER_PX),
    dir: Math.round(((angleDeg + 360) % 360) * 60000),
    blurRad: Math.round(blurPx * 2 * EMU_PER_PX),
  };
}

// Snapshot of the currently selected element. We mirror the BaseObject's
// transform here so React re-renders consistently — the BaseObject itself
// mutates in place, which doesn't trigger any React subscription.
interface SelectionSnapshot {
  oKey: string;
  unitId: string;
  pageId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  // `objectType` from engine-render's ObjectType enum. We only need to know
  // whether it's a shape so we can show/hide the Fill section.
  objectType: number;
}

function snapshotFromObject(
  object: BaseObject,
  unitId: string,
  pageId: string,
): SelectionSnapshot {
  return {
    oKey: object.oKey,
    unitId,
    pageId,
    left: object.left ?? 0,
    top: object.top ?? 0,
    width: object.width ?? 0,
    height: object.height ?? 0,
    objectType: object.objectType ?? 0,
  };
}

/* ============================================================ pane root === */

interface FormatPaneInnerProps {
  selection: SelectionSnapshot;
  // Setter passes through to the parent so external transformer events can
  // refresh the snapshot mid-drag.
  onApply: (patch: Partial<Pick<SelectionSnapshot, 'left' | 'top' | 'width' | 'height'>>) => void;
}

export function FormatPane({ selection, onApply }: FormatPaneInnerProps) {
  const { t } = useTranslation('dialogs');
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Focus the first numeric input when the pane first becomes visible for a
  // selection. We do NOT trap focus — Tab moves out into the rest of the
  // app naturally.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      firstInputRef.current?.focus();
      firstInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [selection.oKey]);

  // Aspect-ratio lock. Captured at lock-engage time so subsequent edits
  // keep the locked-in proportion instead of drifting.
  const [aspectLocked, setAspectLocked] = useState(false);
  const lockedRatio = useRef<number | null>(null);

  function toggleAspectLock() {
    if (!aspectLocked) {
      lockedRatio.current =
        selection.height === 0 ? null : selection.width / selection.height;
    } else {
      lockedRatio.current = null;
    }
    setAspectLocked((v) => !v);
  }

  // Only shapes get the Fill section. We never check image/text element
  // types because they don't share a fill model.
  // Engine-render ObjectType: RECT = 4, CIRCLE = 5, SHAPE = 2.
  const isShape =
    selection.objectType === 2 ||
    selection.objectType === 4 ||
    selection.objectType === 5;

  return (
    <aside
      className="cs-format-pane"
      role="complementary"
      aria-label={t('format.ariaLabel')}
      data-testid="format-pane"
    >
      <header className="cs-format-pane__title">
        <Icon name="format_size" size={16} />
        <span>{t('format.title')}</span>
      </header>

      <div className="cs-format-pane__body">
        <PositionSection
          selection={selection}
          onApply={onApply}
          firstInputRef={firstInputRef}
        />
        <SizeSection
          selection={selection}
          onApply={onApply}
          aspectLocked={aspectLocked}
          lockedRatio={lockedRatio.current}
          onToggleLock={toggleAspectLock}
        />
        {isShape && (
          <>
            <FillSection selection={selection} />
            <BorderSection selection={selection} />
            <ShadowSection selection={selection} />
          </>
        )}
        <ArrangeSection />
      </div>
    </aside>
  );
}

/* ============================================================ arrange ===== */

// Bring forward / send backward / bring to front / send to back. Dispatches
// `casual-slides.command.z-order` (intercepted in dispatchSlideCommand —
// see univer/commands.ts applyZOrder). Mirrors the keyboard bindings
// documented in the Ctrl+/ Elements section, so users who don't know
// the shortcuts can still rearrange the layer stack.
function ArrangeSection() {
  const { t } = useTranslation('dialogs');
  return (
    <Section sectionKey="arrange" defaultOpen={false}>
      <div className="cs-format-pane__row cs-format-pane__row--arrange">
        <button
          type="button"
          className="cs-format-pane__arrange-btn"
          title={t('format.arrange.bringForward')}
          aria-label={t('format.arrange.bringForward')}
          onClick={() => void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'forward' })}
        >
          <Icon name="arrow_upward" size={16} />
        </button>
        <button
          type="button"
          className="cs-format-pane__arrange-btn"
          title={t('format.arrange.sendBackward')}
          aria-label={t('format.arrange.sendBackward')}
          onClick={() => void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'backward' })}
        >
          <Icon name="arrow_downward" size={16} />
        </button>
        <button
          type="button"
          className="cs-format-pane__arrange-btn"
          title={t('format.arrange.bringToFront')}
          aria-label={t('format.arrange.bringToFront')}
          onClick={() => void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'front' })}
        >
          <Icon name="vertical_align_top" size={16} />
        </button>
        <button
          type="button"
          className="cs-format-pane__arrange-btn"
          title={t('format.arrange.sendToBack')}
          aria-label={t('format.arrange.sendToBack')}
          onClick={() => void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'back' })}
        >
          <Icon name="vertical_align_bottom" size={16} />
        </button>
      </div>
    </Section>
  );
}

/* ============================================================ section wrapper */

interface SectionProps {
  sectionKey: 'position' | 'size' | 'fill' | 'border' | 'shadow' | 'arrange';
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function persistKey(sectionKey: SectionProps['sectionKey']) {
  return `cs.formatPane.${sectionKey}.open`;
}

function readPersist(sectionKey: SectionProps['sectionKey'], defaultOpen: boolean): boolean {
  if (typeof window === 'undefined') return defaultOpen;
  try {
    const raw = window.localStorage.getItem(persistKey(sectionKey));
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    /* private mode — fall through */
  }
  return defaultOpen;
}

function writePersist(sectionKey: SectionProps['sectionKey'], open: boolean) {
  try {
    window.localStorage.setItem(persistKey(sectionKey), open ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function Section({ sectionKey, defaultOpen = true, children }: SectionProps) {
  const { t } = useTranslation('dialogs');
  const [open, setOpen] = useState(() => readPersist(sectionKey, defaultOpen));

  const label = t(`format.sections.${sectionKey}`);
  const toggleLabel = open
    ? t('format.collapseSection', { section: label })
    : t('format.expandSection', { section: label });

  function toggle() {
    setOpen((v) => {
      const next = !v;
      writePersist(sectionKey, next);
      return next;
    });
  }

  return (
    <section
      className={`cs-format-pane__section${open ? ' is-open' : ''}`}
      data-section={sectionKey}
    >
      <button
        type="button"
        className="cs-format-pane__section-header"
        aria-expanded={open}
        aria-label={toggleLabel}
        onClick={toggle}
      >
        <span>{label}</span>
        <Icon name={open ? 'chevron_up' : 'chevron_down'} size={14} />
      </button>
      {open && <div className="cs-format-pane__section-body">{children}</div>}
    </section>
  );
}

/* ============================================================ position ===== */

interface PositionSectionProps {
  selection: SelectionSnapshot;
  onApply: FormatPaneInnerProps['onApply'];
  firstInputRef: React.RefObject<HTMLInputElement>;
}

function PositionSection({ selection, onApply, firstInputRef }: PositionSectionProps) {
  const { t } = useTranslation('dialogs');
  return (
    <Section sectionKey="position">
      <div className="cs-format-pane__row">
        <NumericField
          label={t('format.position.x')}
          ariaLabel={t('format.position.xAria')}
          value={selection.left}
          inputRef={firstInputRef}
          onCommit={(v) => onApply({ left: v })}
        />
        <NumericField
          label={t('format.position.y')}
          ariaLabel={t('format.position.yAria')}
          value={selection.top}
          onCommit={(v) => onApply({ top: v })}
        />
      </div>
    </Section>
  );
}

/* ============================================================ size ======== */

interface SizeSectionProps {
  selection: SelectionSnapshot;
  onApply: FormatPaneInnerProps['onApply'];
  aspectLocked: boolean;
  lockedRatio: number | null;
  onToggleLock: () => void;
}

function SizeSection({
  selection,
  onApply,
  aspectLocked,
  lockedRatio,
  onToggleLock,
}: SizeSectionProps) {
  const { t } = useTranslation('dialogs');

  function commitWidth(next: number) {
    if (aspectLocked && lockedRatio && lockedRatio > 0) {
      onApply({ width: next, height: Math.round(next / lockedRatio) });
    } else {
      onApply({ width: next });
    }
  }
  function commitHeight(next: number) {
    if (aspectLocked && lockedRatio && lockedRatio > 0) {
      onApply({ width: Math.round(next * lockedRatio), height: next });
    } else {
      onApply({ height: next });
    }
  }

  return (
    <Section sectionKey="size">
      <div className="cs-format-pane__row">
        <NumericField
          label={t('format.size.width')}
          ariaLabel={t('format.size.widthAria')}
          value={selection.width}
          onCommit={commitWidth}
        />
        <NumericField
          label={t('format.size.height')}
          ariaLabel={t('format.size.heightAria')}
          value={selection.height}
          onCommit={commitHeight}
        />
        <button
          type="button"
          className={`cs-format-pane__lock${aspectLocked ? ' is-locked' : ''}`}
          onClick={onToggleLock}
          aria-pressed={aspectLocked}
          aria-label={
            aspectLocked
              ? t('format.size.unlockAspect')
              : t('format.size.lockAspect')
          }
          title={
            aspectLocked
              ? t('format.size.unlockAspect')
              : t('format.size.lockAspect')
          }
        >
          <Icon name={aspectLocked ? 'lock' : 'lock_open'} size={14} filled={aspectLocked} />
        </button>
      </div>
    </Section>
  );
}

/* ============================================================ style hook == */

// Seed each style section from the live model, re-reading whenever the
// selected element changes. Returns the snapshot + a setter that updates
// local state so controls stay responsive between model reads.
function useShapeStyle(selection: SelectionSnapshot): [ShapeStyle, (next: ShapeStyle) => void] {
  const [style, setStyle] = useState<ShapeStyle>(() => {
    const univer = getUniver();
    const model = univer ? getSlideModel(univer) : null;
    return model
      ? readShapeStyle(model, selection.pageId, selection.oKey)
      : { ...DEFAULT_SHAPE_STYLE };
  });
  useEffect(() => {
    const univer = getUniver();
    const model = univer ? getSlideModel(univer) : null;
    setStyle(
      model
        ? readShapeStyle(model, selection.pageId, selection.oKey)
        : { ...DEFAULT_SHAPE_STYLE },
    );
  }, [selection.pageId, selection.oKey]);
  return [style, setStyle];
}

/* ============================================================ fill ======== */

// Fill writes `shapeProperties.shapeBackgroundFill = { rgb }` on the
// snapshot; ShapeAdaptor.convert reads it into the engine-render Rect/Circle
// `fill` prop on every render pass, so the bump repaints. "No fill" sets a
// transparent rgba so the adaptor's getColorStyle resolves to transparent.
function FillSection({ selection }: { selection: SelectionSnapshot }) {
  const { t } = useTranslation('dialogs');
  const [style, setStyle] = useShapeStyle(selection);

  function apply(rgb: string) {
    mutateShape(selection.pageId, selection.oKey, (sp) => {
      sp.shapeBackgroundFill = { rgb };
    });
    setStyle({ ...style, fill: rgb });
  }

  return (
    <Section sectionKey="fill">
      <ColorRow
        label={t('format.fill.label')}
        value={style.fill}
        onChange={apply}
        onClear={() => apply('rgba(0,0,0,0)')}
        clearLabel={t('format.fill.none')}
      />
    </Section>
  );
}

/* ============================================================ border ===== */

// Maps the 3-way solid/dashed/dotted segmented control to BorderStyleTypes
// (THIN=solid / DASHED / DOTTED) — the values ShapeAdaptor's dashMap honours.
const DASH_OPTIONS: { key: 'solid' | 'dashed' | 'dotted'; value: BorderStyleTypes }[] = [
  { key: 'solid', value: BorderStyleTypes.THIN },
  { key: 'dashed', value: BorderStyleTypes.DASHED },
  { key: 'dotted', value: BorderStyleTypes.DOTTED },
];

function dashKeyOf(v: BorderStyleTypes): 'solid' | 'dashed' | 'dotted' {
  if (v === BorderStyleTypes.DASHED) return 'dashed';
  if (v === BorderStyleTypes.DOTTED) return 'dotted';
  return 'solid';
}

// Border writes `shapeProperties.outline = { outlineFill, weight, dashStyle }`.
// ShapeAdaptor reads outlineFill→stroke, weight→strokeWidth, dashStyle→
// strokeDashArray. We default the colour to near-black when the shape has no
// outline yet so the first edit is visible.
function BorderSection({ selection }: { selection: SelectionSnapshot }) {
  const { t } = useTranslation('dialogs');
  const [style, setStyle] = useShapeStyle(selection);

  function patchOutline(next: Partial<Pick<ShapeStyle, 'borderColor' | 'borderWidth' | 'borderDash'>>) {
    const merged = { ...style, ...next };
    mutateShape(selection.pageId, selection.oKey, (sp) => {
      sp.outline = {
        ...sp.outline,
        outlineFill: { rgb: merged.borderColor ?? 'rgb(34, 38, 45)' },
        weight: merged.borderWidth,
        dashStyle: merged.borderDash,
      };
    });
    setStyle(merged);
  }

  return (
    <Section sectionKey="border">
      <ColorRow
        label={t('format.border.colorLabel')}
        value={style.borderColor}
        onChange={(rgb) => patchOutline({ borderColor: rgb })}
        onClear={() => {
          mutateShape(selection.pageId, selection.oKey, (sp) => {
            sp.outline = {
              ...sp.outline,
              outlineFill: { rgb: 'rgba(0,0,0,0)' },
              weight: 0,
              dashStyle: BorderStyleTypes.NONE,
            };
          });
          setStyle({ ...style, borderColor: null, borderWidth: 0 });
        }}
        clearLabel={t('format.border.none')}
      />
      <div className="cs-format-pane__row">
        <NumericField
          label={t('format.border.widthLabel')}
          ariaLabel={t('format.border.widthAria')}
          value={style.borderWidth}
          onCommit={(width) => patchOutline({ borderWidth: width })}
          min={0}
        />
      </div>
      <div className="cs-format-pane__row cs-format-pane__row--col">
        <span className="cs-format-pane__field-label">
          {t('format.border.dashLabel')}
        </span>
        <div className="cs-format-pane__segmented" role="radiogroup">
          {DASH_OPTIONS.map((opt) => {
            const active = dashKeyOf(style.borderDash) === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={active}
                className={`cs-format-pane__seg${active ? ' is-active' : ''}`}
                onClick={() => patchOutline({ borderDash: opt.value })}
              >
                {t(`format.border.dash.${opt.key}`)}
              </button>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

/* ============================================================ shadow ===== */

// Shadow writes `shapeProperties.effectLst.outerShdw` (EMU dist + 60000ths
// dir + EMU blurRad). ShapeAdaptor.convert decodes outerShdw into the
// engine-render shadow* props (shadowEnabled / shadowColor / shadowOffsetX/Y
// / shadowBlur), so the bump repaints the drop shadow. Toggling off deletes
// the effectLst so the shape renders flat again.
function ShadowSection({ selection }: { selection: SelectionSnapshot }) {
  const { t } = useTranslation('dialogs');
  const [style, setStyle] = useShapeStyle(selection);

  function writeShadow(next: ShapeStyle) {
    mutateShape(selection.pageId, selection.oKey, (sp) => {
      if (!next.shadowEnabled) {
        if (sp.effectLst) delete sp.effectLst.outerShdw;
        return;
      }
      sp.effectLst = {
        ...sp.effectLst,
        outerShdw: buildOuterShadow(
          next.shadowColor ?? '#000000',
          next.shadowOffsetX,
          next.shadowOffsetY,
          next.shadowBlur,
        ),
      };
    });
    setStyle(next);
  }

  return (
    <Section sectionKey="shadow" defaultOpen={false}>
      <label className="cs-format-pane__toggle">
        <input
          type="checkbox"
          checked={style.shadowEnabled}
          onChange={(e) => writeShadow({ ...style, shadowEnabled: e.target.checked })}
        />
        <span>{t('format.shadow.enable')}</span>
      </label>
      <ColorRow
        label={t('format.shadow.colorLabel')}
        value={style.shadowColor}
        onChange={(rgb) => writeShadow({ ...style, shadowEnabled: true, shadowColor: rgb })}
      />
      <div className="cs-format-pane__row">
        <NumericField
          label={t('format.shadow.offsetX')}
          ariaLabel={t('format.shadow.offsetXAria')}
          value={style.shadowOffsetX}
          onCommit={(v) => writeShadow({ ...style, shadowEnabled: true, shadowOffsetX: v })}
        />
        <NumericField
          label={t('format.shadow.offsetY')}
          ariaLabel={t('format.shadow.offsetYAria')}
          value={style.shadowOffsetY}
          onCommit={(v) => writeShadow({ ...style, shadowEnabled: true, shadowOffsetY: v })}
        />
      </div>
      <div className="cs-format-pane__row">
        <NumericField
          label={t('format.shadow.blur')}
          ariaLabel={t('format.shadow.blurAria')}
          value={style.shadowBlur}
          onCommit={(v) => writeShadow({ ...style, shadowEnabled: true, shadowBlur: v })}
          min={0}
        />
      </div>
    </Section>
  );
}

/* ============================================================ widgets ==== */

interface NumericFieldProps {
  label: string;
  ariaLabel: string;
  value: number;
  onCommit: (next: number) => void;
  inputRef?: React.RefObject<HTMLInputElement>;
  min?: number;
  disabled?: boolean;
  disabledTooltip?: string;
}

// Numeric field with controlled editing state, commit on blur or Enter,
// revert on Escape. We keep an internal `draft` string so the user can
// type freely (e.g. "12" → "120" → backspace) without the parent
// snapping mid-edit on each keystroke.
function NumericField({
  label,
  ariaLabel,
  value,
  onCommit,
  inputRef,
  min,
  disabled,
  disabledTooltip,
}: NumericFieldProps) {
  const [draft, setDraft] = useState<string>(() => String(Math.round(value)));
  const [editing, setEditing] = useState(false);

  // Reflect external changes (e.g. drag from canvas) into the draft only
  // when the field isn't currently being typed in — otherwise the user's
  // typing would be clobbered.
  useEffect(() => {
    if (!editing) setDraft(String(Math.round(value)));
  }, [value, editing]);

  function commit() {
    setEditing(false);
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(Math.round(value)));
      return;
    }
    const clamped = min !== undefined ? Math.max(min, parsed) : parsed;
    if (Math.round(clamped) === Math.round(value)) {
      setDraft(String(Math.round(value)));
      return;
    }
    onCommit(Math.round(clamped));
  }

  return (
    <label
      className={`cs-format-pane__field${disabled ? ' is-disabled' : ''}`}
      title={disabled ? disabledTooltip : undefined}
    >
      <span className="cs-format-pane__field-label">{label}</span>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        className="cs-format-pane__input"
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(String(Math.round(value)));
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

interface ColorRowProps {
  label: string;
  // Null when the property is unset / transparent. The swatch then shows
  // a placeholder and the hex falls back to a sensible default for editing.
  value: string | null;
  onChange: (rgb: string) => void;
  // Optional "no fill" / clear affordance (fill + border only).
  onClear?: () => void;
  clearLabel?: string;
}

// Single-row colour input wired to the live model. The native `<input
// type="color">` always edits in hex; `onChange` hands the parent an
// `rgb(r, g, b)` string so the model only ever stores one colour shape
// (matching the toolbar/BackgroundPicker convention). The optional clear
// button sets the property transparent.
function ColorRow({ label, value, onChange, onClear, clearLabel }: ColorRowProps) {
  const isTransparent = !value || /rgba?\([^)]*,\s*0\s*\)/i.test(value);
  const hex = useMemo(() => rgbToHex(value), [value]);
  return (
    <div className="cs-format-pane__color-row">
      <span className="cs-format-pane__field-label">{label}</span>
      <span className="cs-format-pane__color-input">
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            const rgb = hexToRgb(e.target.value);
            onChange(rgb ?? e.target.value);
          }}
          aria-label={label}
        />
        <span className="cs-format-pane__color-hex">
          {isTransparent ? '—' : hex.toUpperCase()}
        </span>
        {onClear && (
          <button
            type="button"
            className="cs-format-pane__color-clear"
            onClick={onClear}
            aria-label={clearLabel}
            title={clearLabel}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </span>
    </div>
  );
}

/* ============================================================ provider === */

// Self-contained mount point. Owns:
//   - the active SelectionSnapshot (null when nothing is selected)
//   - the subscription chain (active page → transformer events)
//   - apply-dispatches for the wired props (position + size)
//
// Mounted alongside <App /> in main.tsx — no prop drilling.
export function FormatPaneProvider() {
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);

  // Mirror the React selection into the module-level selection bridge so the
  // Toolbar's fill/border colour pickers can target the same shape. The
  // FormatPane is the single source of truth for "what's selected" (it owns
  // the transformer subscription); the Toolbar only reads.
  useEffect(() => {
    setSelectedElement(
      selection ? { pageId: selection.pageId, elementId: selection.oKey } : null,
    );
    return () => {
      // On unmount, drop the shared selection so the toolbar disables its
      // shape-targeted colour pickers.
      setSelectedElement(null);
    };
  }, [selection]);

  // We chain three subscriptions:
  //   1. Poll for `window.univer` until the unit is mounted.
  //   2. Subscribe to SlideDataModel.activePage$ to learn the active page.
  //   3. On each active page change, attach to that page's transformer
  //      events and emit the current selection. Cleanup on unmount or page
  //      switch unsubscribes the prior transformer subs.
  useEffect(() => {
    let disposed = false;
    let retryHandle: number | null = null;
    let activePageSub: Subscription | null = null;
    let perPageDispose: (() => void) | null = null;
    let wiredUnitId: string | null = null;
    let swapWatch: number | null = null;

    const wirePage = (
      univer: Univer,
      unitId: string,
      pageId: string,
    ): (() => void) => {
      try {
        const canvasView = univer.__getInjector().get(CanvasView);
        const renderUnit = canvasView.getRenderUnitByPageId(pageId, unitId);
        const scene = renderUnit?.scene;
        const transformer = scene?.getTransformer();
        if (!transformer) {
          return () => {};
        }
        // Seed: if a selection already exists from the prior page, mirror
        // it into state immediately so the pane doesn't flash empty.
        const seedObj = transformer.getSelectedObjectMap().values().next().value;
        if (seedObj) {
          setSelection(snapshotFromObject(seedObj, unitId, pageId));
        } else {
          setSelection(null);
        }

        const subs: Subscription[] = [];
        subs.push(
          transformer.createControl$.subscribe(() => {
            const map = transformer.getSelectedObjectMap();
            const object = map.values().next().value;
            if (!object) {
              setSelection(null);
              return;
            }
            setSelection(snapshotFromObject(object, unitId, pageId));
          }),
        );
        subs.push(
          transformer.clearControl$.subscribe(() => {
            // The clearControl$ also fires when a single click reselects
            // mid-drag. Re-check the selected map: if still populated, the
            // event is a no-op for us; if empty, hide the pane.
            const map = transformer.getSelectedObjectMap();
            if (map.size === 0) {
              setSelection(null);
            }
          }),
        );
        subs.push(
          transformer.changing$.subscribe(() => {
            const map = transformer.getSelectedObjectMap();
            const object = map.values().next().value;
            if (!object) return;
            setSelection(snapshotFromObject(object, unitId, pageId));
          }),
        );
        subs.push(
          transformer.changeEnd$.subscribe(() => {
            const map = transformer.getSelectedObjectMap();
            const object = map.values().next().value;
            if (!object) return;
            setSelection(snapshotFromObject(object, unitId, pageId));
          }),
        );
        return () => {
          subs.forEach((s) => s.unsubscribe());
        };
      } catch {
        return () => {};
      }
    };

    const wireUniver = () => {
      if (disposed) return;
      const univer = getUniver();
      if (!univer) {
        retryHandle = window.setTimeout(wireUniver, 200);
        return;
      }
      try {
        const instances = univer.__getInjector().get(IUniverInstanceService);
        const model = instances.getCurrentUnitOfType<SlideDataModel>(
          UniverInstanceType.UNIVER_SLIDE,
        );
        if (!model) {
          retryHandle = window.setTimeout(wireUniver, 200);
          return;
        }
        const unitId = model.getUnitId();

        const reattach = (pageId: string | null | undefined) => {
          perPageDispose?.();
          perPageDispose = null;
          if (!pageId) {
            setSelection(null);
            return;
          }
          perPageDispose = wirePage(univer, unitId, pageId);
        };

        const seed = model.getActivePage();
        if (seed) reattach(seed.id);

        activePageSub = model.activePage$.subscribe((page) => {
          if (disposed) return;
          reattach(page?.id ?? null);
        });
        wiredUnitId = unitId;
      } catch {
        retryHandle = window.setTimeout(wireUniver, 200);
      }
    };

    // Tear down the current subscriptions (used on deck swap + unmount).
    const teardown = () => {
      activePageSub?.unsubscribe();
      activePageSub = null;
      perPageDispose?.();
      perPageDispose = null;
    };

    wireUniver();

    // Opening a .pptx swaps in a fresh Univer instance (UniverSlide is keyed
    // on snapshot.id), disposing the model we subscribed to — activePage$ +
    // the transformer controls go silent and the pane would stop tracking
    // selections on the new deck. Poll the live unitId; on change, tear down
    // and re-wire to the new model. Same guard the slide rail uses.
    swapWatch = window.setInterval(() => {
      if (disposed) return;
      const u = getUniver();
      if (!u) return;
      let liveUnitId: string | null = null;
      try {
        liveUnitId = u
          .__getInjector()
          .get(IUniverInstanceService)
          .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE)
          ?.getUnitId() ?? null;
      } catch {
        return;
      }
      if (liveUnitId && liveUnitId !== wiredUnitId) {
        teardown();
        setSelection(null);
        wireUniver();
      }
    }, 400);

    return () => {
      disposed = true;
      if (retryHandle != null) window.clearTimeout(retryHandle);
      if (swapWatch != null) window.clearInterval(swapWatch);
      teardown();
    };
  }, []);

  // Apply a position/size patch to the selected element. Uses the same
  // operation TransformPanel + SlidePopupMenuController dispatch upstream
  // (UpdateSlideElementOperation, id 'slide.operation.update-element').
  // We also mutate the BaseObject in place so the canvas reflects the
  // change without waiting for a re-render pass.
  const apply = useCallback(
    (patch: Partial<Pick<SelectionSnapshot, 'left' | 'top' | 'width' | 'height'>>) => {
      if (!selection) return;
      const univer = getUniver();
      if (!univer) return;
      try {
        const canvasView = univer.__getInjector().get(CanvasView);
        const scene = canvasView.getRenderUnitByPageId(
          selection.pageId,
          selection.unitId,
        )?.scene;
        const transformer = scene?.getTransformer();
        const object = transformer
          ?.getSelectedObjectMap()
          .values()
          .next().value as BaseObject | undefined;

        const cs = univer.__getInjector().get(ICommandService);
        void cs.executeCommand('slide.operation.update-element', {
          unitId: selection.unitId,
          oKey: selection.oKey,
          props: patch,
        });

        if (object) {
          if (patch.left !== undefined || patch.top !== undefined) {
            object.translate(
              patch.left ?? object.left,
              patch.top ?? object.top,
            );
          }
          if (patch.width !== undefined || patch.height !== undefined) {
            object.resize(
              patch.width ?? object.width,
              patch.height ?? object.height,
            );
          }
          transformer?.refreshControls();
        }

        // Mirror locally so the UI shows the new value immediately,
        // independent of when the transformer's change$ stream emits.
        setSelection((prev) => (prev ? { ...prev, ...patch } : prev));
      } catch {
        /* swallow — operation can fail if the unit was torn down */
      }
    },
    [selection],
  );

  // Tag the document body so global CSS can shrink the workspace + notes
  // + status bar to make room for the pane. We avoid mutating App.tsx's
  // tree — same isolation pattern as ShortcutsProvider.
  useEffect(() => {
    const cls = 'cs-format-pane-open';
    const open = !!selection;
    if (open) {
      document.body.classList.add(cls);
    } else {
      document.body.classList.remove(cls);
    }
    // Fire a custom event so App.tsx can auto-zoom the canvas + recenter
    // while the workspace margin animates. We can't drive zoom from here
    // — it's owned by App.tsx — so we publish, App subscribes.
    window.dispatchEvent(new CustomEvent('cs:format-pane', { detail: { open } }));
    return () => {
      document.body.classList.remove(cls);
      window.dispatchEvent(new CustomEvent('cs:format-pane', { detail: { open: false } }));
    };
  }, [selection]);

  // Arrow-key nudge for the selected element. 1 px per tap, 10 px with
  // Shift — same grain as Google Slides / PowerPoint. We bail out when
  // the focus is on an editable surface (input, textarea, contenteditable
  // — covers the filename rename, Find&Replace input, and Univer's
  // text-edit overlay), so the keys still drive the caret in those
  // contexts. preventDefault stops the browser from page-scrolling on
  // ArrowDown/ArrowUp while the user nudges.
  useEffect(() => {
    if (!selection) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      e.preventDefault();
      apply({ left: selection.left + dx, top: selection.top + dy });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selection, apply]);

  // Tab / Shift+Tab cycles selection through the active page's elements.
  // Reads the page's pageElements order from the slide model + filters
  // the canvas's BaseObject list so we only land on user shapes (skips
  // overlay/transformer controls). Wraps at the ends. Skipped when focus
  // is on an editable surface so Tab keeps its native indent/focus
  // behaviour inside text frames and HTML inputs.
  useEffect(() => {
    if (!selection) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      const univer = getUniver();
      if (!univer) return;
      try {
        const instances = univer.__getInjector().get(IUniverInstanceService);
        const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
        if (!model) return;
        const snap = model.getSnapshot();
        const page = snap.body?.pages?.[selection.pageId];
        const ids = Object.keys(page?.pageElements ?? {});
        if (ids.length < 2) return;
        const canvasView = univer.__getInjector().get(CanvasView);
        const scene = canvasView.getRenderUnitByPageId(selection.pageId, selection.unitId)?.scene;
        const transformer = scene?.getTransformer();
        if (!scene || !transformer) return;
        const objs = scene.getAllObjectsByOrder().filter((o) => ids.includes(o.oKey));
        if (objs.length < 2) return;
        const currentIdx = Math.max(0, objs.findIndex((o) => o.oKey === selection.oKey));
        const nextIdx = e.shiftKey
          ? (currentIdx - 1 + objs.length) % objs.length
          : (currentIdx + 1) % objs.length;
        e.preventDefault();
        transformer.clearControls();
        transformer.attachTo(objs[nextIdx]);
      } catch {
        /* unit torn down mid-cycle — ignore */
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selection]);

  // Hidden entirely when there's nothing to format — Google-Slides UX.
  if (!selection) {
    return <aside className="cs-format-pane is-hidden" aria-hidden="true" />;
  }

  return <FormatPane selection={selection} onApply={apply} />;
}

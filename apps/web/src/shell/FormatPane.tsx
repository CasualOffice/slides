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
// Univer command gaps
//   v0.24.0 only exposes UpdateSlideElementOperation with { left, top,
//   width, height, angle } as supported `props`. There is NO clean
//   mutation for shape fill / outline / shadow / opacity on a SELECTED
//   element. The fill/border/shadow/opacity inputs are rendered disabled
//   with a tooltip so the UX surface is present but we don't fake
//   dispatches. See `TODO(univer)` comments below.
//
//   When the fork-patch in docs/UNIVER_SLIDES_GAPS.md lands a real fill/
//   outline mutation, swap the disabled inputs to live ones — no other
//   change needed in this file.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Univer } from '@univerjs/core';
import {
  ICommandService,
  IUniverInstanceService,
  UniverInstanceType,
} from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
import { CanvasView } from '@univerjs/slides-ui';
import type { BaseObject } from '@univerjs/engine-render';
// Inline subscription shape — rxjs isn't a direct dep of apps/web (it
// arrives transitively via @univerjs). Importing the type directly from
// 'rxjs' won't resolve under TS strict; the shape we need is just
// `{ unsubscribe(): void }`.
type Subscription = { unsubscribe(): void };

import { Icon } from './icons';
import { useTranslation } from '../i18n';
import { hexToRgb, rgbToHex } from './toolbar/popover-utils';

/* ============================================================ helpers === */

interface UniverWin {
  univer?: Univer;
}

function getUniver(): Univer | null {
  return ((globalThis as UniverWin).univer ?? null) as Univer | null;
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
        {isShape && <FillSection />}
        <BorderSection />
        <ShadowSection />
        <OpacitySection />
      </div>
    </aside>
  );
}

/* ============================================================ section wrapper */

interface SectionProps {
  sectionKey: 'position' | 'size' | 'fill' | 'border' | 'shadow' | 'opacity';
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

/* ============================================================ fill ======== */

// TODO(univer): UpdateSlideElementOperation only accepts left/top/width/
// height/angle in v0.24.0. Shape fill is stored on
// `IPageElement.shape.shapeProperties.shapeBackgroundFill` but there's no
// mutation to patch it on a selected element. Once the fork-patch (see
// docs/UNIVER_SLIDES_GAPS.md) extends the operation's `props` whitelist,
// switch this to a live ColorPicker like the toolbar's.
function FillSection() {
  const { t } = useTranslation('dialogs');
  const [value, setValue] = useState<string>('#ffffff');
  return (
    <Section sectionKey="fill">
      <DisabledColorRow
        label={t('format.fill.label')}
        value={value}
        onChange={setValue}
      />
    </Section>
  );
}

/* ============================================================ border ===== */

// TODO(univer): Same gap as fill. `outline` lives on
// shape.shapeProperties.outline but no mutation exposes a single-element
// patch. Disabled with a tooltip until the patch lands.
function BorderSection() {
  const { t } = useTranslation('dialogs');
  const [color, setColor] = useState<string>('#222630');
  const [width, setWidth] = useState<number>(1);
  const [dash, setDash] = useState<'solid' | 'dashed' | 'dotted'>('solid');
  return (
    <Section sectionKey="border">
      <DisabledColorRow
        label={t('format.border.colorLabel')}
        value={color}
        onChange={setColor}
      />
      <div className="cs-format-pane__row">
        <NumericField
          label={t('format.border.widthLabel')}
          ariaLabel={t('format.border.widthAria')}
          value={width}
          onCommit={setWidth}
          disabled
          disabledTooltip={t('format.todoUniver')}
          min={0}
        />
      </div>
      <div
        className="cs-format-pane__row cs-format-pane__row--col"
        title={t('format.todoUniver')}
      >
        <span className="cs-format-pane__field-label">
          {t('format.border.dashLabel')}
        </span>
        <div className="cs-format-pane__segmented" role="radiogroup">
          {(['solid', 'dashed', 'dotted'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={dash === opt}
              className={`cs-format-pane__seg${dash === opt ? ' is-active' : ''}`}
              onClick={() => setDash(opt)}
              disabled
              title={t('format.todoUniver')}
            >
              {t(`format.border.dash.${opt}`)}
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* ============================================================ shadow ===== */

// TODO(univer): No shadow primitive in IPageElement or shapeProperties in
// v0.24.0. Effect lives on the OOXML side (a:effectLst) and would need a
// new field on the model. Tracked in UNIVER_SLIDES_GAPS.md.
function ShadowSection() {
  const { t } = useTranslation('dialogs');
  const [enabled, setEnabled] = useState(false);
  const [color, setColor] = useState<string>('#000000');
  const [ox, setOx] = useState(2);
  const [oy, setOy] = useState(2);
  const [blur, setBlur] = useState(4);

  return (
    <Section sectionKey="shadow" defaultOpen={false}>
      <label
        className="cs-format-pane__toggle"
        title={t('format.todoUniver')}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled
        />
        <span>{t('format.shadow.enable')}</span>
      </label>
      <DisabledColorRow
        label={t('format.shadow.colorLabel')}
        value={color}
        onChange={setColor}
      />
      <div className="cs-format-pane__row">
        <NumericField
          label={t('format.shadow.offsetX')}
          ariaLabel={t('format.shadow.offsetXAria')}
          value={ox}
          onCommit={setOx}
          disabled
          disabledTooltip={t('format.todoUniver')}
        />
        <NumericField
          label={t('format.shadow.offsetY')}
          ariaLabel={t('format.shadow.offsetYAria')}
          value={oy}
          onCommit={setOy}
          disabled
          disabledTooltip={t('format.todoUniver')}
        />
      </div>
      <div className="cs-format-pane__row">
        <NumericField
          label={t('format.shadow.blur')}
          ariaLabel={t('format.shadow.blurAria')}
          value={blur}
          onCommit={setBlur}
          disabled
          disabledTooltip={t('format.todoUniver')}
          min={0}
        />
      </div>
    </Section>
  );
}

/* ============================================================ opacity ==== */

// TODO(univer): No opacity field on IPageElement / shapeProperties. Would
// need an `alpha` add to the model + UpdateSlideElementOperation. Slider
// is rendered disabled.
function OpacitySection() {
  const { t } = useTranslation('dialogs');
  const [value, setValue] = useState(100);
  return (
    <Section sectionKey="opacity" defaultOpen={false}>
      <div
        className="cs-format-pane__row cs-format-pane__row--col"
        title={t('format.todoUniver')}
      >
        <div className="cs-format-pane__opacity-head">
          <span className="cs-format-pane__field-label">
            {t('format.opacity.label')}
          </span>
          <span className="cs-format-pane__opacity-value">
            {t('format.opacity.percent', { value })}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          aria-label={t('format.opacity.aria')}
          className="cs-format-pane__opacity"
          disabled
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

interface DisabledColorRowProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
}

// Single-row colour input. Disabled because Univer has no mutation we can
// dispatch yet (see file header). When the patch lands, replace with the
// shared ColorPicker.
function DisabledColorRow({ label, value, onChange }: DisabledColorRowProps) {
  const { t } = useTranslation('dialogs');
  const tip = t('format.todoUniver');
  const hex = useMemo(() => {
    if (value.startsWith('#')) return value;
    return rgbToHex(value);
  }, [value]);
  return (
    <label
      className="cs-format-pane__color-row is-disabled"
      title={tip}
    >
      <span className="cs-format-pane__field-label">{label}</span>
      <span className="cs-format-pane__color-input">
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            const rgb = hexToRgb(e.target.value);
            if (rgb) onChange(rgb);
            else onChange(e.target.value);
          }}
          disabled
          aria-label={label}
        />
        <span className="cs-format-pane__color-hex">{hex.toUpperCase()}</span>
      </span>
    </label>
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
      } catch {
        retryHandle = window.setTimeout(wireUniver, 200);
      }
    };

    wireUniver();

    return () => {
      disposed = true;
      if (retryHandle != null) window.clearTimeout(retryHandle);
      activePageSub?.unsubscribe();
      perPageDispose?.();
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
    if (selection) {
      document.body.classList.add(cls);
    } else {
      document.body.classList.remove(cls);
    }
    return () => {
      document.body.classList.remove(cls);
    };
  }, [selection]);

  // Hidden entirely when there's nothing to format — Google-Slides UX.
  if (!selection) {
    return <aside className="cs-format-pane is-hidden" aria-hidden="true" />;
  }

  return <FormatPane selection={selection} onApply={apply} />;
}

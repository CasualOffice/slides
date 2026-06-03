import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Univer } from '@univerjs/core';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { IPageElement, ISlidePage, SlideDataModel } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';
import { useTranslation } from '../i18n';
import { Icon } from './icons';
import { dispatchSlideCommand } from '../univer/commands';

// Find & replace dialog.
//
// Industry-standard UX (Google Slides, Microsoft Word for the Web): a
// floating popover anchored top-right of the workspace, persistent until
// dismissed via Esc / close button. Pressing Ctrl+F (Cmd+F on Mac) toggles
// the dialog; while focus is inside a text frame (Univer's own editor)
// we let the platform handler run instead — same guard as App.tsx's
// keyboard shortcuts.
//
// The component is self-contained: `<FindReplaceProvider />` owns the
// global keydown listener + open state so it can be mounted next to <App />
// in main.tsx without prop drilling. Same shape as ShortcutsProvider.
//
// Search scope: every text-bearing element on every SLIDE page. That's
// PageElementType.TEXT (richText.text) and PageElementType.SHAPE
// (shape.text) — matching the same scan PropertiesDialog uses for the
// "Text length" stat. Speaker notes are NOT scoped here yet; they live
// on a separate per-page property and the v0.24.0 model has no
// model-level mutation for them. Tracked under UNIVER_SLIDES_GAPS.md.
//
// Replace path: Univer Slides v0.24.0 ships element ops as
// CommandType.OPERATION with no externally-addressable text-run mutation.
// We follow the same pattern as SlideContextMenu.reorderPage —
// snapshot-direct write + model.incrementRev() — and tag with
// TODO(collab) so a future fork-patch (Gap 1.4 in UNIVER_SLIDES_GAPS.md)
// can promote replace through the command bus.

/* ============================== platform ==============================
 *
 * The Ctrl+F / Cmd+F binding is detected by accepting EITHER `ctrlKey`
 * OR `metaKey` (same as App.tsx's primary-modifier convention). No
 * separate Mac-vs-Windows branch is required at the handler level —
 * Univer's own command bus treats them as equivalent. A future tooltip
 * that wants to render the platform glyph can copy the `detectIsMac`
 * helper from ShortcutsDialog.tsx (kept duplicated there rather than
 * shared, since the only consumer is the shortcut chip rendering).
 */

/* =========================== model accessor =========================== */

function getModel(): SlideDataModel | null {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return null;
  try {
    return (
      univer
        .__getInjector()
        .get(IUniverInstanceService)
        .getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE) ?? null
    );
  } catch {
    return null;
  }
}

function getUnitId(): string | null {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return null;
  try {
    return (
      univer
        .__getInjector()
        .get(IUniverInstanceService)
        .getCurrentUnitOfType(UniverInstanceType.UNIVER_SLIDE)
        ?.getUnitId() ?? null
    );
  } catch {
    return null;
  }
}

/* ============================== matching ============================== */

interface FindRecord {
  pageId: string;
  /** 1-based slide index amongst visible (SLIDE) pages — for UI display. */
  slideNumber: number;
  elementId: string;
  /**
   * Field where the text lives. TEXT elements expose `richText.text`;
   * SHAPE elements with copy expose `shape.text`. Other field paths are
   * possible (table cells) but unreachable in v0.24.0 — see top-of-file.
   */
  field: 'richText' | 'shape';
  /** Original full text of the field at scan time. */
  text: string;
  /** Match offset within `text`. */
  start: number;
  /** Match length within `text`. */
  length: number;
}

interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/**
 * Escape user-supplied text so it can be embedded verbatim inside a
 * regex literal. Same set as MDN's "Regular expressions guide" example
 * (forward slash kept escaped so the literal form `/…/` is safe even
 * if we ever switch construction).
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

function buildPattern(
  query: string,
  opts: SearchOptions,
): RegExp | null {
  if (!query) return null;
  let source: string;
  if (opts.regex) {
    source = query;
  } else {
    source = escapeRegExp(query);
    if (opts.wholeWord) {
      // \b matches at ASCII word boundaries. Good enough for the deck
      // text we ship; deferring full Unicode word-boundary semantics.
      source = `\\b${source}\\b`;
    }
  }
  const flags = `g${opts.matchCase ? '' : 'i'}`;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function pageTextEntries(page: ISlidePage): Array<{
  elementId: string;
  field: 'richText' | 'shape';
  text: string;
  element: IPageElement;
}> {
  const out: Array<{
    elementId: string;
    field: 'richText' | 'shape';
    text: string;
    element: IPageElement;
  }> = [];
  const elements = page.pageElements ?? {};
  for (const id of Object.keys(elements)) {
    const el = elements[id];
    if (!el) continue;
    if (el.type === PageElementType.TEXT && el.richText?.text) {
      out.push({ elementId: id, field: 'richText', text: el.richText.text, element: el });
    } else if (el.shape?.text) {
      // Shape elements with text — same scope as the Properties dialog
      // text-length stat.
      out.push({ elementId: id, field: 'shape', text: el.shape.text, element: el });
    }
  }
  return out;
}

function scanDeck(
  model: SlideDataModel,
  query: string,
  opts: SearchOptions,
): FindRecord[] {
  const pattern = buildPattern(query, opts);
  if (!pattern) return [];
  const snapshot = model.getSnapshot();
  const pages = snapshot.body?.pages ?? {};
  const order = snapshot.body?.pageOrder ?? [];
  const visibleIds = order.filter((id) => {
    const pt = pages[id]?.pageType;
    return pt === PageType.SLIDE || pt === undefined;
  });
  const out: FindRecord[] = [];
  visibleIds.forEach((pageId, pageIdx) => {
    const page = pages[pageId];
    if (!page) return;
    const entries = pageTextEntries(page);
    for (const entry of entries) {
      // Cheap reset: a `g`-flagged regex carries lastIndex across
      // matchAll calls, and we just built `pattern` so it's pristine.
      const re = new RegExp(pattern.source, pattern.flags);
      for (const m of entry.text.matchAll(re)) {
        if (typeof m.index !== 'number') continue;
        // Skip zero-width matches (e.g. `a*` against "abc") — they'd
        // loop forever and aren't replaceable.
        if (m[0].length === 0) continue;
        out.push({
          pageId,
          slideNumber: pageIdx + 1,
          elementId: entry.elementId,
          field: entry.field,
          text: entry.text,
          start: m.index,
          length: m[0].length,
        });
      }
    }
  });
  return out;
}

/* =========================== mutation helpers ========================== */

/**
 * Direct snapshot write — replaces the substring at [start, start+length)
 * on the given element's text field. Mirrors SlideContextMenu's
 * `reorderPage`: bumps the rev and re-pings setActivePage so the
 * SlideSideBar React subscriber re-renders.
 *
 * TODO(collab): not collab-safe. Replace with the text-run mutation
 * once the fork-patch lands (Gap 1.4 in UNIVER_SLIDES_GAPS.md).
 */
function applyReplaceDirect(
  rec: FindRecord,
  replacement: string,
): boolean {
  const model = getModel();
  if (!model) return false;
  const page = model.getPage(rec.pageId);
  if (!page) return false;
  const el = page.pageElements?.[rec.elementId];
  if (!el) return false;
  if (rec.field === 'richText') {
    if (!el.richText) return false;
    const current = el.richText.text ?? '';
    // Defensive: if the text has drifted since we scanned, fall back to
    // a global find-of-original-substring inside this field to avoid
    // splicing into an unintended position. If even that fails, skip.
    let spliceStart = rec.start;
    let spliceEnd = rec.start + rec.length;
    let next: string;
    if (
      current.length < rec.start + rec.length ||
      current.slice(rec.start, rec.start + rec.length) !==
        rec.text.slice(rec.start, rec.start + rec.length)
    ) {
      const original = rec.text.slice(rec.start, rec.start + rec.length);
      const idx = current.indexOf(original);
      if (idx < 0) return false;
      spliceStart = idx;
      spliceEnd = idx + original.length;
      next = current.slice(0, idx) + replacement + current.slice(idx + original.length);
    } else {
      next = current.slice(0, rec.start) + replacement + current.slice(rec.start + rec.length);
    }
    el.richText.text = next;
    // Mirror into the rich body so the canvas + downstream readers (which
    // prefer `richText.rich` over the flat `text`, per the
    // project-pptx-rich-field-trap memory) see the new text too. Splice
    // the dataStream, then adjust every textRun's [st, ed] that the splice
    // crosses so character formatting stays mapped to the right glyphs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rich = (el.richText as any).rich;
    if (rich?.body) {
      const ds = (rich.body.dataStream as string | undefined) ?? '';
      // dataStream uses \r as paragraph break, ends with \n. The find
      // index is computed against `text` which uses the same separators.
      // Splice using the same offsets.
      if (ds.length >= spliceEnd) {
        const before = ds.slice(0, spliceStart);
        const after = ds.slice(spliceEnd);
        rich.body.dataStream = before + replacement + after;
        const delta = replacement.length - (spliceEnd - spliceStart);
        if (delta !== 0 && Array.isArray(rich.body.textRuns)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const run of rich.body.textRuns as any[]) {
            // Run wholly before the splice → untouched.
            if (run.ed <= spliceStart) continue;
            // Run wholly after the splice → shift both ends by delta.
            if (run.st >= spliceEnd) {
              run.st += delta;
              run.ed += delta;
              continue;
            }
            // Run overlaps the splice: extend ed by delta. Leave st alone
            // if it sits before the splice; otherwise it must equal
            // spliceStart (since runs don't overlap each other).
            if (run.st < spliceStart) {
              run.ed += delta;
            } else {
              run.st = spliceStart;
              run.ed = spliceStart + (run.ed - spliceEnd) + replacement.length;
            }
          }
        }
        // Paragraph offsets bookkeeping — if the splice deleted or added
        // \r breaks, recompute startIndex entries. Re-derive from the new
        // dataStream by scanning for \r positions. The trailing \n is the
        // doc-end marker, NOT a paragraph break — don't index it.
        if (Array.isArray(rich.body.paragraphs)) {
          const breaks: number[] = [];
          for (let i = 0; i < rich.body.dataStream.length; i++) {
            if (rich.body.dataStream[i] === '\r') breaks.push(i);
          }
          rich.body.paragraphs = breaks.length > 0
            ? breaks.map((b) => ({ startIndex: b }))
            : [{ startIndex: 0 }];
        }
      }
    }
    return true;
  }
  // shape field
  if (!el.shape) return false;
  const current = el.shape.text ?? '';
  if (
    current.length < rec.start + rec.length ||
    current.slice(rec.start, rec.start + rec.length) !==
      rec.text.slice(rec.start, rec.start + rec.length)
  ) {
    const original = rec.text.slice(rec.start, rec.start + rec.length);
    const idx = current.indexOf(original);
    if (idx < 0) return false;
    el.shape.text = current.slice(0, idx) + replacement + current.slice(idx + original.length);
  } else {
    el.shape.text =
      current.slice(0, rec.start) + replacement + current.slice(rec.start + rec.length);
  }
  return true;
}

/** Re-emit activePage so subscribers (including the SlideSideBar) re-read
 *  the patched element. Same trick used by SlideContextMenu. */
function pokeModel(): void {
  const model = getModel();
  if (!model) return;
  model.incrementRev();
  const active = model.getActivePage();
  if (active) model.setActivePage(active);
}

/* ============================== overlay =============================== */

interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Compute a viewport rect for the slide-frame containing the current
 * match. We don't have a public Univer API for "rect of element on
 * stage"; instead we anchor the overlay to the `.univer-mount` element
 * (the canvas host) — a deck-wide highlight that flashes whenever a new
 * match becomes current. It's a coarse hint, but it satisfies the
 * "highlight the matched text frame" requirement without reaching into
 * the canvas renderer.
 *
 * Refining this to a tight bbox needs the per-element transform from
 * CanvasView → Scene; documented as a follow-up in the deliverable
 * report.
 */
function getStageRect(): OverlayRect | null {
  const node = document.querySelector('.univer-mount') as HTMLElement | null;
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/* ============================ dialog state ============================ */

interface FindReplaceDialogProps {
  open: boolean;
  onClose: () => void;
}

export function FindReplaceDialog({ open, onClose }: FindReplaceDialogProps) {
  const { t } = useTranslation('dialogs');
  const cardRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [replaceVisible, setReplaceVisible] = useState(false);
  // Forces a re-scan after a replace mutation. Bumped manually because
  // we can't subscribe to SlideDataModel.snapshot$ cleanly in v0.24.0.
  const [scanTick, setScanTick] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  // Pulse counter — toggling fires the overlay's CSS animation.
  const [pulse, setPulse] = useState(0);

  const options: SearchOptions = useMemo(
    () => ({ matchCase, wholeWord, regex }),
    [matchCase, wholeWord, regex],
  );

  // Live results. Re-scan on every keystroke / toggle / replace.
  const { results, regexError } = useMemo(() => {
    if (!open) return { results: [] as FindRecord[], regexError: false };
    const model = getModel();
    if (!model) return { results: [] as FindRecord[], regexError: false };
    if (!query) return { results: [] as FindRecord[], regexError: false };
    if (regex) {
      // Quickly validate the pattern so we can flag invalid regex to
      // the user instead of silently returning zero matches.
      try {
        // eslint-disable-next-line no-new
        new RegExp(query);
      } catch {
        return { results: [] as FindRecord[], regexError: true };
      }
    }
    return { results: scanDeck(model, query, options), regexError: false };
    // scanTick is intentionally a dependency: replace operations mutate
    // the snapshot in-place and don't trigger a React render on their
    // own. Bumping scanTick forces a re-scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, options, scanTick]);

  // Clamp activeIdx within the new results window.
  useEffect(() => {
    if (activeIdx >= results.length) {
      setActiveIdx(results.length === 0 ? 0 : results.length - 1);
    }
  }, [results.length, activeIdx]);

  // Activate the slide that contains the current match + pulse the
  // stage overlay so the user can see *which* frame matched.
  useEffect(() => {
    if (!open) return;
    const current = results[activeIdx];
    if (!current) return;
    const unitId = getUnitId();
    if (!unitId) return;
    void dispatchSlideCommand('slide.operation.activate-slide', {
      unitId,
      id: current.pageId,
    });
    setPulse((p) => p + 1);
  }, [open, results, activeIdx]);

  // Reset transient state on open/close.
  useEffect(() => {
    if (!open) {
      setStatus(null);
      return;
    }
    // Defer focus to after paint so the slide-in animation has a frame
    // to settle.
    const id = window.requestAnimationFrame(() => findInputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Esc closes; mousedown OUTSIDE the dialog should NOT auto-close
  // (matches Google Slides — the popover stays so the user can interact
  // with the canvas without losing their query).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const advance = useCallback(
    (delta: 1 | -1) => {
      if (results.length === 0) return;
      setActiveIdx((i) => {
        const next = (i + delta + results.length) % results.length;
        return next;
      });
    },
    [results.length],
  );

  const handleReplaceOne = useCallback(() => {
    const target = results[activeIdx];
    if (!target) return;
    const ok = applyReplaceDirect(target, replacement);
    if (!ok) return;
    pokeModel();
    setScanTick((t) => t + 1);
    // After a replace, the result list shifts (the match at activeIdx
    // disappears; subsequent matches in the same field re-anchor).
    // Keep activeIdx pointing at the same ordinal so "Next" feels
    // natural — clamping in the effect above handles end-of-list.
    setStatus(t('findReplace.replacedCount', { count: 1 }));
  }, [results, activeIdx, replacement, t]);

  const handleReplaceAll = useCallback(() => {
    if (results.length === 0) return;
    const model = getModel();
    if (!model) return;
    // Replace from the END of each field forward so earlier offsets
    // stay valid. Group by (pageId, elementId, field) and reverse the
    // ordering of indices within each group.
    type Key = string;
    const groups = new Map<Key, FindRecord[]>();
    for (const r of results) {
      const key = `${r.pageId}::${r.elementId}::${r.field}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    let replaced = 0;
    // Cap at 1000 to avoid pathological decks (e.g. replace " " in a
    // dense deck). Same cap as the task spec.
    const HARD_CAP = 1000;
    let consumed = 0;
    for (const list of groups.values()) {
      // Sort ascending by start, then iterate in reverse so each
      // splice doesn't shift the next pending start index.
      list.sort((a, b) => a.start - b.start);
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (consumed >= HARD_CAP) break;
        // i is in [0, list.length-1] — inhabited.
        const rec = list[i]!;
        if (applyReplaceDirect(rec, replacement)) replaced += 1;
        consumed += 1;
      }
      if (consumed >= HARD_CAP) break;
    }
    pokeModel();
    setScanTick((tt) => tt + 1);
    setStatus(t('findReplace.replacedCount', { count: replaced }));
  }, [results, replacement, t]);

  const handleFindKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        advance(e.shiftKey ? -1 : 1);
      }
    },
    [advance],
  );

  // Overlay flash position. Computed each render — cheap.
  const stage = open ? getStageRect() : null;

  if (!open) return null;

  const total = results.length;
  const current = total > 0 ? activeIdx + 1 : 0;
  const countText =
    total === 0
      ? t('findReplace.countNone')
      : t('findReplace.countOf', { current, total });

  return (
    <>
      <div
        className="cs-findreplace"
        ref={cardRef}
        role="dialog"
        aria-label={t('findReplace.ariaLabel')}
        aria-modal="false"
        data-testid="findreplace-dialog"
      >
        <header className="cs-findreplace__header">
          <Icon name="find_in_page" size={16} />
          <h2 className="cs-findreplace__title">{t('findReplace.title')}</h2>
          <button
            type="button"
            className="cs-findreplace__close"
            onClick={onClose}
            title={t('findReplace.closeTooltip')}
            aria-label={t('findReplace.close')}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="cs-findreplace__row">
          <button
            type="button"
            className="cs-findreplace__expand"
            onClick={() => setReplaceVisible((v) => !v)}
            aria-expanded={replaceVisible}
            aria-controls="cs-findreplace-replace-row"
            title={
              replaceVisible
                ? t('findReplace.hideReplace')
                : t('findReplace.toggleReplace')
            }
          >
            <Icon name="arrow_drop_down" size={14} className={replaceVisible ? 'is-open' : ''} />
          </button>
          <div className="cs-findreplace__input-wrap">
            <input
              ref={findInputRef}
              type="text"
              className={`cs-findreplace__input ${regexError ? 'is-error' : ''}`}
              placeholder={t('findReplace.findPlaceholder')}
              aria-label={t('findReplace.findAriaLabel')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setStatus(null);
                // Reset to first hit on every query change so "Enter"
                // walks the list from the top.
                setActiveIdx(0);
              }}
              onKeyDown={handleFindKeyDown}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="cs-findreplace__count" aria-live="polite">
              {countText}
            </span>
          </div>
          <div className="cs-findreplace__toggles">
            <ToggleButton
              active={matchCase}
              onClick={() => setMatchCase((v) => !v)}
              icon="match_case"
              title={t('findReplace.matchCase')}
            />
            <ToggleButton
              active={wholeWord}
              onClick={() => setWholeWord((v) => !v)}
              icon="text_format"
              title={t('findReplace.matchWholeWord')}
            />
            <ToggleButton
              active={regex}
              onClick={() => setRegex((v) => !v)}
              icon="regex"
              title={t('findReplace.useRegex')}
            />
          </div>
          <div className="cs-findreplace__nav">
            <button
              type="button"
              className="cs-findreplace__navbtn"
              onClick={() => advance(-1)}
              disabled={total === 0}
              title={t('findReplace.previous')}
              aria-label={t('findReplace.previous')}
            >
              <Icon name="chevron_left" size={16} />
            </button>
            <button
              type="button"
              className="cs-findreplace__navbtn"
              onClick={() => advance(1)}
              disabled={total === 0}
              title={t('findReplace.next')}
              aria-label={t('findReplace.next')}
            >
              <Icon name="chevron_right" size={16} />
            </button>
          </div>
        </div>

        {replaceVisible && (
          <div className="cs-findreplace__row cs-findreplace__row--replace" id="cs-findreplace-replace-row">
            <div className="cs-findreplace__input-wrap">
              <input
                type="text"
                className="cs-findreplace__input"
                placeholder={t('findReplace.replacePlaceholder')}
                aria-label={t('findReplace.replaceAriaLabel')}
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="cs-findreplace__actions">
              <button
                type="button"
                className="cs-btn cs-btn--ghost cs-findreplace__action"
                onClick={handleReplaceOne}
                disabled={total === 0}
              >
                {t('findReplace.replaceOne')}
              </button>
              <button
                type="button"
                className="cs-btn cs-btn--primary cs-findreplace__action"
                onClick={handleReplaceAll}
                disabled={total === 0}
              >
                {t('findReplace.replaceAll')}
              </button>
            </div>
          </div>
        )}

        {regexError && (
          <p className="cs-findreplace__error" role="alert">
            {t('findReplace.regexInvalid')}
          </p>
        )}
        {status && !regexError && (
          <p className="cs-findreplace__status" aria-live="polite">{status}</p>
        )}
      </div>

      {stage && total > 0 && (
        <StageHighlight key={pulse} rect={stage} />
      )}
    </>
  );
}

/* =========================== sub-components =========================== */

interface ToggleButtonProps {
  active: boolean;
  onClick: () => void;
  icon: string;
  title: string;
}

function ToggleButton({ active, onClick, icon, title }: ToggleButtonProps) {
  return (
    <button
      type="button"
      className={`cs-findreplace__toggle ${active ? 'is-active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
      title={title}
      aria-label={title}
    >
      <Icon name={icon} size={14} filled={active} />
    </button>
  );
}

/**
 * Transient stage outline — a 600 ms animated box-shadow that flashes
 * around the current match's frame. Animation is owned by the dialog
 * itself (not App.tsx) per task constraint; the rect lives outside the
 * dialog card so the highlight rides on top of the workspace canvas
 * but underneath the popover. `pointer-events: none` keeps it from
 * intercepting clicks.
 *
 * Refining this to the exact element bbox needs CanvasView access —
 * deferred (see scanDeck comment above).
 */
function StageHighlight({ rect }: { rect: OverlayRect }) {
  // useLayoutEffect because the keyframes start on first paint and we
  // don't want a flash of zero-opacity at the wrong rect.
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.classList.remove('cs-findreplace-flash--play');
    // Force reflow so re-adding the class restarts the animation.
    void node.offsetWidth;
    node.classList.add('cs-findreplace-flash--play');
  }, [rect.left, rect.top, rect.width, rect.height]);
  return (
    <div
      ref={ref}
      className="cs-findreplace-flash"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
      aria-hidden="true"
    />
  );
}

/* =============================== provider ============================== */

/**
 * Self-mounted provider. Owns the open state + Ctrl+F (Cmd+F) listener.
 * Mounted alongside <App /> in main.tsx so we don't touch App.tsx's
 * prop tree.
 *
 * The Ctrl+F shortcut intentionally falls back to the browser default
 * when focus is inside any editable surface — Univer's text-frame
 * editor on the canvas exposes itself via contenteditable, so this
 * guard mirrors the one in App.tsx for the rest of the Ctrl+X family.
 */
export function FindReplaceProvider() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const show = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k !== 'f') return;
        const target = e.target as HTMLElement | null;
        // If the keystroke originated INSIDE our own dialog — the user
        // already has the find input focused — refocus + select the
        // input so they can retype quickly. This avoids the trap where
        // our editable-guard would otherwise bail to native browser
        // find while the user expected our dialog to handle it.
        const inOwnDialog = !!target?.closest('.cs-findreplace');
        if (inOwnDialog) {
          e.preventDefault();
          const findInput = document.querySelector<HTMLInputElement>(
            '.cs-findreplace [aria-label][type="text"]',
          );
          findInput?.focus();
          findInput?.select();
          return;
        }
        const inEditable =
          !!target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable);
        // Inside a text frame (Univer's editor) or any other editable
        // surface: let Univer / the browser handle Ctrl+F. Outside:
        // pop our dialog.
        if (inEditable) return;
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    // Expose a window hook in case a menu item ever needs to open the
    // dialog imperatively. Mirrors __casualSlides_openShortcuts.
    window.__casualSlides_openFindReplace = show;
    return () => {
      window.removeEventListener('keydown', handler);
      if (window.__casualSlides_openFindReplace === show) {
        delete window.__casualSlides_openFindReplace;
      }
    };
  }, [show]);

  return <FindReplaceDialog open={open} onClose={close} />;
}

declare global {
  interface Window {
    __casualSlides_openFindReplace?: () => void;
  }
}

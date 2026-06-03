import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './icons';

// Keyboard-shortcut overview dialog.
//
// Industry-standard UX (Google Slides, Notion, Linear, Figma): Ctrl+/ (or
// Cmd+/ on Mac) opens a modal that lists every wired shortcut grouped by
// category, with a search box, focus trap, Esc-to-close, and backdrop
// dismissal.
//
// The dialog is self-contained — `<ShortcutsProvider />` owns its own
// `open` state and the global keydown listener — so it can be mounted
// alongside `<App />` in main.tsx without touching App.tsx's prop tree.
//
// All strings live in `i18n/locales/en.json` under `dialogs.shortcuts`.
// Platform-appropriate modifier glyphs (Ctrl vs ⌘) are computed once via
// `navigator.platform` (deprecated but still reliable across every modern
// browser; userAgentData.platform is preferred when available).

/**
 * Detect Mac via the modern userAgentData API when available, falling back
 * to the long-deprecated-but-still-supported `navigator.platform` string.
 * Both checks tolerate non-browser environments (SSR, tests).
 */
function detectIsMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  type NavWithUAData = Navigator & {
    userAgentData?: { platform?: string };
  };
  const ua = (navigator as NavWithUAData).userAgentData?.platform;
  if (typeof ua === 'string' && ua) {
    return ua.toLowerCase().includes('mac');
  }
  // `navigator.platform` is deprecated but every browser still ships it,
  // and the alternatives require userAgent string parsing which is
  // strictly worse.
  const platform = navigator.platform || '';
  return platform.toLowerCase().includes('mac');
}

/**
 * A single key chip token. `keys` is an ordered list of physical keys that
 * form one keybind (e.g. ['Ctrl', '/']). A row may have several bindings
 * (e.g. Redo = Ctrl+Y OR Ctrl+Shift+Z).
 */
interface ShortcutKeyBind {
  keys: string[];
}

interface ShortcutEntry {
  /** i18n key under `dialogs.shortcuts.actions` */
  labelKey: string;
  binds: ShortcutKeyBind[];
}

interface ShortcutSection {
  /** i18n key under `dialogs.shortcuts.categories` */
  categoryKey: 'file' | 'edit' | 'slides' | 'elements' | 'view' | 'slideshow' | 'help';
  /** Optional i18n key for a section-level hint (e.g. "Active while presenting") */
  hintKey?: string;
  rows: ShortcutEntry[];
}

/**
 * Build the section catalogue with platform-aware modifier symbols. On Mac
 * we render `⌘` for Ctrl-shortcuts (Univer Slides treats Ctrl/Cmd as the
 * same primary modifier — see App.tsx where `e.ctrlKey || e.metaKey` gates
 * every binding).
 *
 * Each section reflects an actually-wired shortcut in App.tsx or
 * SlideShow.tsx, not aspiration.
 */
function buildSections(isMac: boolean): ShortcutSection[] {
  const mod = isMac ? '⌘' : 'Ctrl';
  const shift = isMac ? '⇧' : 'Shift';
  const alt = isMac ? '⌥' : 'Alt';
  const del = isMac ? 'Delete' : 'Del';

  return [
    {
      categoryKey: 'file',
      rows: [
        { labelKey: 'openPptx', binds: [{ keys: [mod, 'O'] }] },
        { labelKey: 'savePptx', binds: [{ keys: [mod, 'S'] }] },
        { labelKey: 'print',    binds: [{ keys: [mod, 'P'] }] },
      ],
    },
    {
      categoryKey: 'edit',
      rows: [
        { labelKey: 'undo', binds: [{ keys: [mod, 'Z'] }] },
        {
          labelKey: 'redo',
          binds: [
            { keys: [mod, 'Y'] },
            { keys: [mod, shift, 'Z'] },
          ],
        },
      ],
    },
    {
      categoryKey: 'slides',
      rows: [
        { labelKey: 'newSlide',       binds: [{ keys: [mod, 'M'] }] },
        { labelKey: 'duplicateSlide', binds: [{ keys: [mod, 'D'] }] },
        { labelKey: 'deleteSlide',    binds: [{ keys: [shift, del] }] },
        { labelKey: 'moveSlideUp',    binds: [{ keys: [mod, shift, '↑'] }] },
        { labelKey: 'moveSlideDown',  binds: [{ keys: [mod, shift, '↓'] }] },
      ],
    },
    {
      categoryKey: 'elements',
      hintKey: 'elementsHint',
      rows: [
        { labelKey: 'insertLink',     binds: [{ keys: [mod, 'K'] }] },
        { labelKey: 'nudge',          binds: [{ keys: ['←'] }, { keys: ['→'] }, { keys: ['↑'] }, { keys: ['↓'] }] },
        { labelKey: 'nudgeBig',       binds: [{ keys: [shift, '←'] }, { keys: [shift, '→'] }, { keys: [shift, '↑'] }, { keys: [shift, '↓'] }] },
        { labelKey: 'cycleNext',      binds: [{ keys: ['Tab'] }] },
        { labelKey: 'cyclePrev',      binds: [{ keys: [shift, 'Tab'] }] },
        { labelKey: 'selectAllOnPage', binds: [{ keys: [mod, 'A'] }] },
        { labelKey: 'copyElement',    binds: [{ keys: [mod, 'C'] }] },
        { labelKey: 'cutElement',     binds: [{ keys: [mod, 'X'] }] },
        { labelKey: 'pasteElement',   binds: [{ keys: [mod, 'V'] }] },
        { labelKey: 'duplicateElement', binds: [{ keys: [mod, 'D'] }] },
        { labelKey: 'deleteElement',  binds: [{ keys: [del] }] },
        { labelKey: 'bringForward',   binds: [{ keys: [mod, shift, ']'] }] },
        { labelKey: 'sendBackward',   binds: [{ keys: [mod, shift, '['] }] },
        { labelKey: 'bringToFront',   binds: [{ keys: [mod, alt, ']'] }] },
        { labelKey: 'sendToBack',     binds: [{ keys: [mod, alt, '['] }] },
      ],
    },
    {
      categoryKey: 'view',
      rows: [
        {
          labelKey: 'zoomIn',
          binds: [
            { keys: [mod, '+'] },
            { keys: [mod, '='] },
          ],
        },
        { labelKey: 'zoomOut',   binds: [{ keys: [mod, '−'] }] },
        { labelKey: 'resetZoom',    binds: [{ keys: [mod, '0'] }] },
        { labelKey: 'fitToWindow',  binds: [{ keys: [mod, shift, '0'] }] },
        { labelKey: 'startSlideshow', binds: [{ keys: ['F5'] }] },
      ],
    },
    {
      categoryKey: 'slideshow',
      hintKey: 'slideshowHint',
      rows: [
        {
          labelKey: 'slideshowNext',
          binds: [
            { keys: ['→'] },
            { keys: ['Space'] },
            { keys: ['PageDown'] },
          ],
        },
        {
          labelKey: 'slideshowPrev',
          binds: [
            { keys: ['←'] },
            { keys: ['Backspace'] },
            { keys: ['PageUp'] },
          ],
        },
        { labelKey: 'slideshowFirst', binds: [{ keys: ['Home'] }] },
        { labelKey: 'slideshowLast',  binds: [{ keys: ['End'] }] },
        { labelKey: 'slideshowToggleNumber',     binds: [{ keys: ['N'] }] },
        { labelKey: 'slideshowToggleFullscreen', binds: [{ keys: ['F'] }] },
        { labelKey: 'slideshowExit', binds: [{ keys: ['Esc'] }] },
      ],
    },
    {
      categoryKey: 'help',
      rows: [
        { labelKey: 'showShortcuts', binds: [{ keys: [mod, '/'] }] },
      ],
    },
  ];
}

/* --------------------------- Dialog component --------------------------- */

export interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const { t } = useTranslation('dialogs');
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');

  const isMac = useMemo(detectIsMac, []);
  const sections = useMemo(() => buildSections(isMac), [isMac]);
  const openShortcutKey = `${isMac ? '⌘' : 'Ctrl'}+/`;

  // Filter rows by case-insensitive substring match on the localised
  // action label. Sections with zero matches are dropped from the
  // rendered list (but the catalogue order is preserved).
  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((section) => ({
        ...section,
        rows: section.rows.filter((row) =>
          t(`shortcuts.actions.${row.labelKey}`).toString().toLowerCase().includes(q),
        ),
      }))
      .filter((section) => section.rows.length > 0);
  }, [sections, query, t]);

  // Focus trap: when the dialog opens, focus the search input. Tab/Shift+
  // Tab cycle through focusable descendants and never escape the dialog.
  useEffect(() => {
    if (!open) return;
    // Defer focus to after paint so screen readers announce the dialog
    // before announcing the focused element.
    const id = window.requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Reset search every time the dialog opens so a stale query doesn't
  // greet the user on second-open.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!dialogRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap. Collect every focusable element inside the dialog
      // and wrap focus at the edges.
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      // length > 0 was just asserted — both ends are inhabited.
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="cs-shortcuts__backdrop"
      role="presentation"
    >
      <div
        className="cs-shortcuts"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.ariaLabel')}
        data-testid="shortcuts-dialog"
      >
        <header className="cs-shortcuts__header">
          <Icon name="keyboard" size={16} />
          <h2 className="cs-shortcuts__title">{t('shortcuts.title')}</h2>
          <button
            ref={closeRef}
            type="button"
            className="cs-shortcuts__close"
            onClick={onClose}
            title={t('shortcuts.closeTooltip')}
            aria-label={t('shortcuts.close')}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="cs-shortcuts__search">
          <Icon name="search" size={16} className="cs-shortcuts__search-icon" />
          <input
            ref={searchRef}
            type="search"
            className="cs-shortcuts__search-input"
            placeholder={t('shortcuts.searchPlaceholder')}
            aria-label={t('shortcuts.searchAriaLabel')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="cs-shortcuts__body">
          {filteredSections.length === 0 ? (
            <p className="cs-shortcuts__empty">{t('shortcuts.noResults')}</p>
          ) : (
            filteredSections.map((section) => (
              <ShortcutSectionView
                key={section.categoryKey}
                section={section}
              />
            ))
          )}
        </div>

        <footer className="cs-shortcuts__footer">
          <span className="cs-shortcuts__hint">
            {t('shortcuts.openHint', { key: openShortcutKey })}
          </span>
          <button type="button" className="cs-btn cs-btn--ghost" onClick={onClose}>
            {t('shortcuts.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ShortcutSectionView({ section }: { section: ShortcutSection }) {
  const { t } = useTranslation('dialogs');
  return (
    <section className="cs-shortcuts__section" aria-labelledby={`shortcuts-heading-${section.categoryKey}`}>
      <h3 id={`shortcuts-heading-${section.categoryKey}`} className="cs-shortcuts__section-title">
        {t(`shortcuts.categories.${section.categoryKey}`)}
        {section.hintKey && (
          <span className="cs-shortcuts__section-hint">
            {t(`shortcuts.${section.hintKey}`)}
          </span>
        )}
      </h3>
      <dl className="cs-shortcuts__list">
        {section.rows.map((row) => (
          <ShortcutRow key={row.labelKey} row={row} />
        ))}
      </dl>
    </section>
  );
}

function ShortcutRow({ row }: { row: ShortcutEntry }) {
  const { t } = useTranslation('dialogs');
  return (
    <div className="cs-shortcuts__row">
      <dt className="cs-shortcuts__label">{t(`shortcuts.actions.${row.labelKey}`)}</dt>
      <dd className="cs-shortcuts__keys">
        {row.binds.map((bind, bindIdx) => (
          <span key={bindIdx} className="cs-shortcuts__bind">
            {bindIdx > 0 && <span className="cs-shortcuts__or" aria-hidden="true">/</span>}
            <span className="cs-shortcuts__chips">
              {bind.keys.map((key, keyIdx) => (
                <span key={keyIdx} className="cs-shortcuts__chip-group">
                  {keyIdx > 0 && <span className="cs-shortcuts__plus" aria-hidden="true">+</span>}
                  <kbd className="cs-shortcuts__kbd">{key}</kbd>
                </span>
              ))}
            </span>
          </span>
        ))}
      </dd>
    </div>
  );
}

/* ------------------------------- Provider -------------------------------- */

/**
 * Self-contained mount point. Owns its own `open` state and a global
 * `keydown` listener that toggles the dialog on Ctrl+/ (or Cmd+/ on Mac).
 *
 * Mounted alongside `<App />` in `main.tsx`, so this is a single-line
 * addition that doesn't require any change to App.tsx. The same instance
 * also exposes a `window.__casualSlides_openShortcuts` callable so other
 * components (e.g. a help menu) can imperatively pop the dialog open
 * without prop drilling.
 */
export function ShortcutsProvider() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const show = useCallback(() => setOpen(true), []);

  // Global hotkey + window-global hook.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+/ on Win/Linux, Cmd+/ on Mac. We accept either modifier on
      // either platform because some keyboards remap them (and Univer's
      // own command shortcuts already treat them as equivalent).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === '/') {
        // Skip when focus is inside a text-editing surface — the user is
        // typing, and `/` shouldn't be hijacked there.
        const target = e.target as HTMLElement | null;
        const inEditable = !!target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        );
        if (inEditable) return;
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', handler);
    window.__casualSlides_openShortcuts = show;
    return () => {
      window.removeEventListener('keydown', handler);
      if (window.__casualSlides_openShortcuts === show) {
        delete window.__casualSlides_openShortcuts;
      }
    };
  }, [toggle, show]);

  return <ShortcutsDialog open={open} onClose={close} />;
}

declare global {
  interface Window {
    __casualSlides_openShortcuts?: () => void;
  }
}

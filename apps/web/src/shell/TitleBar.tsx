import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './icons';
import { dispatchSlideCommand } from '../univer/commands';

// Google Docs-style title bar — single chrome block with brand on the
// left, editable filename + menu strip stacked in the middle, action
// chips on the right.
//
// Layout (sheet-style merged title bar):
//   ┌──────────┬────────────────────────────┬──────────────────┐
//   │          │  Document Name             │                  │
//   │  Logo    │                            │  Share · Avatar  │
//   │          │  File  Edit  View  Insert  │                  │
//   └──────────┴────────────────────────────┴──────────────────┘
// Logo spans both rows on the left; actions span both rows on the right;
// the centre column stacks filename above the dropdown menus. Reads as
// one block, not "two competing nav strips".

export interface TitleBarProps {
  fileName: string;
  onFileNameChange: (next: string) => void;
  onOpen: () => void;
  onSave: () => void;
  onOpenProperties: () => void;
  onOpenRecent: () => void;
  onOpenAbout: () => void;
  onOpenPageSetup: () => void;
  onDownloadPng: () => void;
  onDownloadPdf: () => void;
  onMakeCopy: () => void;
  onToggleNotes?: () => void;
  onFitToWindow?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onToggleSlidePanel?: () => void;
  onInsertShape?: () => void;
  onDismissStatus?: () => void;
  onDismissError?: () => void;
  saving?: boolean;
  opening?: boolean;
  dirty?: boolean;
  status?: string | null;
  error?: string | null;
  collabStatus?: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';
  collabRoomId?: string | null;
  collabPeers?: number;
}

interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
}

interface MenuDef {
  id: string;
  label: string;
  items: (MenuItem | { id: string; label: '---' })[];
}

// Menu structure is built at render-time from the i18n catalogue so menu
// labels + shortcut hints follow the active locale. Shortcut strings stay
// keyed (English text today) so a future locale can override the hint —
// the keystroke itself is universal ASCII.
function buildMenus(t: (key: string) => string): MenuDef[] {
  return [
    { id: 'file', label: t('menu:file.label'), items: [
      { id: 'new', label: t('menu:file.new'), shortcut: t('menu:file.shortcut.new') },
      { id: 'open', label: t('menu:file.open'), shortcut: t('menu:file.shortcut.open') },
      { id: 'recent', label: t('menu:file.recent') },
      { id: 'save', label: t('menu:file.save'), shortcut: t('menu:file.shortcut.save') },
      { id: 'makeCopy', label: t('menu:file.makeCopy') },
      { id: 'sep1', label: '---' },
      { id: 'downloadPng', label: t('menu:file.downloadPng') },
      { id: 'downloadPdf', label: t('menu:file.downloadPdf') },
      { id: 'pageSetup', label: t('menu:file.pageSetup') },
      { id: 'properties', label: t('menu:file.properties') },
    ] },
    { id: 'edit', label: t('menu:edit.label'), items: [
      { id: 'undo', label: t('menu:edit.undo'), shortcut: t('menu:edit.shortcut.undo') },
      { id: 'redo', label: t('menu:edit.redo'), shortcut: t('menu:edit.shortcut.redo') },
      { id: 'sep1', label: '---' },
      { id: 'cut', label: t('menu:edit.cut'), shortcut: t('menu:edit.shortcut.cut') },
      { id: 'copy', label: t('menu:edit.copy'), shortcut: t('menu:edit.shortcut.copy') },
      { id: 'paste', label: t('menu:edit.paste'), shortcut: t('menu:edit.shortcut.paste') },
    ] },
    { id: 'view', label: t('menu:view.label'), items: [
      { id: 'fit', label: t('menu:view.fit') },
      { id: 'zoom-in', label: t('menu:view.zoomIn'), shortcut: t('menu:view.shortcut.zoomIn') },
      { id: 'zoom-out', label: t('menu:view.zoomOut'), shortcut: t('menu:view.shortcut.zoomOut') },
      { id: 'sep1', label: '---' },
      { id: 'thumbs', label: t('menu:view.thumbs') },
      { id: 'notes', label: t('menu:view.notes') },
    ] },
    { id: 'insert', label: t('menu:insert.label'), items: [
      { id: 'text', label: t('menu:insert.text') },
      { id: 'shape', label: t('menu:insert.shape') },
      { id: 'image', label: t('menu:insert.image') },
      { id: 'sep1', label: '---' },
      { id: 'slide', label: t('menu:insert.slide'), shortcut: t('menu:insert.shortcut.slide') },
    ] },
    { id: 'help', label: t('menu:help.label'), items: [
      { id: 'about', label: t('menu:help.about') },
      { id: 'repo', label: t('menu:help.repo') },
    ] },
  ];
}

const isSep = (i: MenuDef['items'][number]): i is { id: string; label: '---' } => i.label === '---';

// Best-effort clipboard fallback. Univer registers `univer.command.cut/copy/
// paste` in @univerjs/ui, but those rely on a focused editor surface. When
// the focus is on the slide canvas (not a text frame), Univer's commands
// no-op silently. Calling document.execCommand at least lets the browser
// route the action through its native focused-element handler. Both paths
// can fail in headless contexts — we swallow the rejection.
async function dispatchClipboard(cmd: 'cut' | 'copy' | 'paste'): Promise<void> {
  const ok = await dispatchSlideCommand(`univer.command.${cmd}`);
  if (ok) return;
  // TODO: drop the execCommand fallback once Univer routes canvas-level
  // clipboard through a slide command (Gap 1.x — clipboard on selection).
  try {
    document.execCommand(cmd);
  } catch {
    /* not available — silent no-op */
  }
}

export function TitleBar({
  fileName,
  onFileNameChange,
  onOpen,
  onSave,
  onOpenProperties,
  onOpenRecent,
  onOpenAbout,
  onOpenPageSetup,
  onDownloadPng,
  onDownloadPdf,
  onMakeCopy,
  onToggleNotes,
  onFitToWindow,
  onZoomIn,
  onZoomOut,
  onToggleSlidePanel,
  onInsertShape,
  onDismissStatus,
  onDismissError,
  saving,
  opening,
  dirty,
  status,
  error,
  collabStatus,
  collabRoomId,
  collabPeers = 0,
}: TitleBarProps) {
  // We use both namespaces so the menu strip pulls from `menu` while the
  // chrome (filename, pills, action buttons, collab badge) pulls from
  // `chrome`. `useTranslation` returns a `t` whose first-namespace lookup
  // is `chrome`; menu keys go through the explicit `menu:` prefix.
  const { t } = useTranslation(['chrome', 'menu']);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [filenameEditing, setFilenameEditing] = useState(false);
  const [draft, setDraft] = useState(fileName);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuStripRef = useRef<HTMLDivElement>(null);
  const MENUS = buildMenus(t);

  useEffect(() => setDraft(fileName), [fileName]);
  useEffect(() => {
    if (filenameEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [filenameEditing]);

  useEffect(() => {
    if (!openMenu) return;
    const handler = (e: MouseEvent) => {
      if (!menuStripRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openMenu]);

  const handleMenuItem = useCallback(
    (menuId: string, itemId: string) => {
      setOpenMenu(null);
      // File menu
      if (menuId === 'file') {
        if (itemId === 'new') {
          // Reload the page — same as Ctrl+N. Cheaper than rebuilding
          // a blank deck in-place; the default snapshot is restored on
          // mount. TODO: replace with a proper "new deck" command when
          // we keep multiple unsaved decks open.
          if (typeof window !== 'undefined') window.location.reload();
        }
        if (itemId === 'open') onOpen();
        if (itemId === 'save') onSave();
        if (itemId === 'properties') onOpenProperties();
        if (itemId === 'pageSetup') onOpenPageSetup();
        if (itemId === 'downloadPng') onDownloadPng();
        if (itemId === 'downloadPdf') onDownloadPdf();
        if (itemId === 'makeCopy') onMakeCopy();
        if (itemId === 'recent') onOpenRecent();
        return;
      }
      // Edit menu
      if (menuId === 'edit') {
        if (itemId === 'undo') void dispatchSlideCommand('univer.command.undo');
        if (itemId === 'redo') void dispatchSlideCommand('univer.command.redo');
        if (itemId === 'cut') void dispatchClipboard('cut');
        if (itemId === 'copy') void dispatchClipboard('copy');
        if (itemId === 'paste') void dispatchClipboard('paste');
        return;
      }
      // View menu
      if (menuId === 'view') {
        if (itemId === 'fit') onFitToWindow?.();
        if (itemId === 'zoom-in') onZoomIn?.();
        if (itemId === 'zoom-out') onZoomOut?.();
        if (itemId === 'thumbs') onToggleSlidePanel?.();
        if (itemId === 'notes') onToggleNotes?.();
        return;
      }
      // Insert menu
      if (menuId === 'insert') {
        if (itemId === 'text') void dispatchSlideCommand('slide.command.add-text');
        if (itemId === 'shape') onInsertShape?.();
        if (itemId === 'image') void dispatchSlideCommand('slide.command.insert-float-image');
        if (itemId === 'slide') void dispatchSlideCommand('slide.operation.append-slide');
        return;
      }
      // Help menu
      if (menuId === 'help') {
        if (itemId === 'about') onOpenAbout();
        if (itemId === 'repo') {
          window.open('https://github.com/schnsrw/slides', '_blank', 'noopener,noreferrer');
        }
      }
    },
    [
      onOpen,
      onSave,
      onOpenProperties,
      onOpenRecent,
      onOpenAbout,
      onOpenPageSetup,
      onDownloadPng,
      onDownloadPdf,
      onMakeCopy,
      onToggleNotes,
      onFitToWindow,
      onZoomIn,
      onZoomOut,
      onToggleSlidePanel,
      onInsertShape,
    ],
  );

  // Saved-state indicator. Three states:
  //   "Saving…"        — an export is in flight.
  //   "Unsaved changes" — a mutation has fired since the last save.
  //   "Saved"          — clean (no mutations since the last save OR the
  //                      initial render). Mirrors Google Docs' "All
  //                      changes saved in Drive" copy but trimmed for
  //                      our footprint.
  const savedLabel = saving
    ? t('titlebar.saved.saving')
    : dirty
      ? t('titlebar.saved.dirty')
      : t('titlebar.saved.clean');

  return (
    <header className="cs-titlebar">
      <a className="cs-titlebar__brand" href="#" aria-label={t('titlebar.brand')}>
        <svg viewBox="0 0 32 40" width="28" height="36" aria-hidden="true">
          <path d="M2 0C0.9 0 0 0.9 0 2V38C0 39.1 0.9 40 2 40H30C31.1 40 32 39.1 32 38V10L22 0H2Z" fill="#0891B2" />
          <path d="M22 0L32 10H24C22.9 10 22 9.1 22 8V0Z" fill="#0E7490" />
          <rect x="6" y="17" width="20" height="14" rx="1" fill="#fff" opacity="0.95" />
          <rect x="8" y="19" width="10" height="2" rx="0.5" fill="#0891B2" />
          <rect x="8" y="23" width="14" height="1.5" rx="0.5" fill="#0891B2" opacity="0.7" />
          <rect x="8" y="26" width="10" height="1.5" rx="0.5" fill="#0891B2" opacity="0.7" />
          <path d="M20.5 26 L24 27.75 L20.5 29.5 Z" fill="#0891B2" />
        </svg>
      </a>
      <div className="cs-titlebar__center">
        <div className="cs-titlebar__row cs-titlebar__row--top">
          {filenameEditing ? (
            <input
              ref={inputRef}
              className="cs-titlebar__filename-input"
              value={draft}
              maxLength={120}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setFilenameEditing(false);
                if (draft.trim()) onFileNameChange(draft.trim());
                else setDraft(fileName);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') inputRef.current?.blur();
                if (e.key === 'Escape') {
                  setDraft(fileName);
                  setFilenameEditing(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="cs-titlebar__filename"
              onClick={() => setFilenameEditing(true)}
              title={t('titlebar.filenameRename')}
            >
              {fileName}
            </button>
          )}
          <span
            className={`cs-titlebar__saved cs-titlebar__saved--${saving ? 'saving' : dirty ? 'dirty' : 'clean'}`}
            data-testid="saved-indicator"
            title={savedLabel}
          >
            {savedLabel}
          </span>
          {status && (
            <span className="cs-titlebar__pill cs-titlebar__pill--status" title={status}>
              <span className="cs-titlebar__pill-text">{status}</span>
              {onDismissStatus && (
                <button
                  type="button"
                  className="cs-titlebar__pill-dismiss"
                  aria-label={t('titlebar.pill.dismissStatus')}
                  onClick={onDismissStatus}
                >
                  <Icon name="close" size={10} />
                </button>
              )}
            </span>
          )}
          {error && (
            <span className="cs-titlebar__pill cs-titlebar__pill--error" title={error}>
              <Icon name="error" size={12} />
              <span className="cs-titlebar__pill-text">{error}</span>
              {onDismissError && (
                <button
                  type="button"
                  className="cs-titlebar__pill-dismiss"
                  aria-label={t('titlebar.pill.dismissError')}
                  onClick={onDismissError}
                >
                  <Icon name="close" size={10} />
                </button>
              )}
            </span>
          )}
        </div>
        <nav className="cs-titlebar__row cs-titlebar__row--menus" ref={menuStripRef}>
          {MENUS.map((menu) => (
            <div key={menu.id} className="cs-menu">
              <button
                type="button"
                className={`cs-menu__trigger ${openMenu === menu.id ? 'is-open' : ''}`}
                onClick={() => setOpenMenu(openMenu === menu.id ? null : menu.id)}
                onMouseEnter={() => openMenu && setOpenMenu(menu.id)}
              >
                {menu.label}
              </button>
              {openMenu === menu.id && (
                <ul className="cs-menu__list">
                  {menu.items.map((item) =>
                    isSep(item) ? (
                      <li key={item.id} className="cs-menu__sep" role="separator" />
                    ) : (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="cs-menu__item"
                          data-menu={menu.id}
                          data-menu-item={item.id}
                          onClick={() => handleMenuItem(menu.id, item.id)}
                        >
                          <span>{item.label}</span>
                          {(item as MenuItem).shortcut && (
                            <span className="cs-menu__shortcut">{(item as MenuItem).shortcut}</span>
                          )}
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </div>
          ))}
        </nav>
      </div>
      <div className="cs-titlebar__actions">
        {collabRoomId && (() => {
          // Tooltip selects between the live + peers form and the
          // generic state form. The live tooltip uses i18next plural
          // form selection on `count`.
          const peerCount = collabPeers + 1;
          const liveTooltip = t('titlebar.collab.liveTooltip', {
            count: peerCount,
            room: collabRoomId,
          });
          const stateTooltip = t('titlebar.collab.stateTooltip', {
            room: collabRoomId,
            state: collabStatus ?? t('titlebar.collab.idle'),
          });
          const statusLabel =
            collabStatus === 'live'
              ? t('titlebar.collab.live')
              : collabStatus === 'connecting'
                ? t('titlebar.collab.connecting')
                : collabStatus === 'reconnecting'
                  ? t('titlebar.collab.reconnecting')
                  : collabStatus === 'error'
                    ? t('titlebar.collab.error')
                    : t('titlebar.collab.idle');
          return (
            <span
              className={`cs-titlebar__live cs-titlebar__live--${collabStatus ?? 'idle'}`}
              data-testid="collab-pill"
              title={collabStatus === 'live' ? liveTooltip : stateTooltip}
            >
              <span className="cs-titlebar__live-dot" />
              {statusLabel}
              {collabStatus === 'live' && collabPeers > 0 && ` · ${peerCount}`}
            </span>
          );
        })()}
        <button type="button" className="cs-btn cs-btn--ghost" onClick={onOpen} disabled={opening}>
          <Icon name="folder_open" size={18} />
          <span>{opening ? t('titlebar.actions.opening') : t('titlebar.actions.open')}</span>
        </button>
        <button type="button" className="cs-btn cs-btn--ghost" onClick={onSave} disabled={saving}>
          <Icon name="download" size={18} />
          <span>{saving ? t('titlebar.actions.saving') : t('titlebar.actions.save')}</span>
        </button>
        {/* TODO: reinstate Share button in Phase 2 once collab links land
         *  (room URL + read/edit toggle). Avatar/identity returns then too. */}
      </div>
    </header>
  );
}

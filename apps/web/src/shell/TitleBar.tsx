import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './icons';
import { clearFormatting, dispatchSlideCommand } from '../univer/commands';

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
  /** Left-icon name from the existing `icons.tsx` map. Optional so existing
      callers don't break; menu rendering renders a 16-px spacer slot when
      omitted so columns stay aligned. UX audit S5. */
  icon?: string;
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
      { id: 'new',         label: t('menu:file.new'),         shortcut: t('menu:file.shortcut.new'),  icon: 'add' },
      { id: 'open',        label: t('menu:file.open'),        shortcut: t('menu:file.shortcut.open'), icon: 'folder_open' },
      { id: 'recent',      label: t('menu:file.recent'),                                              icon: 'history' },
      { id: 'save',        label: t('menu:file.save'),        shortcut: t('menu:file.shortcut.save'),                                                                                          icon: 'download' },
      { id: 'makeCopy',    label: t('menu:file.makeCopy'),                                            icon: 'content_copy' },
      { id: 'sep1', label: '---' },
      { id: 'downloadPng', label: t('menu:file.downloadPng'),                                         icon: 'image' },
      { id: 'downloadPdf', label: t('menu:file.downloadPdf'),                                         icon: 'print' },
      { id: 'pageSetup',   label: t('menu:file.pageSetup'),                                           icon: 'straighten' },
      { id: 'properties',  label: t('menu:file.properties'),                                          icon: 'info' },
    ] },
    { id: 'edit', label: t('menu:edit.label'), items: [
      { id: 'undo',  label: t('menu:edit.undo'),  shortcut: t('menu:edit.shortcut.undo'),  icon: 'undo' },
      { id: 'redo',  label: t('menu:edit.redo'),  shortcut: t('menu:edit.shortcut.redo'),  icon: 'redo' },
      { id: 'sep1', label: '---' },
      { id: 'cut',   label: t('menu:edit.cut'),   shortcut: t('menu:edit.shortcut.cut') },
      { id: 'copy',  label: t('menu:edit.copy'),  shortcut: t('menu:edit.shortcut.copy'),  icon: 'content_copy' },
      { id: 'paste', label: t('menu:edit.paste'), shortcut: t('menu:edit.shortcut.paste') },
    ] },
    { id: 'view', label: t('menu:view.label'), items: [
      { id: 'fit',      label: t('menu:view.fit'),                                                   icon: 'fullscreen' },
      { id: 'zoom-in',  label: t('menu:view.zoomIn'),  shortcut: t('menu:view.shortcut.zoomIn'),     icon: 'add' },
      { id: 'zoom-out', label: t('menu:view.zoomOut'), shortcut: t('menu:view.shortcut.zoomOut'),    icon: 'remove' },
      { id: 'sep1', label: '---' },
      { id: 'thumbs',   label: t('menu:view.thumbs'),                                                icon: 'view_module' },
      { id: 'notes',    label: t('menu:view.notes'),                                                 icon: 'sticky_note_2' },
    ] },
    { id: 'insert', label: t('menu:insert.label'), items: [
      { id: 'text',  label: t('menu:insert.text'),                                                     icon: 'text_fields' },
      { id: 'shape', label: t('menu:insert.shape'),                                                    icon: 'rectangle' },
      { id: 'image', label: t('menu:insert.image'),                                                    icon: 'image' },
      { id: 'sep1', label: '---' },
      { id: 'slide', label: t('menu:insert.slide'), shortcut: t('menu:insert.shortcut.slide'),         icon: 'add_to_photos' },
    ] },
    { id: 'format', label: t('menu:format.label'), items: [
      { id: 'bold',          label: t('menu:format.bold'),          shortcut: t('menu:format.shortcut.bold'),          icon: 'bold' },
      { id: 'italic',        label: t('menu:format.italic'),        shortcut: t('menu:format.shortcut.italic'),        icon: 'italic' },
      { id: 'underline',     label: t('menu:format.underline'),     shortcut: t('menu:format.shortcut.underline'),     icon: 'underline' },
      { id: 'strikethrough', label: t('menu:format.strikethrough'), shortcut: t('menu:format.shortcut.strikethrough'), icon: 'strikethrough' },
      { id: 'sep1', label: '---' },
      { id: 'alignLeft',     label: t('menu:format.alignLeft'),                                                       icon: 'format_align_left' },
      { id: 'alignCenter',   label: t('menu:format.alignCenter'),                                                     icon: 'format_align_center' },
      { id: 'alignRight',    label: t('menu:format.alignRight'),                                                      icon: 'format_align_right' },
      { id: 'alignJustify',  label: t('menu:format.alignJustify'),                                                    icon: 'format_align_justify' },
      { id: 'sep2', label: '---' },
      { id: 'indentDecrease', label: t('menu:format.indentDecrease'), shortcut: t('menu:format.shortcut.indentDecrease'), icon: 'format_indent_decrease' },
      { id: 'indentIncrease', label: t('menu:format.indentIncrease'), shortcut: t('menu:format.shortcut.indentIncrease'), icon: 'format_indent_increase' },
      { id: 'sep3', label: '---' },
      { id: 'insertLink',     label: t('menu:format.insertLink'),     shortcut: t('menu:format.shortcut.insertLink'),     icon: 'link' },
      { id: 'clearFormatting',label: t('menu:format.clearFormatting'),shortcut: t('menu:format.shortcut.clearFormatting'),icon: 'format_clear' },
    ] },
    { id: 'slide', label: t('menu:slide.label'), items: [
      { id: 'new',       label: t('menu:slide.new'),       shortcut: t('menu:slide.shortcut.new'),       icon: 'add_to_photos' },
      { id: 'duplicate', label: t('menu:slide.duplicate'), shortcut: t('menu:slide.shortcut.duplicate'), icon: 'content_copy' },
      { id: 'sep1', label: '---' },
      { id: 'theme',     label: t('menu:slide.theme'),                                                  icon: 'palette' },
      { id: 'sep2', label: '---' },
      { id: 'delete',    label: t('menu:slide.delete'),    shortcut: t('menu:slide.shortcut.delete'),   icon: 'delete' },
    ] },
    { id: 'arrange', label: t('menu:arrange.label'), items: [
      { id: 'bringToFront', label: t('menu:arrange.bringToFront'), shortcut: t('menu:arrange.shortcut.bringToFront'), icon: 'arrow_upward' },
      { id: 'bringForward', label: t('menu:arrange.bringForward'), shortcut: t('menu:arrange.shortcut.bringForward'), icon: 'chevron_up' },
      { id: 'sendBackward', label: t('menu:arrange.sendBackward'), shortcut: t('menu:arrange.shortcut.sendBackward'), icon: 'chevron_down' },
      { id: 'sendToBack',   label: t('menu:arrange.sendToBack'),   shortcut: t('menu:arrange.shortcut.sendToBack'),   icon: 'arrow_downward' },
      { id: 'sep1', label: '---' },
      { id: 'centerH',      label: t('menu:arrange.centerH'),                                                         icon: 'filter_center_focus' },
      { id: 'centerV',      label: t('menu:arrange.centerV'),                                                         icon: 'filter_center_focus' },
      { id: 'centerBoth',   label: t('menu:arrange.centerBoth'),                                                      icon: 'filter_center_focus' },
    ] },
    { id: 'help', label: t('menu:help.label'), items: [
      { id: 'about', label: t('menu:help.about'),                                                       icon: 'info' },
      { id: 'repo',  label: t('menu:help.repo'),                                                        icon: 'link' },
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

  // App.tsx dispatches `cs:rename-filename` when the user presses F2
  // outside an editable surface — the TitleBar owns the editing flag,
  // so we listen here and flip it. Keeps the rename wiring local to
  // the titlebar without prop-drilling a setter to App.
  useEffect(() => {
    const handler = () => setFilenameEditing(true);
    window.addEventListener('cs:rename-filename', handler);
    return () => window.removeEventListener('cs:rename-filename', handler);
  }, []);

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
      // Format menu — text styling + paragraph alignment + indent + link.
      // Each command requires a TEXT selection on the active slide; the
      // doc.* commands no-op silently when no text frame has focus.
      // Audit S1.
      if (menuId === 'format') {
        if (itemId === 'bold')           void dispatchSlideCommand('doc.command.set-inline-format-bold');
        if (itemId === 'italic')         void dispatchSlideCommand('doc.command.set-inline-format-italic');
        if (itemId === 'underline')      void dispatchSlideCommand('doc.command.set-inline-format-underline');
        if (itemId === 'strikethrough')  void dispatchSlideCommand('doc.command.set-inline-format-strikethrough');
        if (itemId === 'alignLeft')      void dispatchSlideCommand('doc.command.align-left');
        if (itemId === 'alignCenter')    void dispatchSlideCommand('doc.command.align-center');
        if (itemId === 'alignRight')     void dispatchSlideCommand('doc.command.align-right');
        if (itemId === 'alignJustify')   void dispatchSlideCommand('doc.command.align-justify');
        if (itemId === 'indentDecrease') void dispatchSlideCommand('doc.command.change-list-nesting-level', { type: 'decrease' });
        if (itemId === 'indentIncrease') void dispatchSlideCommand('doc.command.change-list-nesting-level', { type: 'increase' });
        if (itemId === 'insertLink')     void dispatchSlideCommand('casual-slides.command.insert-link');
        if (itemId === 'clearFormatting') void clearFormatting();
        return;
      }
      // Slide menu — deck-level slide operations + theme picker.
      // Layout and Background live in the toolbar's Slide ▾ popover
      // since they need anchor rects we can't synthesize from a menu
      // (handled by S2 inline toolbar buttons in a follow-up).
      if (menuId === 'slide') {
        // Resolve the active page id from the live model — slide.command.*
        // commands no-op without it (the SlideContextMenu path passes it
        // explicitly; the menu strip didn't, which is why Slide → Delete
        // appeared to do nothing — probe 2026-06-02).
        const activePageId = (() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            const inj = w.univer?.__getInjector?.();
            const inst = inj?.get?.(w.__casualSlides__IUniverInstanceService);
            return inst?.getCurrentUnitOfType?.(3)?.getActivePage?.()?.id as string | undefined;
          } catch { return undefined; }
        })();
        if (itemId === 'new')       void dispatchSlideCommand('slide.operation.append-slide');
        if (itemId === 'duplicate') void dispatchSlideCommand('slide.command.duplicate-slide', activePageId ? { pageId: activePageId } : undefined);
        if (itemId === 'theme') {
          (window as Window & { __casualSlides_openThemes?: () => void })
            .__casualSlides_openThemes?.();
        }
        if (itemId === 'delete')    void dispatchSlideCommand('slide.command.delete-slide', activePageId ? { pageId: activePageId } : undefined);
        return;
      }
      // Arrange menu — z-order + center-on-slide. Both require an
      // element selection; commands no-op when no element is focused.
      if (menuId === 'arrange') {
        if (itemId === 'bringToFront') void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'front' });
        if (itemId === 'bringForward') void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'forward' });
        if (itemId === 'sendBackward') void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'backward' });
        if (itemId === 'sendToBack')   void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'back' });
        if (itemId === 'centerH')      void dispatchSlideCommand('casual-slides.command.center-on-slide', { axis: 'h' });
        if (itemId === 'centerV')      void dispatchSlideCommand('casual-slides.command.center-on-slide', { axis: 'v' });
        if (itemId === 'centerBoth')   void dispatchSlideCommand('casual-slides.command.center-on-slide', { axis: 'both' });
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
        <img
          src={`${import.meta.env.BASE_URL}brand.svg`}
          alt={t('titlebar.brand')}
          width={32}
          height={40}
        />
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
              title={`${fileName} — ${t('titlebar.filenameRename')}`}
              aria-label={`${fileName} — ${t('titlebar.filenameRename')}`}
            >
              {fileName}
            </button>
          )}
          <span
            className={`cs-titlebar__saved cs-titlebar__saved--${saving ? 'saving' : dirty ? 'dirty' : 'clean'}`}
            data-testid="saved-indicator"
            title={savedLabel}
            style={{
              // Whisper styling — de-emphasised so the filename reads as
              // the primary identity. Mirrors Google Docs / Slides
              // "All changes saved in Drive" treatment. Audit P2.
              fontSize: 12,
              fontWeight: 400,
              color: 'var(--cs-text-mute, #5f6368)',
              marginLeft: 8,
            }}
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
                          {/* Left icon slot — Google Slides / PowerPoint
                              menu pattern. 18 px slot keeps text columns
                              aligned even when an item has no icon. */}
                          <span
                            className="cs-menu__item-icon"
                            aria-hidden="true"
                            style={{
                              display: 'inline-flex',
                              width: 18,
                              height: 18,
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              marginRight: 8,
                              color: 'var(--cs-text-mute, #5f6368)',
                            }}
                          >
                            {(item as MenuItem).icon && (
                              <Icon name={(item as MenuItem).icon!} size={16} />
                            )}
                          </span>
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

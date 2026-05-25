import { useCallback, useEffect, useRef, useState } from 'react';

// Office 365-style title bar.
// Logo + editable filename in the center. Menu strip (File / Edit / View / Help)
// runs along the left below the title. Action chips (Share / user) sit on the
// right. Matches the "merged title bar" idiom used by Google Docs and the
// sister Casual Sheets product.

export interface TitleBarProps {
  fileName: string;
  onFileNameChange: (next: string) => void;
  onOpen: () => void;
  onSave: () => void;
  saving?: boolean;
  opening?: boolean;
  status?: string | null;
  error?: string | null;
}

const MENU_ITEMS: { id: string; label: string; items: { id: string; label: string; shortcut?: string; onClick?: () => void }[] }[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'new', label: 'New', shortcut: 'Ctrl+N' },
      { id: 'open', label: 'Open…', shortcut: 'Ctrl+O' },
      { id: 'save', label: 'Save', shortcut: 'Ctrl+S' },
      { id: 'sep1', label: '---' },
      { id: 'properties', label: 'Properties' },
      { id: 'share', label: 'Share' },
    ],
  },
  { id: 'edit', label: 'Edit', items: [
    { id: 'undo', label: 'Undo', shortcut: 'Ctrl+Z' },
    { id: 'redo', label: 'Redo', shortcut: 'Ctrl+Y' },
    { id: 'sep1', label: '---' },
    { id: 'cut', label: 'Cut', shortcut: 'Ctrl+X' },
    { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C' },
    { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V' },
  ] },
  { id: 'view', label: 'View', items: [
    { id: 'fit', label: 'Fit to window' },
    { id: 'zoom-in', label: 'Zoom in', shortcut: 'Ctrl++' },
    { id: 'zoom-out', label: 'Zoom out', shortcut: 'Ctrl+-' },
    { id: 'sep1', label: '---' },
    { id: 'thumbs', label: 'Slide panel' },
    { id: 'notes', label: 'Speaker notes' },
  ] },
  { id: 'insert', label: 'Insert', items: [
    { id: 'text', label: 'Text box' },
    { id: 'shape', label: 'Shape' },
    { id: 'image', label: 'Image' },
    { id: 'sep1', label: '---' },
    { id: 'slide', label: 'New slide', shortcut: 'Ctrl+M' },
  ] },
  { id: 'help', label: 'Help', items: [
    { id: 'about', label: 'About Casual Slides' },
    { id: 'repo', label: 'GitHub repo' },
  ] },
];

export function TitleBar({
  fileName,
  onFileNameChange,
  onOpen,
  onSave,
  saving,
  opening,
  status,
  error,
}: TitleBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [filenameEditing, setFilenameEditing] = useState(false);
  const [draft, setDraft] = useState(fileName);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuStripRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(fileName), [fileName]);
  useEffect(() => {
    if (filenameEditing) inputRef.current?.select();
  }, [filenameEditing]);

  // Close any open menu on outside click. Menus close on item click too;
  // this catches click-outside-on-canvas + click-on-other-chrome.
  useEffect(() => {
    if (!openMenu) return;
    const handler = (e: MouseEvent) => {
      if (!menuStripRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openMenu]);

  const handleMenuItem = useCallback((menuId: string, itemId: string) => {
    setOpenMenu(null);
    if (menuId === 'file' && itemId === 'open') onOpen();
    if (menuId === 'file' && itemId === 'save') onSave();
    // Other items are visual-only placeholders for P1+.
  }, [onOpen, onSave]);

  return (
    <header className="cs-titlebar">
      <div className="cs-titlebar__top">
        <div className="cs-titlebar__brand">
          <span className="cs-titlebar__logo">
            <svg viewBox="0 0 32 40" width="20" height="25" aria-hidden="true">
              <path d="M2 0C0.9 0 0 0.9 0 2V38C0 39.1 0.9 40 2 40H30C31.1 40 32 39.1 32 38V10L22 0H2Z" fill="#B7472A" />
              <path d="M22 0L32 10H24C22.9 10 22 9.1 22 8V0Z" fill="#8B3520" />
              <rect x="6" y="17" width="20" height="14" rx="1" fill="#fff" opacity="0.95" />
              <rect x="8" y="19" width="10" height="2" rx="0.5" fill="#B7472A" />
              <rect x="8" y="23" width="14" height="1.5" rx="0.5" fill="#B7472A" opacity="0.7" />
              <rect x="8" y="26" width="10" height="1.5" rx="0.5" fill="#B7472A" opacity="0.7" />
              <path d="M20.5 26 L24 27.75 L20.5 29.5 Z" fill="#B7472A" />
            </svg>
          </span>
          <span className="cs-titlebar__product">Casual Slides</span>
          <span className="cs-titlebar__sep" aria-hidden="true">·</span>
          {filenameEditing ? (
            <input
              ref={inputRef}
              className="cs-titlebar__filename-input"
              value={draft}
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
              title="Rename"
            >
              {fileName}
            </button>
          )}
          {status && <span className="cs-titlebar__status" title={status}>{status}</span>}
          {error && <span className="cs-titlebar__error" title={error}>⚠ {error}</span>}
        </div>
        <div className="cs-titlebar__actions">
          <button
            type="button"
            className="cs-btn cs-btn--ghost"
            onClick={onOpen}
            disabled={opening}
          >
            {opening ? 'Opening…' : 'Open'}
          </button>
          <button
            type="button"
            className="cs-btn cs-btn--primary"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="cs-btn cs-btn--ghost" disabled title="Coming soon">
            Share
          </button>
          <span className="cs-titlebar__avatar" title="You">U</span>
        </div>
      </div>
      <nav className="cs-titlebar__menus" ref={menuStripRef}>
        {MENU_ITEMS.map((menu) => (
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
                  item.label === '---' ? (
                    <li key={item.id} className="cs-menu__sep" role="separator" />
                  ) : (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="cs-menu__item"
                        onClick={() => handleMenuItem(menu.id, item.id)}
                      >
                        <span>{item.label}</span>
                        {item.shortcut && <span className="cs-menu__shortcut">{item.shortcut}</span>}
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
        ))}
      </nav>
    </header>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

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
  saving?: boolean;
  opening?: boolean;
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

const MENUS: MenuDef[] = [
  { id: 'file', label: 'File', items: [
    { id: 'new', label: 'New', shortcut: 'Ctrl+N' },
    { id: 'open', label: 'Open', shortcut: 'Ctrl+O' },
    { id: 'save', label: 'Save', shortcut: 'Ctrl+S' },
    { id: 'sep1', label: '---' },
    { id: 'properties', label: 'Properties' },
    { id: 'share', label: 'Share' },
  ] },
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

const isSep = (i: MenuDef['items'][number]): i is { id: string; label: '---' } => i.label === '---';

export function TitleBar({
  fileName,
  onFileNameChange,
  onOpen,
  onSave,
  saving,
  opening,
  status,
  error,
  collabStatus,
  collabRoomId,
  collabPeers = 0,
}: TitleBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [filenameEditing, setFilenameEditing] = useState(false);
  const [draft, setDraft] = useState(fileName);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuStripRef = useRef<HTMLDivElement>(null);

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
      if (menuId === 'file' && itemId === 'open') onOpen();
      if (menuId === 'file' && itemId === 'save') onSave();
    },
    [onOpen, onSave],
  );

  return (
    <header className="cs-titlebar">
      <a className="cs-titlebar__brand" href="#" aria-label="Casual Slides">
        <svg viewBox="0 0 32 40" width="28" height="36" aria-hidden="true">
          <path d="M2 0C0.9 0 0 0.9 0 2V38C0 39.1 0.9 40 2 40H30C31.1 40 32 39.1 32 38V10L22 0H2Z" fill="#B7472A" />
          <path d="M22 0L32 10H24C22.9 10 22 9.1 22 8V0Z" fill="#8B3520" />
          <rect x="6" y="17" width="20" height="14" rx="1" fill="#fff" opacity="0.95" />
          <rect x="8" y="19" width="10" height="2" rx="0.5" fill="#B7472A" />
          <rect x="8" y="23" width="14" height="1.5" rx="0.5" fill="#B7472A" opacity="0.7" />
          <rect x="8" y="26" width="10" height="1.5" rx="0.5" fill="#B7472A" opacity="0.7" />
          <path d="M20.5 26 L24 27.75 L20.5 29.5 Z" fill="#B7472A" />
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
              title="Rename"
            >
              {fileName}
            </button>
          )}
          {status && (
            <span className="cs-titlebar__pill cs-titlebar__pill--status" title={status}>
              {status}
            </span>
          )}
          {error && (
            <span className="cs-titlebar__pill cs-titlebar__pill--error" title={error}>
              <Icon name="error" size={12} />
              {error}
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
        {collabRoomId && (
          <span
            className={`cs-titlebar__live cs-titlebar__live--${collabStatus ?? 'idle'}`}
            data-testid="collab-pill"
            title={
              collabStatus === 'live'
                ? `Live in room "${collabRoomId}" · ${collabPeers + 1} editor${collabPeers ? 's' : ''}`
                : `Collab room ${collabRoomId} (${collabStatus ?? 'idle'})`
            }
          >
            <span className="cs-titlebar__live-dot" />
            {collabStatus === 'live' ? 'Live' : (collabStatus ?? 'idle')}
            {collabStatus === 'live' && collabPeers > 0 && ` · ${collabPeers + 1}`}
          </span>
        )}
        <button type="button" className="cs-btn cs-btn--ghost" onClick={onOpen} disabled={opening}>
          <Icon name="folder_open" size={16} />
          <span>{opening ? 'Opening' : 'Open'}</span>
        </button>
        <button type="button" className="cs-btn cs-btn--ghost" onClick={onSave} disabled={saving}>
          <Icon name="download" size={16} />
          <span>{saving ? 'Saving' : 'Save'}</span>
        </button>
        <button type="button" className="cs-btn cs-btn--primary" disabled title="Coming soon">
          <Icon name="person_add" size={16} />
          <span>Share</span>
        </button>
        <span className="cs-titlebar__avatar" title="You">U</span>
      </div>
    </header>
  );
}

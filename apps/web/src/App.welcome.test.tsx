// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { clearAutosave, importPresentation, loadAutosave, saveAutosave } = vi.hoisted(() => ({
  clearAutosave: vi.fn(),
  importPresentation: vi.fn(),
  loadAutosave: vi.fn().mockResolvedValue(null),
  saveAutosave: vi.fn(),
}));

vi.mock('./pptx/client', () => ({
  getPptxClient: () => ({ import: importPresentation }),
}));
vi.mock('./storage/autosave', () => ({
  clearAutosave,
  loadAutosave,
  saveAutosave,
}));
vi.mock('./storage/recent-files', () => ({ addRecent: vi.fn() }));
vi.mock('./collab/CollabProvider', () => ({
  useCollabBridge: () => ({ status: 'idle', roomId: null, peers: 0 }),
}));
vi.mock('./UniverSlide', () => ({
  UniverSlide: ({ snapshot }: { snapshot: { id: string } }) => (
    <div data-testid="slides-editor" data-snapshot-id={snapshot.id} />
  ),
}));
vi.mock('./shell/TitleBar', () => ({
  TitleBar: ({ onFileNameChange }: { onFileNameChange: (name: string) => void }) => (
    <button type="button" data-testid="rename-presentation" onClick={() => onFileNameChange('Edited deck')}>
      Rename
    </button>
  ),
}));
vi.mock('./shell/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('./shell/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('./shell/NotesPanel', () => ({ NotesPanel: () => null }));
vi.mock('./shell/BusyOverlay', () => ({ BusyOverlay: () => null }));
vi.mock('./shell/UniverBootSplash', () => ({ UniverBootSplash: () => null }));
vi.mock('./shell/SlideContextMenu', () => ({ SlideContextMenu: () => null }));
vi.mock('./shell/AutosaveRestoreBanner', () => ({
  AutosaveRestoreBanner: ({ offer }: { offer: unknown }) =>
    offer ? <div data-testid="autosave-offer" /> : null,
}));
vi.mock('./shell/RecentFilesDialog', () => ({
  RecentFilesDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Recent files" /> : null,
}));

import { App } from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

async function renderApp() {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<App />));
  return host;
}

afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
  importPresentation.mockReset();
  clearAutosave.mockReset();
  saveAutosave.mockReset();
  loadAutosave.mockReset().mockResolvedValue(null);
  vi.restoreAllMocks();
});

describe('Slides welcome integration', () => {
  it('starts at Welcome and enters the existing default editor from New presentation', async () => {
    const host = await renderApp();

    expect(host.querySelector('[data-testid="slides-editor"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="New presentation"]')?.click());

    expect(window.location.hash).toBe('#editor');
    expect(host.querySelector('[data-testid="slides-editor"]')).not.toBeNull();
    expect(clearAutosave).not.toHaveBeenCalled();
  });

  it('supports the explicit direct-editor mount used by editor integrations', async () => {
    window.history.replaceState(null, '', '/#editor');
    const host = await renderApp();

    expect(host.querySelector('[data-testid="slides-editor"]')).not.toBeNull();
    expect(host.querySelector('[aria-labelledby="welcome-title"]')).toBeNull();
  });

  it('returns to Welcome when browser navigation leaves the editor hash', async () => {
    window.history.replaceState(null, '', '/#editor');
    const host = await renderApp();

    await act(async () => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(host.querySelector('[aria-labelledby="welcome-title"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="slides-editor"]')).toBeNull();
  });

  it('keeps the editor open when browser navigation away is declined with unsaved work', async () => {
    window.history.replaceState(null, '', '/#editor');
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const host = await renderApp();

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="rename-presentation"]')?.click());
    await act(async () => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(window.location.hash).toBe('#editor');
    expect(host.querySelector('[data-testid="slides-editor"]')).not.toBeNull();
  });

  it('deduplicates popstate and hashchange for one dirty navigation', async () => {
    window.history.replaceState(null, '', '/#editor');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const host = await renderApp();

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="rename-presentation"]')?.click());
    await act(async () => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(saveAutosave).toHaveBeenCalledOnce();
  });

  it('opens Recent presentations above the welcome surface', async () => {
    const host = await renderApp();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Recent presentations"]')?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')).not.toBeNull());
  });

  it('shows import and file-read failures on the welcome page', async () => {
    importPresentation.mockRejectedValueOnce(new Error('Presentation could not be opened'));
    const host = await renderApp();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Welcome file input was not rendered');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ name: 'broken.pptx', arrayBuffer: async () => new ArrayBuffer(1) }],
    });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('Presentation could not be opened');
    });

    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{
        name: 'unreadable.pptx',
        arrayBuffer: vi.fn().mockRejectedValue(new Error('Presentation could not be read')),
      }],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('Presentation could not be read');
    });
  });

  it('keeps the newest presentation when concurrent imports resolve out of order', async () => {
    let resolveFirst: (snapshot: unknown) => void = () => undefined;
    let resolveSecond: (snapshot: unknown) => void = () => undefined;
    importPresentation
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    const host = await renderApp();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Welcome file input was not rendered');

    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'first.pptx', arrayBuffer: async () => new ArrayBuffer(1) }] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'second.pptx', arrayBuffer: async () => new ArrayBuffer(2) }] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      resolveSecond({ id: 'second', title: 'Second', body: { pageOrder: [], pages: {} } });
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst({ id: 'first', title: 'First', body: { pageOrder: [], pages: {} } });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="slides-editor"]')?.getAttribute('data-snapshot-id')).toBe('second');
    });
    expect(clearAutosave).not.toHaveBeenCalled();
  });

  it('does not surface delayed recovery after New or a direct-editor edit', async () => {
    let resolveAutosave: (record: unknown) => void = () => undefined;
    loadAutosave.mockReturnValueOnce(new Promise((resolve) => { resolveAutosave = resolve; }));
    const welcomeHost = await renderApp();

    await act(async () => {
      welcomeHost.querySelector<HTMLButtonElement>('[aria-label="New presentation"]')?.click();
      resolveAutosave({ snapshot: { id: 'default-slide-deck' } });
      await Promise.resolve();
    });
    expect(welcomeHost.querySelector('[data-testid="autosave-offer"]')).toBeNull();

    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/#editor');
    loadAutosave.mockReset().mockReturnValueOnce(new Promise((resolve) => { resolveAutosave = resolve; }));
    const editorHost = await renderApp();
    await act(async () => editorHost.querySelector<HTMLButtonElement>('[data-testid="rename-presentation"]')?.click());
    await act(async () => {
      resolveAutosave({ snapshot: { id: 'default-slide-deck' } });
      await Promise.resolve();
    });

    expect(editorHost.querySelector('[data-testid="autosave-offer"]')).toBeNull();
  });
});

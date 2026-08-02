// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRecents, loadRecent } from '../storage/recent-files';
import { RecentFilesDialog } from './RecentFilesDialog';

vi.mock('../storage/recent-files', () => ({
  clearRecents: vi.fn(),
  listRecents: vi.fn(),
  loadRecent: vi.fn(),
  removeRecent: vi.fn(),
  setRecentPinned: vi.fn(),
}));
vi.mock('./use-focus-trap', () => ({ useFocusTrap: () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('RecentFilesDialog', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('announces the accessible empty state', async () => {
    vi.mocked(listRecents).mockResolvedValue([]);
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);

    await act(async () => {
      root.render(<RecentFilesDialog open onClose={vi.fn()} onOpen={vi.fn()} />);
      await Promise.resolve();
    });

    expect(host.querySelector('[role="status"]')?.textContent).toContain('No recent decks yet');
  });

  it('opens a stored recent presentation through the supplied handler', async () => {
    const bytes = new ArrayBuffer(4);
    const onOpen = vi.fn();
    vi.mocked(listRecents).mockResolvedValue([{ id: 'deck', name: 'Quarterly.pptx', size: 4, openedAt: 0, pinned: false }]);
    vi.mocked(loadRecent).mockResolvedValue(bytes);
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);

    await act(async () => {
      root.render(<RecentFilesDialog open onClose={vi.fn()} onOpen={onOpen} />);
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="recent-item"]')?.click();
      await Promise.resolve();
    });

    expect(onOpen).toHaveBeenCalledWith(bytes, 'Quarterly.pptx');
  });
});

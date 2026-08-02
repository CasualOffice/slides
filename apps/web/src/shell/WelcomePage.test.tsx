// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WelcomePage } from './WelcomePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('WelcomePage', () => {
  afterEach(() => document.body.replaceChildren());

  it('starts a presentation, opens a file, and opens recent presentations', async () => {
    const onNew = vi.fn();
    const onOpen = vi.fn();
    const onOpenRecent = vi.fn();
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);

    await act(async () => {
      root.render(<WelcomePage onNew={onNew} onOpen={onOpen} onOpenRecent={onOpenRecent} />);
    });

    const getButtonByName = (name: string) => {
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((candidate) => candidate.getAttribute('aria-label') === name);
      if (!button) throw new Error(`button role with name ${name} not found`);
      return button;
    };
    await act(async () => getButtonByName('New presentation').click());
    await act(async () => getButtonByName('Open presentation').click());
    await act(async () => getButtonByName('Recent presentations').click());

    expect(onNew).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpenRecent).toHaveBeenCalledOnce();
  });

  it('reports import progress and errors without exposing active actions', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <WelcomePage
          onNew={vi.fn()}
          onOpen={vi.fn()}
          onOpenRecent={vi.fn()}
          opening
          error="Presentation could not be opened"
        />,
      );
    });

    expect(host.querySelector('[role="status"]')?.textContent).toBe('Opening presentation…');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Presentation could not be opened');
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).every((button) => button.disabled)).toBe(true);
  });
});

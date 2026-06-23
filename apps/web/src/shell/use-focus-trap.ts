import { useEffect } from 'react';
import type { RefObject } from 'react';

// Focus trap for modal dialogs. While `active`, Tab / Shift+Tab cycle
// within the container and focus can't escape to the chrome behind the
// backdrop. On activate, focus moves to the first focusable element (or
// the container itself). On deactivate, focus returns to whatever was
// focused before the dialog opened.
//
// Pairs with `aria-modal="true"` on the dialog element so assistive tech
// announces the modal context too.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap(active: boolean, ref: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Move focus inside on mount.
    const first = focusables()[0];
    (first ?? container).focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      // length > 0 was just asserted — both indexes are inhabited.
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === firstEl || !container.contains(activeEl)) {
          e.preventDefault();
          lastEl.focus({ preventScroll: true });
        }
      } else if (activeEl === lastEl) {
        e.preventDefault();
        firstEl.focus({ preventScroll: true });
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Restore focus to the trigger when the dialog closes.
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [active, ref]);
}

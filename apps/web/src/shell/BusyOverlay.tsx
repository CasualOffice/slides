// Workspace-level "busy" curtain — shown over the slide canvas when an
// open or save is in flight. Stops the user from clicking into a
// half-loaded deck and gives the perceived-progress signal the otherwise
// blank pause was missing. Status pill in the titlebar still carries the
// authoritative message; this is reinforcement, not duplication.

export interface BusyOverlayProps {
  opening?: boolean;
  saving?: boolean;
}

export function BusyOverlay({ opening, saving }: BusyOverlayProps) {
  if (!opening && !saving) return null;
  // TODO(i18n): key under chrome.workspace.* once the W1b string
  // migration sweep reaches App.tsx + the workspace surfaces (the
  // drop-overlay literal next to us still carries the same TODO).
  const label = opening ? 'Opening deck…' : 'Saving deck…';
  return (
    <div
      className="cs-workspace__busy-overlay"
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-testid="busy-overlay"
    >
      <div className="cs-spinner" aria-hidden="true" />
      <span className="cs-workspace__busy-overlay-text">{label}</span>
    </div>
  );
}

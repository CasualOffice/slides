import { useEffect, useState } from 'react';
import type { Univer } from '@univerjs/core';
import { CollabBridge, type BridgeStatus } from './bridge';

// Owns the CollabBridge lifecycle. Reads the `?room=...` URL param and a
// `?collab=...` URL param for the server URL (defaults to ws://127.0.0.1:4173/collab).
// Lets multiple browser tabs join the same room and observe each other's
// slide mutations live.
//
// Build-time gate (`VITE_COLLAB_ENABLED`) — when not 'true', the provider
// ignores `?room=…` entirely. Several editing paths (drag-reorder, theme
// cascade, find-replace, format pane, layout, background, slide context
// moves) still do direct snapshot writes instead of going through the
// command bus (Gap 1.4 in UNIVER_SLIDES_GAPS.md). Enabling collab without
// patching those would silently desync concurrent edits — opt-in only.

export interface CollabState {
  status: BridgeStatus;
  roomId: string | null;
  peers: number;
}

function isCollabEnabled(): boolean {
  // Vite inlines this at build time. Default to disabled so a misconfigured
  // deploy fails closed — explicit opt-in is required to enable the
  // collab-unsafe code paths.
  return import.meta.env.VITE_COLLAB_ENABLED === 'true';
}

// Track whether we've already warned about a `?room=…` URL on a build
// without collab enabled. Module-scoped so multiple `useCollabBridge`
// callers don't all fire the same console line.
let warnedCollabDisabled = false;

const DEFAULT_URL = 'ws://127.0.0.1:4173/collab';

function readUrlParams(): { roomId: string | null; collabUrl: string } {
  if (typeof window === 'undefined') return { roomId: null, collabUrl: DEFAULT_URL };
  const params = new URLSearchParams(window.location.search);
  return {
    roomId: params.get('room')?.trim() || null,
    collabUrl: params.get('collab')?.trim() || DEFAULT_URL,
  };
}

export function useCollabBridge(): CollabState {
  const [state, setState] = useState<CollabState>({ status: 'idle', roomId: null, peers: 0 });

  useEffect(() => {
    const { roomId, collabUrl } = readUrlParams();
    if (!roomId) return;

    if (!isCollabEnabled()) {
      // User landed on a `?room=…` URL but this build was compiled with
      // collab disabled. Warn once so the operator notices in the
      // browser devtools; don't surface in the UI (the chrome stays
      // single-user clean — no "Live" badge, no peer count).
      if (!warnedCollabDisabled) {
        warnedCollabDisabled = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[collab] Ignoring ?room=' + roomId + ' — this build was compiled with ' +
          'VITE_COLLAB_ENABLED!=true. Rebuild with VITE_COLLAB_ENABLED=true to enable ' +
          'real-time editing (and accept that 7 editing paths still bypass the command ' +
          'bus per UNIVER_SLIDES_GAPS.md Gap 1.4).',
        );
      }
      return;
    }

    setState((s) => ({ ...s, roomId }));

    // Wait for window.univer (set by UniverSlide on mount). Poll briefly
    // — Univer mounts within ~500 ms of page load.
    let cancelled = false;
    let retryHandle: number | null = null;
    let bridge: CollabBridge | null = null;

    const tryStart = () => {
      if (cancelled) return;
      retryHandle = null;
      const univer = (window as unknown as { univer?: Univer }).univer;
      if (!univer) {
        retryHandle = window.setTimeout(tryStart, 100);
        return;
      }
      bridge = new CollabBridge(
        univer,
        { url: collabUrl, roomId },
        {
          onStatusChange: (status) => setState((s) => ({ ...s, status })),
          onPeerCount: (peers) => setState((s) => ({ ...s, peers })),
        },
      );
      bridge.start();
      // Expose for e2e probes.
      (window as unknown as { __casualSlides_collab?: CollabBridge }).__casualSlides_collab = bridge;
    };
    tryStart();

    return () => {
      cancelled = true;
      if (retryHandle != null) window.clearTimeout(retryHandle);
      bridge?.stop();
      delete (window as unknown as { __casualSlides_collab?: CollabBridge }).__casualSlides_collab;
    };
  }, []);

  return state;
}

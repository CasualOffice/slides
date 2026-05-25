import { useEffect, useState } from 'react';
import type { Univer } from '@univerjs/core';
import { CollabBridge, type BridgeStatus } from './bridge';

// Owns the CollabBridge lifecycle. Reads the `?room=...` URL param and a
// `?collab=...` URL param for the server URL (defaults to ws://127.0.0.1:4173/collab).
// Lets multiple browser tabs join the same room and observe each other's
// slide mutations live.

export interface CollabState {
  status: BridgeStatus;
  roomId: string | null;
  peers: number;
}

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

    setState((s) => ({ ...s, roomId }));

    // Wait for window.univer (set by UniverSlide on mount). Poll briefly
    // — Univer mounts within ~500 ms of page load.
    let cancelled = false;
    let bridge: CollabBridge | null = null;

    const tryStart = () => {
      if (cancelled) return;
      const univer = (window as unknown as { univer?: Univer }).univer;
      if (!univer) {
        window.setTimeout(tryStart, 100);
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
      bridge?.stop();
      delete (window as unknown as { __casualSlides_collab?: CollabBridge }).__casualSlides_collab;
    };
  }, []);

  return state;
}

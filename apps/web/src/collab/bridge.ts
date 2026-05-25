import type { Univer } from '@univerjs/core';
import { ICommandService } from '@univerjs/core';

// Casual Slides P2 collab bridge — main thread side.
//
// Wire pattern (per docs/RESEARCH.md §3):
//   1. Subscribe to ICommandService.onMutationExecutedForCollab.
//   2. For each fired mutation that did NOT come from a peer
//      (options.fromCollab is false), encode the (id, params) tuple
//      and send via WebSocket.
//   3. On receive, decode and call cs.syncExecuteCommand(id, params,
//      { fromCollab: true }) — the fromCollab flag short-circuits the
//      broadcast in step 2 so we don't echo the same mutation back.
//
// No CRDT today. Wire format is JSON envelopes, server broadcasts
// last-writer-wins. Sufficient for single-active-editor co-editing
// (the common P2 case). Yjs upgrade is P2.1.

export interface CollabConfig {
  url: string;        // ws://host:port/collab
  roomId: string;
}

export interface BridgeEvents {
  onStatusChange?: (status: BridgeStatus) => void;
  onPeerCount?: (n: number) => void;
}

export type BridgeStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

interface WireEnvelope {
  type: 'mutation';
  id: string;
  params: unknown;
}

interface ServerEnvelope {
  type: 'welcome' | 'peer-joined' | 'peer-left' | 'mutation';
  room?: string;
  peers?: number;
  id?: string;
  params?: unknown;
}

export class CollabBridge {
  private ws: WebSocket | null = null;
  private status: BridgeStatus = 'idle';
  private reconnectTimer: number | null = null;
  private univer: Univer;
  private config: CollabConfig;
  private events: BridgeEvents;
  private hookDispose: { dispose(): void } | null = null;

  constructor(univer: Univer, config: CollabConfig, events: BridgeEvents = {}) {
    this.univer = univer;
    this.config = config;
    this.events = events;
  }

  start() {
    this.subscribeMutations();
    this.connect();
  }

  stop() {
    this.hookDispose?.dispose();
    this.hookDispose = null;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, 'bridge stopped');
    this.ws = null;
    this.setStatus('idle');
  }

  private setStatus(s: BridgeStatus) {
    if (this.status === s) return;
    this.status = s;
    this.events.onStatusChange?.(s);
  }

  private subscribeMutations() {
    const cs = this.univer.__getInjector().get(ICommandService);
    this.hookDispose = cs.onMutationExecutedForCollab((info, options) => {
      // Don't re-broadcast mutations that arrived from a peer or that are
      // marked local-only. This is the echo-loop guard.
      if (options?.fromCollab || options?.onlyLocal) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const env: WireEnvelope = { type: 'mutation', id: info.id, params: info.params };
      try {
        this.ws.send(JSON.stringify(env));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[collab] send failed:', err);
      }
    });
  }

  private connect() {
    this.setStatus('connecting');
    const url = `${this.config.url}?room=${encodeURIComponent(this.config.roomId)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[collab] connect failed:', err);
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus('live');
    };

    ws.onmessage = (e) => {
      let env: ServerEnvelope;
      try {
        env = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      switch (env.type) {
        case 'welcome':
        case 'peer-joined':
        case 'peer-left':
          if (typeof env.peers === 'number') this.events.onPeerCount?.(env.peers);
          break;
        case 'mutation':
          this.applyRemoteMutation(env.id ?? '', env.params);
          break;
        default:
      }
    };

    ws.onerror = () => {
      // Don't log every error — the onclose handler will fire next and
      // schedule a reconnect.
    };

    ws.onclose = () => {
      this.ws = null;
      // Clean stop (1000) shouldn't reconnect; everything else should.
      if (this.status === 'idle') return;
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    };
  }

  private applyRemoteMutation(id: string, params: unknown) {
    if (!id) return;
    const cs = this.univer.__getInjector().get(ICommandService);
    try {
      cs.syncExecuteCommand(id, params as Record<string, unknown> | undefined, { fromCollab: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[collab] apply ${id} failed:`, err);
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    // Fixed 1500 ms reconnect cadence; bound for the spike. Production
    // wants exponential backoff with jitter.
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status !== 'idle') this.connect();
    }, 1500);
  }
}

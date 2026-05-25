import { createServer } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

// Minimal viable collab relay for Casual Slides P2.
//
// Architecture: rooms keyed by `?room=<id>` in the WebSocket URL. Every
// client connected to a room receives every mutation message any other
// client in the same room sends. The server is intentionally dumb —
// CRDT-correctness is "good enough for one editor at a time" because the
// CollabBridge uses Univer's command id + params as the wire format and
// applies via syncExecuteCommand({ fromCollab: true }) which short-circuits
// the echo loop.
//
// Real Yjs/CRDT lands when concurrent-edit conflicts surface (P2.1). The
// upgrade path is: replace the broadcast in this file with a Y.Doc
// state-vector exchange + delta gossip. The bridge keeps its hook
// (ICommandService.onMutationExecutedForCollab) — only the wire format
// changes.
//
// No persistence, no auth, no presence. Single-node, in-memory.

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? '127.0.0.1';

interface RoomEntry {
  clients: Set<WebSocket>;
}

const rooms = new Map<string, RoomEntry>();

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, ts: Date.now() }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Casual Slides collab relay');
});

const wss = new WebSocketServer({ server: http, path: '/collab' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room')?.trim();
  if (!roomId) {
    ws.close(4400, 'missing room');
    return;
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = { clients: new Set() };
    rooms.set(roomId, room);
  }
  room.clients.add(ws);

  // Welcome envelope — tells the client how many peers were here before
  // it joined. Useful for "you're alone" UX.
  ws.send(JSON.stringify({ type: 'welcome', room: roomId, peers: room.clients.size - 1 }));

  // Tell every other client in the room.
  for (const peer of room.clients) {
    if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;
    peer.send(JSON.stringify({ type: 'peer-joined', room: roomId, peers: room.clients.size }));
  }

  ws.on('message', (data) => {
    // Treat everything as opaque JSON-encoded mutation envelopes and
    // broadcast to other clients in the same room. The bridge does the
    // shape validation on its end.
    const payload = data.toString();
    for (const peer of room.clients) {
      if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;
      peer.send(payload);
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      rooms.delete(roomId);
      // eslint-disable-next-line no-console
      console.log(`[collab] room ${roomId} drained`);
    } else {
      for (const peer of room.clients) {
        if (peer.readyState !== WebSocket.OPEN) continue;
        peer.send(JSON.stringify({ type: 'peer-left', room: roomId, peers: room.clients.size }));
      }
    }
  });

  ws.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.warn(`[collab] socket error in room ${roomId}:`, err.message);
  });
});

http.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[collab] listening on ws://${HOST}:${PORT}/collab`);
});

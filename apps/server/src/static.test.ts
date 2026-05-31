import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createStaticHandler } from './static';

// Tests for the framework-free static-file handler. Each spec spins up a
// fresh temp dir as STATIC_DIR, populates it with a handful of fixture
// files, then drives the handler through the same shape Node's
// `http.Server` would (a plain object satisfying enough of
// IncomingMessage / ServerResponse).

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

function makeReq(url: string): IncomingMessage {
  // The handler only reads `req.url`; nothing else from IncomingMessage.
  return { url } as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  let resolve!: (r: CapturedResponse) => void;
  const done = new Promise<CapturedResponse>((r) => (resolve = r));

  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  let statusCode = 0;

  // Minimal subset of ServerResponse the handler touches:
  //   res.writeHead(status, headers) and res.pipe-target (via .write/.end).
  // `createReadStream(...).pipe(res)` calls res.write() + res.end().
  const res = {
    writeHead(code: number, hdrs: Record<string, string>) {
      statusCode = code;
      for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = String(v);
    },
    on(_event: string, _cb: () => void) {
      // pipe() registers an 'unpipe' handler; we don't care.
    },
    once(_event: string, _cb: () => void) {},
    emit(_event: string, ..._args: unknown[]) {},
    write(chunk: Buffer | string) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      resolve({ statusCode, headers, body: Buffer.concat(chunks) });
    },
  } as unknown as ServerResponse;

  return { res, done };
}

let staticDir: string;

function writeIndex(content = '<!doctype html><title>root</title>'): void {
  writeFileSync(path.join(staticDir, 'index.html'), content);
}

function writeAsset(rel: string, content: string | Buffer): void {
  const abs = path.join(staticDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  staticDir = mkdtempSync(path.join(tmpdir(), 'cs-static-'));
});

afterEach(() => {
  rmSync(staticDir, { recursive: true, force: true });
});

describe('createStaticHandler — boot-time gate', () => {
  test('returns false on every request when staticDir lacks index.html', async () => {
    // Empty dir, no index.html. The handler should refuse to serve
    // anything so the caller (apps/server/src/index.ts) can fall
    // through to its legacy "Casual Slides collab relay" identity page.
    const handle = createStaticHandler({ staticDir });
    const { res } = makeRes();
    const result = handle(makeReq('/'), res);
    expect(result).toBe(false);
  });

  test('returns false when req.url is missing', async () => {
    writeIndex();
    const handle = createStaticHandler({ staticDir });
    const { res } = makeRes();
    const result = handle({ } as unknown as IncomingMessage, res);
    expect(result).toBe(false);
  });
});

describe('createStaticHandler — happy path', () => {
  test('serves index.html for `/`', async () => {
    writeIndex('<!doctype html><title>hello</title>');
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    const result = handle(makeReq('/'), res);
    const captured = await done;
    expect(result).toBe(true);
    expect(captured.statusCode).toBe(200);
    expect(captured.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(captured.body.toString()).toContain('<title>hello</title>');
  });

  test('serves a top-level file with the right MIME', async () => {
    writeIndex();
    writeAsset('robots.txt', 'User-agent: *\n');
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    handle(makeReq('/robots.txt'), res);
    const captured = await done;
    expect(captured.statusCode).toBe(200);
    expect(captured.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(captured.body.toString()).toBe('User-agent: *\n');
  });

  test('serves a binary asset with the right MIME', async () => {
    writeIndex();
    // 8-byte PNG signature is enough to verify byte fidelity.
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeAsset('logo.png', pngHeader);
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    handle(makeReq('/logo.png'), res);
    const captured = await done;
    expect(captured.headers['content-type']).toBe('image/png');
    expect(captured.body.equals(pngHeader)).toBe(true);
  });

  test('unknown extension → application/octet-stream', async () => {
    writeIndex();
    writeAsset('strange.xyz', 'opaque');
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    handle(makeReq('/strange.xyz'), res);
    const captured = await done;
    expect(captured.headers['content-type']).toBe('application/octet-stream');
  });
});

describe('createStaticHandler — cache headers', () => {
  test('hashed /assets/* gets immutable cache', async () => {
    writeIndex();
    writeAsset('assets/index-abc123.js', 'console.log(1)');
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    handle(makeReq('/assets/index-abc123.js'), res);
    const captured = await done;
    expect(captured.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(captured.headers['content-type']).toBe('application/javascript; charset=utf-8');
  });

  test('non-asset files get no-cache so redeploys take effect', async () => {
    writeIndex();
    writeAsset('sitemap.xml', '<urlset/>');
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    handle(makeReq('/sitemap.xml'), res);
    const captured = await done;
    expect(captured.headers['cache-control']).toBe('no-cache');
  });

  test('index.html itself gets no-cache (must revalidate)', async () => {
    writeIndex();
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    handle(makeReq('/'), res);
    const captured = await done;
    expect(captured.headers['cache-control']).toBe('no-cache');
  });

  test('every response carries x-content-type-options: nosniff', async () => {
    writeIndex();
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    handle(makeReq('/'), res);
    const captured = await done;
    expect(captured.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('createStaticHandler — SPA fallback', () => {
  test('unknown route falls back to index.html', async () => {
    writeIndex('<!doctype html><title>spa root</title>');
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    handle(makeReq('/totally/made/up/route'), res);
    const captured = await done;
    expect(captured.statusCode).toBe(200);
    expect(captured.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(captured.body.toString()).toContain('<title>spa root</title>');
  });

  test('query strings and fragments are stripped before fs lookup', async () => {
    writeIndex();
    writeAsset('robots.txt', 'OK');
    const handle = createStaticHandler({ staticDir });
    const { res, done } = makeRes();
    handle(makeReq('/robots.txt?cache=bust'), res);
    const captured = await done;
    expect(captured.body.toString()).toBe('OK');
  });
});

describe('createStaticHandler — safeJoin path-traversal defence', () => {
  test('`../` escape attempts fall back to index.html, never escape the root', async () => {
    writeIndex('<!doctype html><title>fallback</title>');
    // Plant a file OUTSIDE staticDir that a successful traversal would
    // reach. The test passes only if we serve index.html, NOT this file.
    const outsider = path.join(staticDir, '..', 'OUTSIDE.txt');
    writeFileSync(outsider, 'SHOULD NEVER REACH THIS');

    try {
      const handle = createStaticHandler({ staticDir });
      const { res, done } = makeRes();
      handle(makeReq('/../OUTSIDE.txt'), res);
      const captured = await done;
      expect(captured.body.toString()).toContain('<title>fallback</title>');
      expect(captured.body.toString()).not.toContain('SHOULD NEVER REACH');
    } finally {
      rmSync(outsider, { force: true });
    }
  });

  test('percent-encoded `..` is also blocked', async () => {
    writeIndex('<!doctype html><title>fallback</title>');
    const outsider = path.join(staticDir, '..', 'OUTSIDE2.txt');
    writeFileSync(outsider, 'SHOULD NEVER REACH THIS');

    try {
      const handle = createStaticHandler({ staticDir });
      const { res, done } = makeRes();
      handle(makeReq('/%2E%2E/OUTSIDE2.txt'), res);
      const captured = await done;
      expect(captured.body.toString()).toContain('<title>fallback</title>');
      expect(captured.body.toString()).not.toContain('SHOULD NEVER REACH');
    } finally {
      rmSync(outsider, { force: true });
    }
  });
});

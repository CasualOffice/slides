import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Tiny static-file handler. Serves the built web bundle from STATIC_DIR
// (set via env) so the single image hosts both the editor and the
// /collab WebSocket. Intentionally framework-free — Fastify + plugins
// would bring real DX wins but the server is 100 lines today and
// staying minimal until we adopt sheet's persistence layer.
//
// Routing contract (callers decide what reaches us):
//   - Match a file under STATIC_DIR? → stream it with the right MIME.
//   - No match? → fall back to index.html (SPA-style).
//   - No STATIC_DIR or no index.html? → 404 with a plain message.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function safeJoin(root: string, urlPath: string): string | null {
  // Strip query + hash, decode percent-escapes, and normalise to defend
  // against `..` traversal. If the resolved path escapes `root`, we
  // refuse — only files genuinely inside the static dir are reachable.
  // `split('?')[0]` and `split('#')[0]` are always inhabited (the first
  // segment of any split is the input when no delimiter is found).
  const pathOnly = decodeURIComponent(urlPath.split('?')[0]!.split('#')[0]!);
  const joined = resolve(join(root, normalize(pathOnly)));
  const rootResolved = resolve(root);
  if (joined !== rootResolved && !joined.startsWith(rootResolved + sep)) {
    return null;
  }
  return joined;
}

function isFile(absPath: string): boolean {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function cacheHeaderFor(absPath: string): string {
  // Vite emits hashed asset filenames under /assets/* — those are
  // content-addressed so we can cache them forever. Everything else
  // (index.html, robots.txt, sitemap.xml) must revalidate on every
  // request or a redeploy won't take effect until the user hard-refreshes.
  if (absPath.includes(`${sep}assets${sep}`)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function send(res: ServerResponse, absPath: string): void {
  const ext = extname(absPath).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': cacheHeaderFor(absPath),
    // Lightweight defaults — the embedding setup (reverse proxy, CDN)
    // can layer stricter CSP / HSTS on top.
    'x-content-type-options': 'nosniff',
  });
  createReadStream(absPath).pipe(res);
}

export interface StaticHandlerOptions {
  staticDir: string;
}

export function createStaticHandler({ staticDir }: StaticHandlerOptions) {
  const indexHtml = join(staticDir, 'index.html');
  const hasIndex = isFile(indexHtml);

  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (!req.url) return false;
    if (!hasIndex) return false;

    // Root → serve index.html.
    const urlPath = req.url === '/' ? '/index.html' : req.url;

    const abs = safeJoin(staticDir, urlPath);
    if (abs && isFile(abs)) {
      send(res, abs);
      return true;
    }

    // SPA fallback — anything not matching a real file falls back to
    // index.html so client-side routing (today: none, but room URLs
    // still need to land on the app) keeps working.
    send(res, indexHtml);
    return true;
  };
}

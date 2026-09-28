import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { BrainDb } from '../db/connection.js';
import type { Embedder } from '../services/embedder.js';
import type { WorkerControl } from '../workers/manager.js';
import type { ChangeFeed } from './change-feed.js';
import { handleApi, needsYou } from './api.js';

export interface UiServerOptions {
  db: BrainDb; workers: WorkerControl; feed?: ChangeFeed; embedder: () => Embedder;
  port: number; webRoot: string; defaultCwd: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

export async function startUiServer(opts: UiServerOptions) {
  const clients = new Set<http.ServerResponse>();
  let port = opts.port;
  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const announce = (goalId: string) => {
    broadcast('goal-changed', { goalId });
    broadcast('needs-you', { count: needsYou(opts.db).count });
  };
  opts.feed?.on('goal-changed', (goalId: string) => announce(goalId));

  const server = http.createServer(async (req, res) => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(String(req.headers.host))) { res.writeHead(403).end('Forbidden host'); return; }
    if (req.method !== 'GET') {
      const origins = allowedHosts.map(h => `http://${h}`);
      if (!origins.includes(String(req.headers.origin))) { res.writeHead(403).end('Forbidden origin'); return; }
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: needs-you\ndata: ${JSON.stringify({ count: needsYou(opts.db).count })}\n\n`);
      clients.add(res);
      const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
      return;
    }
    if (await handleApi({ db: opts.db, workers: opts.workers, embedder: opts.embedder, defaultCwd: opts.defaultCwd, announce }, req, res, url)) return;
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.resolve(opts.webRoot, rel);
    if (!file.startsWith(path.resolve(opts.webRoot) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('Not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    broadcast,
    announce,
    close: () => new Promise<void>(resolve => {
      for (const c of clients) c.end();
      server.close(() => resolve());
    }),
  };
}

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrainDb } from '../db/connection.js';
import type { Embedder } from '../services/embedder.js';
import type { WorkerControl } from '../workers/manager.js';
import type { ChangeFeed } from './change-feed.js';
import { handleApi, needsYou } from './api.js';
import { normaliseIp } from './config.js';

export interface UiServerOptions {
  db: BrainDb; workers: WorkerControl; feed?: ChangeFeed; embedder: () => Embedder;
  port: number; webRoot: string; defaultCwd: string;
  /** LAN address to listen on as well as 127.0.0.1 (phase 1: the Mac's fixed IP); null = localhost only. */
  host?: string | null;
  /** Source IPs allowed to connect; every other peer gets 403. Defaults to 127.0.0.1 only. */
  allowIps?: string[];
  /** Local interface addresses (injectable for tests). */
  interfaces?: () => string[];
  /** How often to re-check whether the LAN address is present (ms). */
  recheckMs?: number;
  log?: (msg: string) => void;
  /** Peer address of a request (injectable for tests, which cannot bind arbitrary source IPs). */
  remoteAddressOf?: (req: http.IncomingMessage) => string | undefined;
}

const REFUSAL_LOG_MS = 60_000;

function localAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flat().filter(Boolean).map(i => i!.address);
}

const hostPort = (host: string, port: number) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);

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

  const log = opts.log ?? ((m: string) => console.error(`[brain ui] ${m}`));
  const allowIps = new Set((opts.allowIps ?? ['127.0.0.1']).map(normaliseIp));
  allowIps.add('127.0.0.1');
  const lanHost = opts.host ?? null;
  const lastRefusal = new Map<string, number>();

  // Guard order: source IP (LAN safeguard), Host (DNS rebinding), Origin on writes (cross-site requests).
  const handler: http.RequestListener = async (req, res) => {
    const peer = normaliseIp((opts.remoteAddressOf ?? (r => r.socket.remoteAddress))(req));
    if (!allowIps.has(peer)) {
      const now = Date.now();
      if (now - (lastRefusal.get(peer) ?? 0) >= REFUSAL_LOG_MS) {
        lastRefusal.set(peer, now);
        log(`refused ${peer || 'unknown'} ${req.method} ${req.url}`);
      }
      res.writeHead(403).end('Forbidden source'); return;
    }
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...(lanHost ? [hostPort(lanHost, port)] : [])];
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
  };

  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;

  // The LAN listener follows the address: up while it exists locally, down (localhost only) while it does not.
  // Never 0.0.0.0 — off the home network the UI must not listen on whatever network the Mac is on.
  let lan: http.Server | null = null;
  let lanState: 'up' | 'absent' | 'error' | null = null;
  const setLanState = (state: 'up' | 'absent' | 'error', msg: string) => { if (lanState !== state) log(msg); lanState = state; };
  const syncLan = () => {
    if (!lanHost) return;
    const present = (opts.interfaces ?? localAddresses)().includes(lanHost);
    if (present && !lan) {
      const s = http.createServer(handler);
      lan = s;
      s.once('error', (e) => { lan = null; s.close(); setLanState('error', `LAN listener on ${hostPort(lanHost, port)} failed: ${(e as Error).message}`); });
      s.listen(port, lanHost, () => setLanState('up', `LAN listener up on http://${hostPort(lanHost, port)}`));
    } else if (!present) {
      if (lan) { lan.close(); lan = null; }
      setLanState('absent', `LAN address ${lanHost} not present; serving localhost only`);
    }
  };
  syncLan();
  const recheck = lanHost ? setInterval(syncLan, opts.recheckMs ?? 30_000) : null;
  recheck?.unref();

  return {
    url: `http://127.0.0.1:${port}`,
    lanUrl: () => (lan?.listening && lanHost ? `http://${hostPort(lanHost, port)}` : null),
    port,
    broadcast,
    announce,
    close: () => new Promise<void>(resolve => {
      if (recheck) clearInterval(recheck);
      for (const c of clients) c.end();
      const l = lan; lan = null;
      l?.close();
      server.close(() => resolve());
    }),
  };
}

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers.js';
import { fakeEmbedder } from '../src/services/embedder.js';
import { startUiServer } from '../src/web/server.js';
import { normaliseIp, resolveUiConfig, UI_DEFAULTS } from '../src/web/config.js';
import type { WorkerControl } from '../src/workers/manager.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

const noWorkers = {
  start: () => ({}), stop: () => ({}), resume: () => ({}), answersUpdated: () => {}, decide: () => ({}), stopAll: () => {},
} as unknown as WorkerControl;

async function boot(opts: { host?: string | null; allowIps?: string[]; interfaces?: () => string[]; recheckMs?: number } = {}) {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<title>Central Brain</title>');
  const logs: string[] = [];
  const s = await startUiServer({
    db: createTestDb(), workers: noWorkers, embedder: () => fakeEmbedder(), port: 0, webRoot, defaultCwd: '/tmp',
    host: opts.host ?? null, allowIps: opts.allowIps ?? ['127.0.0.1'],
    interfaces: opts.interfaces, recheckMs: opts.recheckMs, log: m => logs.push(m),
    // Tests cannot bind arbitrary source IPs, so they declare one per request.
    remoteAddressOf: req => String(req.headers['x-test-remote'] ?? req.socket.remoteAddress),
  });
  closers.push(s.close);
  const get = (p: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, path: p, headers: { host: `127.0.0.1:${s.port}`, ...headers } },
      res => { res.resume(); resolve(res.statusCode!); });
    r.on('error', reject); r.end();
  });
  return { s, logs, get };
}

describe('ui config', () => {
  it('defaults to the phase-1 network and always keeps 127.0.0.1', () => {
    expect(resolveUiConfig({}, {})).toEqual(UI_DEFAULTS);
    expect(resolveUiConfig({ allowIp: ['192.168.70.9'] }, {}).allowIps).toEqual(['127.0.0.1', '192.168.70.9']);
    expect(resolveUiConfig({}, { BRAIN_UI_ALLOW_IPS: '10.0.0.1, 10.0.0.2' }).allowIps).toEqual(['127.0.0.1', '10.0.0.1', '10.0.0.2']);
    expect(resolveUiConfig({ host: 'none' }, {}).host).toBeNull();
    expect(resolveUiConfig({}, { BRAIN_UI_PORT: '5000' }).port).toBe(5000);
  });

  it('normalises IPv4-mapped IPv6 addresses', () => {
    expect(normaliseIp('::ffff:192.168.70.122')).toBe('192.168.70.122');
    expect(normaliseIp('::1')).toBe('::1');
    expect(normaliseIp(undefined)).toBe('');
  });
});

describe('source-IP safeguard (criterion 236)', () => {
  it('serves allowlisted sources and refuses others with 403 and one log line per IP', async () => {
    const { get, logs } = await boot({ allowIps: ['127.0.0.1', '192.168.70.122'] });
    expect(await get('/')).toBe(200);
    expect(await get('/', { 'x-test-remote': '::ffff:192.168.70.122' })).toBe(200);
    expect(await get('/api/goals', { 'x-test-remote': '192.168.70.7' })).toBe(403);
    expect(await get('/api/goals', { 'x-test-remote': '192.168.70.7' })).toBe(403);
    expect(logs.filter(l => l.includes('refused 192.168.70.7'))).toHaveLength(1);
  });

  it('accepts the LAN host in the Host header and still refuses foreign hosts', async () => {
    const { s, get } = await boot({ host: '192.0.2.99', interfaces: () => ['127.0.0.1'] });
    expect(await get('/', { host: `192.0.2.99:${s.port}` })).toBe(200);
    expect(await get('/', { host: `evil.example:${s.port}` })).toBe(403);
  });
});

describe('LAN listener lifecycle (criterion 237)', () => {
  it('stays up on localhost only, and logs it, when the LAN address is absent', async () => {
    const { s, logs, get } = await boot({ host: '192.0.2.99', interfaces: () => ['127.0.0.1'] });
    expect(s.lanUrl()).toBeNull();
    expect(logs).toContain('LAN address 192.0.2.99 not present; serving localhost only');
    expect(await get('/api/goals')).toBe(200);
  });

  it('starts the LAN listener once the address appears', async () => {
    let present = false;
    const { s, logs } = await boot({ host: '::1', interfaces: () => (present ? ['127.0.0.1', '::1'] : ['127.0.0.1']), recheckMs: 20 });
    expect(s.lanUrl()).toBeNull();
    present = true;
    await new Promise(r => setTimeout(r, 120));
    expect(s.lanUrl()).toBe(`http://[::1]:${s.port}`);
    expect(logs.some(l => l.startsWith('LAN listener up'))).toBe(true);
  });
});

describe('launchd agent (criterion 239, dry run)', () => {
  it('install-agent --dry-run prints a valid plist running brain ui under caffeinate -s with KeepAlive', async () => {
    const { execFileSync } = await import('node:child_process');
    const plist = execFileSync('npx', ['tsx', 'src/cli/index.ts', 'ui', 'install-agent', '--dry-run', '--allow-ip', '192.168.70.122'],
      { encoding: 'utf8' });
    expect(plist).toContain('<string>/usr/bin/caffeinate</string>\n    <string>-s</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toMatch(/<string>\/[^<]*\/dist\/cli\/index\.js<\/string>/);
    expect(plist).toContain('<string>192.168.70.122</string>');
    expect(plist).toContain('<key>PATH</key>');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-plist-')), 'a.plist');
    fs.writeFileSync(file, plist);
    if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', file]);
  });
});

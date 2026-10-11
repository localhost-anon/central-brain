import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers.js';
import { createGoal, completeGoal } from '../src/services/goals.js';
import { addProject } from '../src/services/projects.js';
import { createRun, updateRun } from '../src/services/workers.js';
import { setGoalProject } from '../src/services/goal-project.js';
import { ChangeFeed } from '../src/web/change-feed.js';
import { Notifier, loadNtfyConfig, ntfySender, type Push } from '../src/web/notifier.js';

const UI = 'http://100.92.71.97:4410';

function setup() {
  const db = createTestDb();
  const sent: Push[] = [];
  const logs: string[] = [];
  const make = (send = async (p: Push) => { sent.push(p); }) => new Notifier(db, send, UI, m => logs.push(m));
  return { db, sent, logs, make };
}

describe('Notifier (criteria 269, 274)', () => {
  it('sends one push per transition, with title, priority and a click link to the goal', async () => {
    const { db, sent, make } = setup();
    addProject(db, { name: 'market', rootPath: '/x/market' });
    const g = createGoal(db, { title: 'Weekly card — v2', objective: 'secret objective /Users/x/path' });
    setGoalProject(db, g.id, 'market');
    const n = make();
    const run = createRun(db, { goalId: g.id, cwd: '/x/market' });
    updateRun(db, run.id, { status: 'working' });
    expect(n.check()).toEqual([]);

    updateRun(db, run.id, { status: 'waiting_answers' });
    n.check();
    expect(n.check()).toEqual([]); // no repeat while the state stays the same
    updateRun(db, run.id, { status: 'working' }); n.check();
    updateRun(db, run.id, { status: 'waiting_approval' }); n.check();
    updateRun(db, run.id, { status: 'completed' }); n.check();
    const run2 = createRun(db, { goalId: g.id, cwd: '/x/market' });
    updateRun(db, run2.id, { status: 'failed' }); n.check();
    completeGoal(db, g.id, { force: true, reason: 'test' }); n.check();
    await Promise.resolve();

    expect(sent.map(p => [p.message, p.priority])).toEqual([
      ['Questions wait for your answers', 4],
      ['An approval waits for you', 4],
      ['Worker finished', 3],
      ['Worker failed', 4],
      ['Goal completed', 3],
    ]);
    for (const p of sent) {
      expect(p.title).toBe('market: Weekly card — v2');
      expect(p.click).toBe(`${UI}/#/goal/${g.id}`);
      // Content holds only project, title and reason (criterion 274).
      expect(Object.keys(p).sort()).toEqual(['click', 'message', 'priority', 'tags', 'title']);
      expect(JSON.stringify(p)).not.toMatch(/secret|\/Users/);
    }
  });

  it('a stopped worker sends nothing; a goal with no project uses the bare title', async () => {
    const { db, sent, make } = setup();
    const g = createGoal(db, { title: 'Loose goal', objective: 'o' });
    const n = make();
    const run = createRun(db, { goalId: g.id, cwd: '/tmp' });
    updateRun(db, run.id, { status: 'stopped' }); n.check();
    updateRun(db, run.id, { status: 'waiting_answers' }); n.check();
    await Promise.resolve();
    expect(sent.map(p => [p.title, p.message])).toEqual([['Loose goal', 'Questions wait for your answers']]);
  });
});

describe('startup snapshot (criterion 270)', () => {
  it('goals already waiting, finished, failed or completed send nothing when the notifier starts', async () => {
    const { db, sent, make } = setup();
    for (const status of ['waiting_answers', 'waiting_approval', 'completed', 'failed'] as const) {
      const g = createGoal(db, { title: status, objective: 'o' });
      updateRun(db, createRun(db, { goalId: g.id, cwd: '/tmp' }).id, { status });
    }
    const done = createGoal(db, { title: 'done', objective: 'o' });
    completeGoal(db, done.id, { force: true, reason: 'test' });
    const n = make();
    expect(n.check()).toEqual([]);
    await Promise.resolve();
    expect(sent).toEqual([]);
  });
});

describe('failures (criterion 271)', () => {
  it('a failing send is logged once per push and never throws', async () => {
    const { db, logs, make } = setup();
    const g = createGoal(db, { title: 'G', objective: 'o' });
    const n = make(async () => { throw new Error('connect ECONNREFUSED 100.95.99.70:2586'); });
    updateRun(db, createRun(db, { goalId: g.id, cwd: '/tmp' }).id, { status: 'waiting_answers' });
    expect(() => n.check()).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(logs).toEqual([`push failed for ${g.id}: connect ECONNREFUSED 100.95.99.70:2586`]);
  });

  it('ntfySender throws on an HTTP error and posts JSON with the bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: calls.length === 1 ? 200 : 403 });
    }) as unknown as typeof fetch;
    const send = ntfySender({ url: 'http://h:2586', topic: 'brain', token: 'tk_x', uiUrl: UI }, fake);
    const push: Push = { title: 'T ✓', message: 'm', priority: 3, tags: [], click: 'c' };
    await send(push);
    await expect(send(push)).rejects.toThrow('ntfy answered HTTP 403');
    expect(calls[0]!.url).toBe('http://h:2586');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tk_x');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ topic: 'brain', ...push });
  });

  it('a read error inside the feed handler is logged, not thrown', async () => {
    const { db, logs, make } = setup();
    const n = make();
    const feed = new ChangeFeed(db);
    n.attach(feed);
    (n as unknown as { read: () => never }).read = () => { throw new Error('SQLITE_BUSY'); };
    feed.emit('goal-changed', 'x');
    feed.emit('goal-changed', 'y');
    await Promise.resolve();
    expect(logs).toEqual(['notifier check failed: SQLITE_BUSY']); // one check per poll, not per goal
  });
});

describe('config (criterion 272)', () => {
  it('no file means notifier off; a file missing a field throws; a full file loads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ntfy-'));
    expect(loadNtfyConfig(path.join(dir, 'none.json'))).toBeNull();
    const f = path.join(dir, 'ntfy.json');
    fs.writeFileSync(f, JSON.stringify({ url: 'http://h:2586/', topic: 'brain', uiUrl: UI }));
    expect(() => loadNtfyConfig(f)).toThrow('"token" is missing');
    fs.writeFileSync(f, JSON.stringify({ url: 'http://h:2586/', topic: 'brain', token: 'tk', uiUrl: `${UI}/` }));
    expect(loadNtfyConfig(f)).toEqual({ url: 'http://h:2586', topic: 'brain', token: 'tk', uiUrl: UI });
  });

  it('brain ui starts and logs "notifier off" when the config file is absent', async () => {
    const { spawn } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ui-'));
    const child = spawn(process.execPath, [
      path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), path.join(process.cwd(), 'src/cli/index.ts'),
      'ui', '--host', 'none', '--port', '0', '--no-open',
    ], { env: { ...process.env, BRAIN_DB: path.join(dir, 'b.db'), HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout: ${out}`)), 30000);
        const tick = setInterval(() => { if (/notifier off/.test(out) && /"url"/.test(out)) { clearTimeout(t); clearInterval(tick); resolve(); } }, 100);
      });
    } finally { child.kill('SIGTERM'); }
    expect(out).toMatch(/notifier off: no .*ntfy\.json/);
  }, 40000);
});

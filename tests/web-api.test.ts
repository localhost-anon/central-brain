import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers.js';
import { fakeEmbedder } from '../src/services/embedder.js';
import { addProject } from '../src/services/projects.js';
import { createGoal } from '../src/services/goals.js';
import { listQuestions, addQuestion, answerQuestion, dismissQuestion } from '../src/services/questions.js';
import { createRun, createPermissionApproval } from '../src/services/workers.js';
import { startUiServer } from '../src/web/server.js';
import { goalProject, setGoalProject } from '../src/services/goal-project.js';
import type { WorkerControl } from '../src/workers/manager.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

function stubWorkers() {
  const calls: unknown[][] = [];
  const w: WorkerControl = {
    start: (...a) => { calls.push(['start', ...a]); return { id: 'RUN-x', status: 'queued' } as never; },
    stop: (...a) => { calls.push(['stop', ...a]); return {} as never; },
    resume: (...a) => { calls.push(['resume', ...a]); return {} as never; },
    answersUpdated: (...a) => { calls.push(['answersUpdated', ...a]); },
    decide: (...a) => { calls.push(['decide', ...a]); return { id: a[0], status: 'approved' } as never; },
    stopAll: () => { calls.push(['stopAll']); },
  };
  return { w, calls };
}

async function boot(tweak?: (w: WorkerControl) => void) {
  const db = createTestDb();
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<title>Central Brain</title>');
  fs.writeFileSync(path.join(webRoot, 'app.js'), 'console.log(1)');
  const { w, calls } = stubWorkers();
  tweak?.(w);
  const s = await startUiServer({ db, workers: w, embedder: () => fakeEmbedder(), port: 0, webRoot, defaultCwd: '/tmp/projects' });
  closers.push(s.close);
  const origin = `http://127.0.0.1:${s.port}`;
  const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: any; text: string; type: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers: {
        host: `127.0.0.1:${s.port}`, ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...headers,
      } }, res => {
        let t = ''; res.on('data', c => (t += c)); res.on('end', () => {
          let json: any = null; try { json = JSON.parse(t); } catch { /* not json */ }
          resolve({ status: res.statusCode!, json, text: t, type: String(res.headers['content-type']) });
        });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
  return { db, s, calls, req, origin };
}

describe('web API', () => {
  it('serves the static UI and refuses path traversal', async () => {
    const { req } = await boot();
    expect((await req('GET', '/')).text).toContain('Central Brain');
    expect((await req('GET', '/app.js')).type).toContain('javascript');
    expect((await req('GET', '/../package.json')).status).toBe(404);
  });

  it('rejects foreign Host (DNS rebinding) and foreign Origin on writes', async () => {
    const { req } = await boot();
    expect((await req('GET', '/api/goals', undefined, { host: 'evil.example:80' })).status).toBe(403);
    expect((await req('POST', '/api/goals', { title: 't', objective: 'o' }, { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('creates a goal: intake runs, worker starts in the chosen project', async () => {
    const { db, req, calls } = await boot();
    const p = addProject(db, { name: 'KidTube', rootPath: '/Users/x/kidtube' });
    const r = await req('POST', '/api/goals', { title: 'Resume videos', objective: 'Resume where left off', projectId: p.id, startWorker: true });
    expect(r.status).toBe(201);
    expect(r.json.goal.id).toMatch(/^GOAL-/);
    expect(listQuestions(db, r.json.goal.id).map(q => q.checkKey)).toContain('review:behaviour');
    expect(calls).toContainEqual(['start', r.json.goal.id, { cwd: '/Users/x/kidtube' }]);
    expect((await req('POST', '/api/goals', { title: ' ', objective: 'o' })).status).toBe(400);
  });

  it('worker launch failure still creates the goal once and reports workerError', async () => {
    const { req } = await boot(w => { w.start = () => { throw new Error('claude not found'); }; });
    const r = await req('POST', '/api/goals', { title: 'Solo', objective: 'o', startWorker: true });
    expect(r.status).toBe(201);
    expect(r.json.workerError).toBe('claude not found');
    expect(r.json.run).toBeNull();
    const list = (await req('GET', '/api/goals')).json;
    expect(list.filter((x: any) => x.id === r.json.goal.id)).toHaveLength(1);
  });

  it('lists goals with counts, returns detail with timeline, 404s unknown ids (Review Focus 4)', async () => {
    const { db, req } = await boot();
    const g = createGoal(db, { title: 'Alpha', objective: 'first' });
    const list = await req('GET', '/api/goals');
    expect(list.json.find((x: any) => x.id === g.id)).toMatchObject({ title: 'Alpha', status: 'DRAFT', openQuestions: 0, criteria: { passed: 0, total: 0 } });
    const d = await req('GET', `/api/goals/${g.id}`);
    expect(d.json.goal.id).toBe(g.id);
    expect(d.json.timeline.some((t: any) => t.kind === 'goal' && t.text.includes('created'))).toBe(true);
    expect((await req('GET', '/api/goals/nope')).status).toBe(404);
    expect((await req('GET', '/api/goals/%E0%A4%A')).status).toBe(404);
  });

  it('puts each answer on its question in the timeline, with no separate answer item', async () => {
    const { db, req } = await boot();
    const g = createGoal(db, { title: 'Q', objective: 'o' });
    const a = addQuestion(db, g.id, { question: 'Which colour?' });
    const b = addQuestion(db, g.id, { question: 'Which size?' });
    const c = addQuestion(db, g.id, { question: 'Which font?' });
    answerQuestion(db, a.id, 'Blue');
    dismissQuestion(db, b.id, 'not needed');
    const t = (await req('GET', `/api/goals/${g.id}`)).json.timeline;
    const qs = t.filter((x: any) => x.kind === 'question');
    expect(qs.find((x: any) => x.text === 'Which colour?')).toMatchObject({ answer: 'Blue', note: null });
    expect(qs.find((x: any) => x.text === 'Which size?')).toMatchObject({ answer: null, note: 'Dismissed: not needed' });
    expect(qs.find((x: any) => x.text === 'Which font?')).toMatchObject({ answer: null, note: null });
    expect(t.some((x: any) => x.kind === 'answer')).toBe(false);
    void c;
  });

  it('filters goals by project and names the project on each row (criterion 256)', async () => {
    const { db, req } = await boot();
    const market = addProject(db, { name: 'market', rootPath: '/Users/x/market' });
    const brain = addProject(db, { name: 'central-brain', rootPath: '/Users/x/central-brain' });
    const a = createGoal(db, { title: 'Spread card', objective: 'o' });
    const b = createGoal(db, { title: 'UI', objective: 'o' });
    const c = createGoal(db, { title: 'Loose', objective: 'o' });
    setGoalProject(db, a.id, market.id);
    setGoalProject(db, b.id, brain.id);
    const m = (await req('GET', `/api/goals?project=${market.id}`)).json;
    expect(m.map((x: any) => x.id)).toEqual([a.id]);
    expect(m[0].project).toEqual({ id: market.id, name: 'market' });
    expect((await req('GET', '/api/goals?project=unassigned')).json.map((x: any) => x.id)).toEqual([c.id]);
    expect((await req('GET', '/api/goals')).json).toHaveLength(3);
    expect((await req('GET', `/api/goals/${a.id}`)).json.project).toEqual({ id: market.id, name: 'market' });
  });

  it('sets, changes and clears a goal project; rejects unknown projects (criterion 259)', async () => {
    const { db, req } = await boot();
    const market = addProject(db, { name: 'market', rootPath: '/Users/x/market' });
    const g = createGoal(db, { title: 'Spread card', objective: 'o' });
    const r = await req('POST', `/api/goals/${g.id}/project`, { projectId: market.id });
    expect(r.status).toBe(200);
    expect(goalProject(db, g.id)).toEqual({ id: market.id, name: 'market' });
    expect((await req('POST', `/api/goals/${g.id}/project`, { projectId: 'nope' })).status).toBe(400);
    expect(goalProject(db, g.id)?.id).toBe(market.id);
    expect((await req('POST', `/api/goals/${g.id}/project`, { projectId: null })).status).toBe(200);
    expect(goalProject(db, g.id)).toBeNull();
    expect((await req('POST', `/api/goals/${g.id}/project`, { projectId: 5 })).status).toBe(400);
  });

  it('starts a worker in the goal project folder and links the project on create', async () => {
    const { db, req, calls } = await boot();
    const market = addProject(db, { name: 'market', rootPath: '/Users/x/market' });
    const created = (await req('POST', '/api/goals', { title: 'T', objective: 'o', projectId: market.id, startWorker: false })).json;
    expect(goalProject(db, created.goal.id)?.id).toBe(market.id);
    await req('POST', `/api/goals/${created.goal.id}/worker`, { action: 'start' });
    expect(calls).toContainEqual(['start', created.goal.id, { cwd: '/Users/x/market' }]);
  });

  it('answer/dismiss call answersUpdated; approvals and worker actions reach the worker control', async () => {
    const { db, req, calls } = await boot();
    const g = (await req('POST', '/api/goals', { title: 'T', objective: 'O', startWorker: false })).json.goal;
    const [q1, q2] = listQuestions(db, g.id);
    expect((await req('POST', `/api/questions/${q1.id}/answer`, { answer: 'auth only', as: 'scope' })).status).toBe(200);
    expect((await req('POST', `/api/questions/${q2.id}/dismiss`, { reason: 'n/a' })).status).toBe(200);
    expect(calls.filter(c => c[0] === 'answersUpdated')).toHaveLength(2);
    const run = createRun(db, { goalId: g.id, cwd: '/tmp' });
    const a = createPermissionApproval(db, { goalId: g.id, runId: run.id, requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } });
    expect((await req('GET', '/api/needs-you')).json.approvals.map((x: any) => x.id)).toContain(a.id);
    const detailApproval = (await req('GET', `/api/goals/${g.id}`)).json.approvals[0];
    expect(detailApproval).toMatchObject({ id: a.id, runId: run.id, toolName: 'Bash', status: 'pending' });
    expect(JSON.parse(detailApproval.requestJson)).toEqual({ command: 'ls' });
    await req('POST', `/api/approvals/${a.id}`, { decision: 'allow' });
    expect(calls).toContainEqual(['decide', a.id, 'allow', undefined]);
    await req('POST', `/api/goals/${g.id}/worker`, { action: 'resume' });
    expect(calls).toContainEqual(['resume', g.id]);
    expect((await req('POST', `/api/goals/${g.id}/worker`, { action: 'explode' })).status).toBe(400);
  });

  it('pushes goal-changed over SSE after a write', async () => {
    const { db, s, req } = await boot();
    const g = (await req('POST', '/api/goals', { title: 'T', objective: 'O', startWorker: false })).json.goal;
    const got = new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: { host: `127.0.0.1:${s.port}` } }, res => {
        let buf = '';
        res.on('data', c => { buf += c; if (buf.includes('event: goal-changed')) { res.destroy(); resolve(buf); } });
      });
    });
    await new Promise(r => setTimeout(r, 100));
    const [q] = listQuestions(db, g.id);
    await req('POST', `/api/questions/${q.id}/dismiss`, { reason: 'x' });
    expect(await got).toContain(g.id);
  });
});

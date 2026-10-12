import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers.js';
import { createGoal } from '../src/services/goals.js';
import { addQuestion } from '../src/services/questions.js';
import { addEvent, createRun, getRun, listEvents, listRuns, updateRun } from '../src/services/workers.js';
import { WorkerManager } from '../src/workers/manager.js';
import { Notifier, type Push } from '../src/web/notifier.js';

const FAKE = path.join(process.cwd(), 'tests', 'fixtures', 'fake-claude.mjs');
const managers: WorkerManager[] = [];
const ENV = ['FAKE_SCENARIO', 'FAKE_LOG', 'FAKE_ON_TERM', 'FAKE_DELAY_MS', 'FAKE_TEXT_LEN'];

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

function setup(scenario: string, env: Record<string, string> = {}) {
  const db = createTestDb();
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-chat-')), 'log.jsonl');
  Object.assign(process.env, { FAKE_SCENARIO: scenario, FAKE_LOG: logFile, ...env });
  const m = new WorkerManager(db, { command: [process.execPath, FAKE], maxWorkers: 2, defaultCwd: os.tmpdir() });
  managers.push(m);
  const sent = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  const userTexts = () => sent().filter(s => s.type === 'user').map(s => String(s.message.content));
  const userEvents = (runId: string) => listEvents(db, runId).filter(e => e.kind === 'user').map(e => e.detail);
  return { db, m, sent, userTexts, userEvents };
}

afterEach(() => {
  for (const m of managers.splice(0)) m.stopAll();
  for (const k of ENV) delete process.env[k];
});

describe('send to a live worker between turns (criterion 303)', () => {
  it('writes the message at once and stores it as a user event', async () => {
    const { db, m, userTexts, userEvents } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    addQuestion(db, g.id, { question: 'Keep passwords?' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'waiting_answers');
    const out = m.send(g.id, '  What is left to do?  ');
    expect(out.delivery).toBe('sent');
    expect(out.run.status).toBe('working');
    await waitFor(() => userTexts().includes('What is left to do?'));
    expect(userEvents(run.id)).toEqual(['What is left to do?']);
  });
});

describe('send while the worker is mid-turn (criterion 304)', () => {
  it('holds the message until the turn result, then sends it before the nudge', async () => {
    const { db, m, userTexts, userEvents } = setup('stall', { FAKE_DELAY_MS: '600' });
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'working');
    expect(m.send(g.id, 'Also update the README').delivery).toBe('queued');
    expect(userEvents(run.id)).toEqual(['Also update the README']);
    expect(userTexts()).not.toContain('Also update the README'); // turn 1 still running
    await waitFor(() => userTexts().length >= 3, 10000);
    const texts = userTexts();
    expect(texts[1]).toBe('Also update the README');
    expect(texts[2]).toContain('until it is verified complete'); // the nudge comes after the user's turn
  });

  it('holds the message while an approval waits, and sends it after the turn ends', async () => {
    const { db, m, userTexts } = setup('permission');
    const g = createGoal(db, { title: 't', objective: 'o' });
    addQuestion(db, g.id, { question: 'q' }); // keeps the run alive after the turn
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'waiting_approval');
    expect(m.send(g.id, 'Do not push yet').delivery).toBe('queued');
    expect(userTexts()).not.toContain('Do not push yet');
    const { pendingApprovals } = await import('../src/services/workers.js');
    m.decide(pendingApprovals(db)[0]!.id, 'deny', 'not now');
    await waitFor(() => userTexts().includes('Do not push yet'));
  });
});

describe('send to a goal with no live worker (criterion 305)', () => {
  it('resumes the last session with the message as first input', async () => {
    const { db, m, sent, userTexts } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'stopped');
    await waitFor(() => m.runningCount() === 0);
    const out = m.send(g.id, 'Why did you stop?');
    expect(out.delivery).toBe('resumed');
    expect(out.run.id).toBe(run.id);
    await waitFor(() => userTexts().includes('Why did you stop?'));
    const argvs = sent().filter(s => s.argv).map(s => s.argv as string[]);
    expect(argvs).toHaveLength(2);
    expect(argvs[1]!.join(' ')).toContain('--resume fake-session-1');
  });

  it('starts a new worker with the goal brief plus the message when no session exists', async () => {
    const { db, m, userTexts } = setup('stall');
    const g = createGoal(db, { title: 'Chat goal', objective: 'o' });
    const out = m.send(g.id, 'Start with the tests');
    expect(out.delivery).toBe('started');
    expect(listRuns(db, g.id)).toHaveLength(1);
    const first = await waitFor(() => userTexts()[0]);
    expect(first).toContain(`Carry out Brain goal ${g.id}`);
    expect(first).toMatch(/Message from the user:\nStart with the tests$/);
  });
});

describe('refused messages (criteria 306, 312)', () => {
  it('rejects empty and over-long text and stores nothing', () => {
    const { db, m } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => m.send(g.id, '   ')).toThrow('Message is empty');
    expect(() => m.send(g.id, 'x'.repeat(4001))).toThrow('longer than 4000');
    expect(listRuns(db, g.id)).toEqual([]);
  });

  it('a run marked active without a process refuses the message and stores no event', () => {
    const { db, m, userEvents } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = createRun(db, { goalId: g.id, cwd: '/tmp' });
    updateRun(db, run.id, { status: 'working' });
    expect(() => m.send(g.id, 'hello')).toThrow('worker process is gone');
    expect(userEvents(run.id)).toEqual([]);
  });

  it('a worker still shutting down refuses the message and stores no event', async () => {
    const { db, m, userEvents } = setup('stall', { FAKE_ON_TERM: 'ignore' });
    const g = createGoal(db, { title: 't', objective: 'o' });
    addQuestion(db, g.id, { question: 'q' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'waiting_answers');
    m.stop(run.id); // the fake ignores SIGTERM, so the process lives on for the grace period
    expect(() => m.send(g.id, 'hello')).toThrow('still shutting down');
    expect(userEvents(run.id)).toEqual([]);
  });
});

describe('no push for chat (criterion 308)', () => {
  it('user messages and worker text replies send no push', async () => {
    const db = createTestDb();
    const sent: Push[] = [];
    const g = createGoal(db, { title: 'G', objective: 'o' });
    const run = createRun(db, { goalId: g.id, cwd: '/tmp' });
    updateRun(db, run.id, { status: 'working' });
    const n = new Notifier(db, async p => { sent.push(p); }, 'http://ui');
    addEvent(db, run.id, { kind: 'user', summary: 'hi', detail: 'hi' });
    addEvent(db, run.id, { kind: 'text', summary: 'hello back', detail: 'hello back' });
    expect(n.check()).toEqual([]);
    await Promise.resolve();
    expect(sent).toEqual([]);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, makeLockable } from './helpers.js';
import { createGoal, completeGoal, lockGoal, blockGoal } from '../src/services/goals.js';
import { addQuestion, answerQuestion } from '../src/services/questions.js';
import { getRun, createRun, updateRun, listEvents, pendingApprovals } from '../src/services/workers.js';
import { WorkerManager, readMaxWorkers, type ManagerEvent } from '../src/workers/manager.js';

const FAKE = path.join(process.cwd(), 'tests', 'fixtures', 'fake-claude.mjs');
const managers: WorkerManager[] = [];

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

function setup(scenario: string, maxWorkers = 2) {
  const db = createTestDb();
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fake-')), 'log.jsonl');
  process.env.FAKE_SCENARIO = scenario;
  process.env.FAKE_LOG = logFile;
  const events: ManagerEvent[] = [];
  const m = new WorkerManager(db, {
    command: [process.execPath, FAKE], maxWorkers, defaultCwd: os.tmpdir(), onEvent: e => events.push(e),
  });
  managers.push(m);
  const sent = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  return { db, m, events, sent };
}

afterEach(() => { for (const m of managers.splice(0)) m.stopAll(); });

describe('worker manager', () => {
  it('launches with the protocol args, records session + events, waits for answers, resumes once (Review Focus 1)', async () => {
    const { db, m, sent } = setup('stall');
    const g = createGoal(db, { title: 'SSO', objective: 'login' });
    const q1 = addQuestion(db, g.id, { question: 'Keep passwords?' });
    const q2 = addQuestion(db, g.id, { question: 'Provision users?' });
    const run = m.start(g.id);
    const waiting = await waitFor(() => { const r = getRun(db, run.id); return r.status === 'waiting_answers' && r; });
    expect(waiting.sessionId).toBe('fake-session-1');
    expect(sent()[0].argv).toContain('--permission-prompt-tool');
    expect(sent()[1]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
    expect(sent()[2].message.content).toContain(g.id);
    expect(listEvents(db, run.id).map(e => e.summary)).toContain('working turn 1');
    answerQuestion(db, q1.id, 'yes');
    m.answersUpdated(g.id);                 // still one open → no message
    answerQuestion(db, q2.id, 'no');
    m.answersUpdated(g.id);
    m.answersUpdated(g.id);                 // duplicate call → must not send twice
    await waitFor(() => getRun(db, run.id).status !== 'working' && sent().filter(s => s.type === 'user').length >= 2);
    const userMsgs = sent().filter(s => s.type === 'user').map(s => s.message.content);
    expect(userMsgs.filter(t => t.includes('have been answered'))).toHaveLength(1);
  });

  it('completes when a turn ends with the goal COMPLETED', async () => {
    const { db, m } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id); lockGoal(db, g.id); completeGoal(db, g.id, { force: true });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'completed');
    expect(getRun(db, run.id).endedAt).not.toBeNull();
  });

  it('nudges once, then stops a stalled run as resumable', async () => {
    const { db, m, sent } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'stopped');
    expect(getRun(db, run.id).exitReason).toBe('stalled');
    expect(sent().filter(s => s.type === 'user' && String(s.message.content).includes('until it is verified complete'))).toHaveLength(1);
  });

  it('stops without a nudge when the goal is BLOCKED at turn end', async () => {
    const { db, m, sent } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    blockGoal(db, g.id, 'need a decision');
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'stopped');
    expect(getRun(db, run.id).exitReason).toBe('goal blocked — needs you');
    expect(sent().filter(s => s.type === 'user' && String(s.message.content).includes('until it is verified complete'))).toHaveLength(0);
  });

  it('routes a permission prompt to an approval and returns the decision', async () => {
    const { db, m, sent, events } = setup('permission');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'waiting_approval');
    const [a] = pendingApprovals(db, g.id);
    expect(a).toMatchObject({ toolName: 'Bash', riskLevel: 'HIGH', requestId: 'r-1', runId: run.id });
    expect(events.some(e => e.type === 'approval' && e.approvalId === a.id)).toBe(true);
    m.decide(a.id, 'deny', 'no pushes');
    const reply = await waitFor(() => sent().find(s => s.type === 'control_response'));
    expect(reply.response).toMatchObject({ request_id: 'r-1', response: { behavior: 'deny', message: 'no pushes' } });
    await waitFor(() => listEvents(db, run.id).some(e => e.kind === 'error' && e.summary.includes('no pushes')));
  });

  it('marks a crashed worker failed with the exit reason', async () => {
    const { db, m } = setup('crash');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'failed');
    expect(getRun(db, run.id).exitReason).toMatch(/exit code 3/);
  });

  it('queues beyond maxWorkers and refuses a second run for the same goal', async () => {
    const { db, m } = setup('permission', 1);
    const g1 = createGoal(db, { title: 'a', objective: 'a' });
    const g2 = createGoal(db, { title: 'b', objective: 'b' });
    const r1 = m.start(g1.id);
    const r2 = m.start(g2.id);
    await waitFor(() => getRun(db, r1.id).status === 'waiting_approval');
    expect(getRun(db, r2.id).status).toBe('queued');
    expect(() => m.start(g1.id)).toThrow(/already has an active worker/);
    m.stop(r1.id);
    await waitFor(() => getRun(db, r2.id).status === 'waiting_approval');
  });

  it('resume relaunches with --resume <sessionId>', async () => {
    const { db, m, sent } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'stopped');
    const again = m.resume(g.id);
    expect(again.id).toBe(run.id);
    await waitFor(() => sent().filter(s => s.argv).length === 2);
    expect(sent().filter(s => s.argv)[1].argv.slice(-2)).toEqual(['--resume', 'fake-session-1']);
  });

  it('on construction, orphaned active runs become stopped/resumable (Review Focus 2)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = createRun(db, { goalId: g.id, cwd: '/tmp' });
    updateRun(db, r.id, { status: 'working', sessionId: 's-9' });
    const m = new WorkerManager(db, { command: [process.execPath, FAKE], defaultCwd: os.tmpdir() });
    managers.push(m);
    expect(getRun(db, r.id)).toMatchObject({ status: 'stopped', exitReason: 'server restarted' });
  });

  it('deciding an approval for a dead worker records it without throwing (Review Focus 3)', async () => {
    const { db, m } = setup('permission');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'waiting_approval');
    m.stop(run.id);
    const [a] = pendingApprovals(db, g.id);
    expect(m.decide(a.id, 'allow').status).toBe('approved');
  });

  it('reads maxWorkers from config with default 2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cfg-'));
    expect(readMaxWorkers(path.join(dir, 'missing.json'))).toBe(2);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ maxWorkers: 3 }));
    expect(readMaxWorkers(path.join(dir, 'config.json'))).toBe(3);
  });
});

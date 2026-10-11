import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal } from '../src/services/goals.js';
import {
  createRun, getRun, updateRun, listRuns, activeRunForGoal, queuedRuns, addEvent, listEvents,
  riskForTool, createPermissionApproval, pendingApprovals, decidePermission,
} from '../src/services/workers.js';

describe('worker store', () => {
  it('creates queued runs, tracks the active run, orders queue oldest first', () => {
    const db = createTestDb();
    const g1 = createGoal(db, { title: 'a', objective: 'a' });
    const g2 = createGoal(db, { title: 'b', objective: 'b' });
    const r1 = createRun(db, { goalId: g1.id, cwd: '/tmp' });
    const r2 = createRun(db, { goalId: g2.id, cwd: '/tmp' });
    expect(r1).toMatchObject({ status: 'queued', goalId: g1.id, cwd: '/tmp', sessionId: null });
    expect(r1.id).toMatch(/^RUN-/);
    expect(queuedRuns(db).map(r => r.id)).toEqual([r1.id, r2.id]);
    updateRun(db, r1.id, { status: 'working', sessionId: 's-1', pid: 42 });
    expect(activeRunForGoal(db, g1.id)?.id).toBe(r1.id);
    updateRun(db, r1.id, { status: 'completed', endedAt: new Date().toISOString() });
    expect(activeRunForGoal(db, g1.id)).toBeUndefined();
    expect(getRun(db, r1.id).sessionId).toBe('s-1');
    expect(listRuns(db, g1.id)).toHaveLength(1);
    expect(() => updateRun(db, r1.id, { status: 'bogus' as never })).toThrow(/status/);
  });

  it('truncates event summary/detail and returns the last N events oldest first (Review Focus 5)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'a', objective: 'a' });
    const r = createRun(db, { goalId: g.id, cwd: '/tmp' });
    const e = addEvent(db, r.id, { kind: 'tool', summary: 'x'.repeat(1000), detail: 'y'.repeat(500_000) });
    expect(e.summary.length).toBe(300);
    expect(e.detail!.length).toBe(4096);
    for (let i = 0; i < 5; i++) addEvent(db, r.id, { kind: 'text', summary: `m${i}` });
    expect(listEvents(db, r.id, { limit: 2 }).map(x => x.summary)).toEqual(['m3', 'm4']);
  });

  it('permission approvals: risk label, pending list, allow/deny once', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'a', objective: 'a' });
    const r = createRun(db, { goalId: g.id, cwd: '/tmp' });
    expect(riskForTool('Bash')).toBe('HIGH');
    expect(riskForTool('WebFetch')).toBe('HIGH');
    expect(riskForTool('Edit')).toBe('MEDIUM');
    const a = createPermissionApproval(db, {
      goalId: g.id, runId: r.id, requestId: 'req-1', toolName: 'Bash',
      input: { command: 'git push' }, description: 'Push branch',
    });
    expect(a).toMatchObject({ status: 'pending', riskLevel: 'HIGH', runId: r.id, requestId: 'req-1', toolName: 'Bash' });
    expect(a.action).toContain('git push');
    expect(JSON.parse(a.requestJson!)).toEqual({ command: 'git push' });
    expect(pendingApprovals(db, g.id)).toHaveLength(1);
    const d = decidePermission(db, a.id, 'deny', 'not now');
    expect(d).toMatchObject({ status: 'denied', note: 'not now' });
    expect(d.resolvedAt).not.toBeNull();
    expect(pendingApprovals(db)).toHaveLength(0);
    expect(() => decidePermission(db, a.id, 'allow')).toThrow(/already/);
  });

  it('breaks created_at ties by insertion order', () => {
    const db = createTestDb();
    const g1 = createGoal(db, { title: 'a', objective: 'a' });
    const g2 = createGoal(db, { title: 'b', objective: 'b' });
    const r1 = createRun(db, { goalId: g1.id, cwd: '/tmp' });
    const r2 = createRun(db, { goalId: g2.id, cwd: '/tmp' });
    const r3 = createRun(db, { goalId: g1.id, cwd: '/tmp' });
    db.$client.prepare('UPDATE worker_runs SET created_at = ?').run('2026-01-01T00:00:00.000Z');
    expect(queuedRuns(db).map(r => r.id)).toEqual([r1.id, r2.id, r3.id]);
    expect(listRuns(db, g1.id).map(r => r.id)).toEqual([r3.id, r1.id]);
    expect(activeRunForGoal(db, g1.id)?.id).toBe(r3.id);
  });
});

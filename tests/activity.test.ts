import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal, currentGoal, staleGoals, cancelGoal, getGoal, lockGoal } from '../src/services/goals.js';
import { touchGoal, isStale, staleDays } from '../src/services/activity.js';
import { addDecision, listDecisions } from '../src/services/decisions.js';
import { resumeGoal } from '../src/services/resume.js';
import { makeLockable } from './helpers.js';

const setUpdated = (db: ReturnType<typeof createTestDb>, id: string, iso: string) =>
  db.$client.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(iso, id);

afterEach(() => { delete process.env.BRAIN_STALE_DAYS; });

describe('activity and staleness', () => {
  it('staleDays defaults to 7 and honours env', () => {
    expect(staleDays()).toBe(7);
    process.env.BRAIN_STALE_DAYS = '3'; expect(staleDays()).toBe(3);
    process.env.BRAIN_STALE_DAYS = 'x'; expect(staleDays()).toBe(7);
  });

  it('isStale only for open statuses past the threshold', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(isStale({ status: 'EXECUTING', updatedAt: '2026-10-02T00:00:00Z' }, now)).toBe(true);
    expect(isStale({ status: 'EXECUTING', updatedAt: '2026-10-04T00:00:00Z' }, now)).toBe(false);
    expect(isStale({ status: 'COMPLETED', updatedAt: '2026-01-01T00:00:00Z' }, now)).toBe(false);
  });

  it('currentGoal skips stale goals; staleGoals lists them', () => {
    const db = createTestDb();
    const old = createGoal(db, { title: 'old', objective: 'o' }); makeLockable(db, old.id); lockGoal(db, old.id);
    const fresh = createGoal(db, { title: 'fresh', objective: 'o' }); makeLockable(db, fresh.id); lockGoal(db, fresh.id);
    setUpdated(db, old.id, '2026-09-01T00:00:00Z');
    setUpdated(db, fresh.id, '2026-10-08T00:00:00Z');
    const now = new Date('2026-10-10T00:00:00Z');
    expect(currentGoal(db, { now })?.id).toBe(fresh.id);
    expect(staleGoals(db, now).map(g => g.id)).toEqual([old.id]);
    setUpdated(db, fresh.id, '2026-09-01T00:00:00Z');
    expect(currentGoal(db, { now })).toBeUndefined();
  });

  it('goal-scoped writes touch the goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    setUpdated(db, g.id, '2026-01-01T00:00:00Z');
    addDecision(db, { goalId: g.id, decision: 'd' });
    expect(getGoal(db, g.id).updatedAt > '2026-01-01T00:00:00Z').toBe(true);
  });

  it('resume un-stales; get by id still works on stale goals', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    setUpdated(db, g.id, '2020-01-01T00:00:00Z');
    expect(getGoal(db, g.id).id).toBe(g.id);
    resumeGoal(db, g.id);
    expect(isStale(getGoal(db, g.id))).toBe(false);
  });

  it('cancelGoal needs a reason, is terminal, records an observation', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => cancelGoal(db, g.id, ' ')).toThrow(/reason/);
    expect(cancelGoal(db, g.id, 'superseded').status).toBe('CANCELLED');
    expect(() => cancelGoal(db, g.id, 'again')).toThrow(/CANCELLED/);
    const obs = db.$client.prepare('SELECT observation FROM observations WHERE goal_id = ?').all(g.id) as { observation: string }[];
    expect(obs.map(o => o.observation)).toContain('Goal cancelled: superseded');
  });

  it('touchGoal ignores null and unknown ids', () => {
    const db = createTestDb();
    expect(() => { touchGoal(db, null); touchGoal(db, 'GOAL-NOPE'); }).not.toThrow();
  });
});

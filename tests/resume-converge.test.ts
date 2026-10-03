import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable, makeStartable } from './helpers.js';
import { createGoal, lockGoal, startGoal, listRequirements } from '../src/services/goals.js';
import { resumeGoal } from '../src/services/resume.js';
import { getContext } from '../src/services/context.js';
import { convergeGoal } from '../src/services/converge.js';
import { updateWorkUnit } from '../src/services/work.js';

describe('resume + context integration', () => {
  it('resume embeds converge and recommends the top finding', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id); lockGoal(db, g.id); makeStartable(db, g.id); startGoal(db, g.id);
    const r = resumeGoal(db, g.id);
    expect(r.converge?.converged).toBe(false);
    expect(r.nextRecommendedAction).toMatch(/^fix (CRITICAL|HIGH) /);
  });
  it('context lists stale goals', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'old', objective: 'o' });
    db.$client.prepare(`UPDATE goals SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?`).run(g.id);
    expect(getContext(db).staleGoals.map(s => s.id)).toEqual([g.id]);
  });
  it('legacy runs (verdict NULL) are read as passed ? verified : failed (R5)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id); lockGoal(db, g.id);
    const wu = makeStartable(db, g.id); startGoal(db, g.id);
    db.$client.prepare('UPDATE goals SET rules_version = 0 WHERE id = ?').run(g.id);
    const crit = listRequirements(db, g.id).find(r => r.requirementType === 'success_criterion')!;
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    db.$client.prepare(
      `INSERT INTO verification_runs (goal_id, requirement_id, passed, verdict, created_at) VALUES (?, ?, 1, NULL, ?)`,
    ).run(g.id, crit.id, new Date().toISOString());
    const rep = convergeGoal(db, g.id);
    expect(rep.findings.map(f => f.id)).not.toContain(`missing:req:${crit.id}`);
    expect(rep.criteria.find(c => c.id === crit.id)!.verdict).toBe('verified');
  });
});

import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable } from './helpers.js';
import { createGoal, addRequirement, lockGoal, startGoal } from '../src/services/goals.js';
import { createWorkUnit, updateWorkUnit } from '../src/services/work.js';
import { addFailure } from '../src/services/failures.js';
import { recordVerification } from '../src/services/verification.js';
import { resumeGoal } from '../src/services/resume.js';

describe('goal resume (§72)', () => {
  it('assembles full state and points at the next ready work unit', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Ship feature', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'works' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    startGoal(db, g.id);
    const a = createWorkUnit(db, { goalId: g.id, title: 'Backend' });
    const b = createWorkUnit(db, { goalId: g.id, title: 'Frontend', dependsOn: [a.id] });
    updateWorkUnit(db, a.id, { status: 'COMPLETED' });
    addFailure(db, { errorMessage: 'flaky test', goalId: g.id });
    const state = resumeGoal(db, g.id);
    expect(state.contract).not.toBeNull();
    expect(state.completedWork.map(w => w.id)).toEqual([a.id]);
    expect(state.readyWork.map(w => w.id)).toEqual([b.id]);
    expect(state.unresolvedFailures).toHaveLength(1);
    expect(state.nextRecommendedAction).toBe(`Work on ${b.id}: Frontend`);
    // finish everything: recommendation flips to completion
    updateWorkUnit(db, b.id, { status: 'COMPLETED' });
    recordVerification(db, { passed: true, goalId: g.id, requirementId: r.id });
    expect(resumeGoal(db, g.id).nextRecommendedAction).toBe('All criteria passed — complete the goal');
  });

  it('gives lifecycle-appropriate recommendations', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Draft goal', objective: 'o' });
    expect(resumeGoal(db, g.id).nextRecommendedAction).toMatch(/lock the goal contract/i);
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    expect(resumeGoal(db, g.id).nextRecommendedAction).toMatch(/start the goal/i);
    expect(resumeGoal(db, g.id).contract).not.toBeNull();
  });
});

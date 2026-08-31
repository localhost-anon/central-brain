import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal, addRequirement, listRequirements } from '../src/services/goals.js';
import { recordVerification, listVerifications, goalVerificationState } from '../src/services/verification.js';

describe('verification service', () => {
  it('a passing run linked to a requirement marks it PASSED', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'tests pass' });
    recordVerification(db, {
      passed: true, goalId: g.id, requirementId: r.id,
      verificationType: 'unit_test', command: 'npx vitest run', actualResult: 'all green',
    });
    expect(listRequirements(db, g.id)[0].status).toBe('PASSED');
  });

  it('a failing run marks the requirement FAILED', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'build clean' });
    recordVerification(db, { passed: false, goalId: g.id, requirementId: r.id, command: 'npm run build' });
    expect(listRequirements(db, g.id)[0].status).toBe('FAILED');
  });

  it('goalVerificationState aggregates runs per requirement', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r1 = addRequirement(db, g.id, { type: 'success_criterion', description: 'a' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'b' });
    recordVerification(db, { passed: true, goalId: g.id, requirementId: r1.id });
    const state = goalVerificationState(db, g.id);
    expect(state.allRequiredPassed).toBe(false);
    expect(state.requirements.find(x => x.id === r1.id)!.runs).toHaveLength(1);
    expect(listVerifications(db, { goalId: g.id })).toHaveLength(1);
  });

  it('rejects dangling or cross-goal requirement ids', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => recordVerification(db, { passed: true, goalId: g.id, requirementId: 999 }))
      .toThrow(/not found/i);
    const other = createGoal(db, { title: 'other', objective: 'o' });
    const r = addRequirement(db, other.id, { type: 'success_criterion', description: 'x' });
    expect(() => recordVerification(db, { passed: true, goalId: g.id, requirementId: r.id }))
      .toThrow(/belongs to/i);
  });
});

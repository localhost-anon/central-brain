import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable, makeStartable } from './helpers.js';
import {
  createGoal, getGoal, listGoals, currentGoal, addRequirement,
  setRequirementStatus, lockGoal, startGoal, blockGoal, completeGoal,
} from '../src/services/goals.js';
import { observations, goalRequirements } from '../src/db/schema.js';

describe('goals service', () => {
  it('creates a DRAFT goal with a generated id', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Add SSO', objective: 'Users authenticate with Microsoft' });
    expect(g.id).toMatch(/^GOAL-\d{4}-\d{4}$/);
    expect(g.status).toBe('DRAFT');
    expect(getGoal(db, g.id).title).toBe('Add SSO');
  });

  it('lock snapshots the contract and freezes requirements', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Add SSO', objective: 'MS auth works' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'MS login works', verifyMethod: 'test' });
    makeLockable(db, g.id);
    const locked = lockGoal(db, g.id);
    expect(locked.status).toBe('LOCKED');
    expect(locked.lockedAt).toBeTruthy();
    const snap = JSON.parse(locked.contractSnapshot!);
    expect(snap.objective).toBe('MS auth works');
    expect(snap.requirements).toHaveLength(2);
    expect(() => addRequirement(db, g.id, { type: 'constraint', description: 'late add' }))
      .toThrow(/locked/i);
  });

  it('refuses completion while required success criteria are unmet', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'tests pass', verifyMethod: 'test' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    makeStartable(db, g.id);
    startGoal(db, g.id);
    expect(() => completeGoal(db, g.id)).toThrow(/tests pass/);
    setRequirementStatus(db, r.id, 'PASSED');
    expect(completeGoal(db, g.id).status).toBe('COMPLETED');
  });

  it('NOT_APPLICABLE requires a reason', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'x', verifyMethod: 'test' });
    expect(() => setRequirementStatus(db, r.id, 'NOT_APPLICABLE')).toThrow(/reason/i);
    setRequirementStatus(db, r.id, 'NOT_APPLICABLE', 'superseded by design change');
    const row = db.select().from(goalRequirements).all()[0];
    expect(row.status).toBe('NOT_APPLICABLE');
  });

  it('blockGoal records an observation; currentGoal returns the active goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(currentGoal(db)).toBeUndefined(); // DRAFT is not active
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    expect(currentGoal(db)?.id).toBe(g.id);
    blockGoal(db, g.id, 'AWS auth expired');
    expect(getGoal(db, g.id).status).toBe('BLOCKED');
    expect(db.select().from(observations).all()[0].observation).toContain('AWS auth expired');
    expect(listGoals(db, { status: 'BLOCKED' })).toHaveLength(1);
  });

  it('rejects invalid requirement types and terminal-state transitions', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => addRequirement(db, g.id, { type: 'success-criteria', description: 'x' }))
      .toThrow(/invalid/i);
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    completeGoal(db, g.id, { force: true });
    expect(() => blockGoal(db, g.id, 'late block')).toThrow(/cannot/i);
  });
});

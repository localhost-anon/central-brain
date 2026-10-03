import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable, makeStartable } from './helpers.js';
import { createGoal, addRequirement, lockGoal, startGoal, listRequirements } from '../src/services/goals.js';
import { createWorkUnit, workUnitLinks } from '../src/services/work.js';

describe('start gate (criterion #99)', () => {
  it('refuses while a required criterion has no serving work unit', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    addRequirement(db, g.id, { type: 'success_criterion', description: 'second', verifyMethod: 'test' });
    lockGoal(db, g.id);
    const [c1] = listRequirements(db, g.id).filter(r => r.requirementType === 'success_criterion');
    createWorkUnit(db, { goalId: g.id, title: 'do one', serves: [c1!.id] });
    expect(() => startGoal(db, g.id)).toThrow(/No work unit serves criterion #\d+: second/);
    makeStartable(db, g.id);
    expect(startGoal(db, g.id).status).toBe('EXECUTING');
  });

  it('serves must reference requirements of the same goal', () => {
    const db = createTestDb();
    const a = createGoal(db, { title: 'a', objective: 'o' }); makeLockable(db, a.id);
    const b = createGoal(db, { title: 'b', objective: 'o' });
    const reqA = listRequirements(db, a.id)[0]!;
    expect(() => createWorkUnit(db, { goalId: b.id, title: 'x', serves: [reqA.id] })).toThrow(/not a requirement of/);
    expect(() => createWorkUnit(db, { goalId: b.id, title: 'x', serves: [99999] })).toThrow(/not a requirement of/);
  });

  it('v0 goals start without coverage', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id); lockGoal(db, g.id);
    db.$client.prepare('UPDATE goals SET rules_version = 0 WHERE id = ?').run(g.id);
    expect(startGoal(db, g.id).status).toBe('EXECUTING');
  });

  it('workUnitLinks lists links', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' }); makeLockable(db, g.id);
    const wu = makeStartable(db, g.id);
    expect(workUnitLinks(db, g.id).every(l => l.workUnitId === wu.id)).toBe(true);
  });
});

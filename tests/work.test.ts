import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal } from '../src/services/goals.js';
import { createWorkUnit, updateWorkUnit, listWorkUnits, readyWorkUnits } from '../src/services/work.js';

describe('work units', () => {
  it('creates sequenced work units under a goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const wu1 = createWorkUnit(db, { goalId: g.id, title: 'Inspect auth' });
    const wu2 = createWorkUnit(db, { goalId: g.id, title: 'Modify backend' });
    expect(wu1.id.endsWith('.1')).toBe(true);
    expect(wu2.id.endsWith('.2')).toBe(true);
    expect(listWorkUnits(db, g.id)).toHaveLength(2);
  });

  it('readyWorkUnits respects dependencies', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const a = createWorkUnit(db, { goalId: g.id, title: 'A' });
    const b = createWorkUnit(db, { goalId: g.id, title: 'B', dependsOn: [a.id] });
    expect(readyWorkUnits(db, g.id).map(w => w.id)).toEqual([a.id]);
    updateWorkUnit(db, a.id, { status: 'COMPLETED' });
    expect(readyWorkUnits(db, g.id).map(w => w.id)).toEqual([b.id]);
  });

  it('tracks lifecycle timestamps and attempts', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const wu = createWorkUnit(db, { goalId: g.id, title: 'A' });
    const running = updateWorkUnit(db, wu.id, { status: 'RUNNING' });
    expect(running.startedAt).toBeTruthy();
    expect(running.attemptCount).toBe(1);
    const done = updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    expect(done.completedAt).toBeTruthy();
  });
});

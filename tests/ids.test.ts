import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { nextGoalId, workUnitIdFor, prefixedId, parsePrefixedId, slugify } from '../src/ids.js';
import { goals, workUnits } from '../src/db/schema.js';

const now = () => new Date().toISOString();

describe('ids', () => {
  it('generates sequential per-year goal ids', () => {
    const db = createTestDb();
    const d = new Date('2026-08-30T00:00:00Z');
    const id1 = nextGoalId(db, d);
    expect(id1).toBe('GOAL-2026-0001');
    db.insert(goals).values({ id: id1, title: 't', objective: 'o', createdAt: now(), updatedAt: now() }).run();
    expect(nextGoalId(db, d)).toBe('GOAL-2026-0002');
  });

  it('generates work unit ids scoped to the goal', () => {
    const db = createTestDb();
    db.insert(goals).values({ id: 'GOAL-2026-0001', title: 't', objective: 'o', createdAt: now(), updatedAt: now() }).run();
    const wu1 = workUnitIdFor(db, 'GOAL-2026-0001');
    expect(wu1).toBe('WU-2026-0001.1');
    db.insert(workUnits).values({ id: wu1, goalId: 'GOAL-2026-0001', title: 'w', createdAt: now() }).run();
    expect(workUnitIdFor(db, 'GOAL-2026-0001')).toBe('WU-2026-0001.2');
  });

  it('formats and parses prefixed ids', () => {
    expect(prefixedId('project', 'prospera')).toBe('project:prospera');
    expect(parsePrefixedId('repo:prospera-api')).toEqual({ type: 'repo', id: 'prospera-api' });
    expect(() => parsePrefixedId('prospera')).toThrow();
  });

  it('slugifies names', () => {
    expect(slugify('Prospera API!')).toBe('prospera-api');
  });
});

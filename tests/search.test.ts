import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { addKnowledge, invalidateKnowledge, addLearning } from '../src/services/knowledge.js';
import { addDecision } from '../src/services/decisions.js';
import { createGoal } from '../src/services/goals.js';
import { search, ftsQuery } from '../src/services/search.js';

describe('fts search', () => {
  it('sanitizes queries into prefix matches', () => {
    expect(ftsQuery('postgres migration')).toBe('"postgres"* "migration"*');
    expect(ftsQuery('it\'s "quoted"')).toBe('"it\'s"* """quoted"""*');
  });

  it('finds matches across types, ranked', () => {
    const db = createTestDb();
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'Prospera API uses PostgreSQL via Sequelize' });
    addLearning(db, { learning: 'Backward-compatible postgres migrations are preferred' });
    addDecision(db, { decision: 'Adopt PostgreSQL for the billing service', reason: 'transactional integrity' });
    createGoal(db, { title: 'Migrate to PostgreSQL 16', objective: 'upgrade db' });
    const results = search(db, 'postgres');
    const types = new Set(results.map(r => r.type));
    expect(types).toContain('knowledge');
    expect(types).toContain('learning');
    expect(types).toContain('decision');
    expect(types).toContain('goal');
    expect(results.length).toBeGreaterThanOrEqual(4);
  });

  it('excludes inactive knowledge and respects type filter + limit', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { scopeType: 'GLOBAL', statement: 'stale timezone fact' });
    invalidateKnowledge(db, k.id);
    addLearning(db, { learning: 'timezone conversions bite at API boundaries' });
    const res = search(db, 'timezone', { types: ['knowledge', 'learning'] });
    expect(res.map(r => r.type)).toEqual(['learning']);
    expect(search(db, 'timezone', { limit: 0 })).toEqual([]);
    expect(search(db, '   ')).toEqual([]);
  });
});

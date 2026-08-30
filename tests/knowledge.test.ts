import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import {
  addKnowledge, verifyKnowledge, invalidateKnowledge, supersedeKnowledge,
  listKnowledge, addLearning, markLearningUseful, listLearnings,
} from '../src/services/knowledge.js';

describe('knowledge lifecycle', () => {
  it('adds scoped knowledge and enforces prefixed scope ids', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { scopeType: 'REPOSITORY', scopeId: 'repo:prospera-api', statement: 'Uses PostgreSQL via Sequelize' });
    expect(k.status).toBe('active');
    expect(() => addKnowledge(db, { scopeType: 'REPOSITORY', scopeId: 'prospera-api', statement: 'x' }))
      .toThrow(/prefixed/i);
  });

  it('supersede preserves history and hides the old fact', () => {
    const db = createTestDb();
    const old = addKnowledge(db, { scopeType: 'GLOBAL', statement: 'Server IP is 192.0.2.10' });
    const neu = supersedeKnowledge(db, old.id, { statement: 'Server IP is 192.0.2.20' });
    const active = listKnowledge(db);
    expect(active.map(k => k.id)).toEqual([neu.id]);
    const all = listKnowledge(db, { includeInactive: true });
    const oldRow = all.find(k => k.id === old.id)!;
    expect(oldRow.status).toBe('superseded');
    expect(oldRow.supersededBy).toBe(neu.id);
  });

  it('verify and invalidate update lifecycle fields', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { scopeType: 'GLOBAL', statement: 'fact' });
    expect(verifyKnowledge(db, k.id).lastVerifiedAt).toBeTruthy();
    expect(invalidateKnowledge(db, k.id).status).toBe('invalid');
    expect(listKnowledge(db)).toHaveLength(0);
  });

  it('learnings track usefulness', () => {
    const db = createTestDb();
    const l = addLearning(db, { learning: 'Verify UTC conversion at API boundaries', trigger: 'timezone bug' });
    const used = markLearningUseful(db, l.id);
    expect(used.timesUsed).toBe(1);
    expect(used.lastUsedAt).toBeTruthy();
    expect(listLearnings(db)).toHaveLength(1);
  });
});

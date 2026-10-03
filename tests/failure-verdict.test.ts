import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { addFailure, addSolution, getFailure, resolveFailure } from '../src/services/failures.js';

describe('failure resolution (criterion #101)', () => {
  it('verified + reproduction resolves', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    const s = addSolution(db, f.id, { solution: 'raise timeout', verdict: 'verified', reproduction: 're-ran the original call; 200 in 3s' });
    expect(s.resolved).toBe(true);
    expect(getFailure(db, f.id).resolved).toBe(1);
  });
  it('verified without reproduction does not resolve and is stored partial', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    const s = addSolution(db, f.id, { solution: 'x', verdict: 'verified' });
    expect(s.resolved).toBe(false);
    expect(s.verdict).toBe('partial');
    expect(s.note).toMatch(/reproduction/);
    expect(getFailure(db, f.id).resolved).toBe(0);
  });
  it('legacy successful:true without reproduction is stored partial, not resolved', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    const s = addSolution(db, f.id, { solution: 'x', successful: true });
    expect(s.verdict).toBe('partial');
    expect(s.resolved).toBe(false);
    expect(s.note).toMatch(/reproduction/);
  });
  it('legacy successful:true with reproduction resolves', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    expect(addSolution(db, f.id, { solution: 'x', successful: true, reproduction: 'symptom gone' }).resolved).toBe(true);
  });
  it('resolveFailure requires a reason and stores it', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    expect(() => resolveFailure(db, f.id, '')).toThrow(/reason/);
    expect(resolveFailure(db, f.id, 'environment gone').resolutionNote).toBe('environment gone');
  });
});

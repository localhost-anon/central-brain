import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { addFailure, getFailure, searchFailures, resolveFailure, addSolution } from '../src/services/failures.js';

describe('failures service', () => {
  it('records and retrieves failures with solutions', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'ECONNRESET talking to supabase', failureType: 'network' });
    expect(f.resolved).toBe(0);
    addSolution(db, f.id, { solution: 'Retry with backoff; check Kong gateway', successful: false });
    const full = getFailure(db, f.id);
    expect(full.solutions).toHaveLength(1);
    expect(full.resolved).toBe(0);
  });

  it('a successful solution resolves the failure', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'migration failed: duplicate column' });
    addSolution(db, f.id, { solution: 'Drop the partial migration table and re-run', successful: true, reproduction: 'reran migration; no duplicate column' });
    const full = getFailure(db, f.id);
    expect(full.resolved).toBe(1);
    expect(full.resolvedAt).toBeTruthy();
  });

  it('failure search hits FTS (§66 reuse loop)', () => {
    const db = createTestDb();
    addFailure(db, { errorMessage: 'ECONNRESET talking to supabase' });
    const hits = searchFailures(db, 'econnreset');
    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe('failure');
  });

  it('resolveFailure works directly and getFailure throws on missing id', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'x' });
    expect(resolveFailure(db, f.id, 'obsolete').resolved).toBe(1);
    expect(() => getFailure(db, 999)).toThrow(/not found/i);
  });
});

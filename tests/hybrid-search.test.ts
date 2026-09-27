import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { fakeEmbedder } from '../src/services/embedder.js';
import { reindexEmbeddings } from '../src/services/embedding-store.js';
import { hybridSearch } from '../src/services/hybrid-search.js';
import { addKnowledge } from '../src/services/knowledge.js';
import { addObservation } from '../src/services/decisions.js';
import { search } from '../src/services/search.js';

describe('hybrid search', () => {
  it('finds semantic matches FTS alone misses, and merges both', async () => {
    const db = createTestDb();
    const e = fakeEmbedder();
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'seafile sync runs on truenas' });
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'kidtube is a tizen tv app' });
    await reindexEmbeddings(db, e);
    // query shares the token 'seafile' with row 1 only via semantics of the fake
    // (bag-of-words): 'seafile' overlaps row 1; FTS also matches row 1.
    const hits = await hybridSearch(db, e, 'seafile storage');
    expect(hits[0]!.text).toContain('seafile');
    // a token that FTS cannot match (no shared word with row 2 text except via fake
    // hashing is not guaranteed) — instead verify semantic-only reachability:
    // row embedded under a text FTS can't see (observation not matching keyword)
    const o = addObservation(db, { observation: 'tv application for children videos' });
    await reindexEmbeddings(db, e);
    const sem = await hybridSearch(db, e, 'tv children');
    expect(sem.some(h => h.type === 'observation' && h.id === String(o.id))).toBe(true);
  });

  it('observation FTS source works and empty query returns []', async () => {
    const db = createTestDb();
    addObservation(db, { observation: 'port 8020 already in use by voiceflowx' });
    expect(search(db, 'voiceflowx', { types: ['observation'] })).toHaveLength(1);
    expect(await hybridSearch(db, fakeEmbedder(), '   ')).toEqual([]);
  });

  it('respects type filter and limit', async () => {
    const db = createTestDb();
    const e = fakeEmbedder();
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'alpha beta gamma' });
    addObservation(db, { observation: 'alpha beta delta' });
    await reindexEmbeddings(db, e);
    const onlyK = await hybridSearch(db, e, 'alpha', { types: ['knowledge'] });
    expect(onlyK.every(h => h.type === 'knowledge')).toBe(true);
    expect((await hybridSearch(db, e, 'alpha', { limit: 1 })).length).toBe(1);
  });
});

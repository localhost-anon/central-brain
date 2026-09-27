import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { fakeEmbedder, type Embedder } from '../src/services/embedder.js';
import { gatherEmbeddable, reindexEmbeddings } from '../src/services/embedding-store.js';
import { addKnowledge, invalidateKnowledge, addLearning } from '../src/services/knowledge.js';
import { createGoal } from '../src/services/goals.js';
import { embeddings } from '../src/db/schema.js';

describe('embedding store', () => {
  it('gathers rows across sources, active knowledge only', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { scopeType: 'GLOBAL', statement: 'truenas hosts seafile' });
    const dead = addKnowledge(db, { scopeType: 'GLOBAL', statement: 'stale fact' });
    invalidateKnowledge(db, dead.id);
    addLearning(db, { learning: 'verify utc at api boundaries' });
    createGoal(db, { title: 'Ship search', objective: 'hybrid retrieval' });
    const rows = gatherEmbeddable(db);
    expect(rows.map(r => r.type).sort()).toEqual(['goal', 'knowledge', 'learning']);
    expect(rows.find(r => r.type === 'knowledge')!.id).toBe(String(k.id));
  });

  it('reindex embeds once, skips unchanged, re-embeds on content change', async () => {
    const db = createTestDb();
    const e = fakeEmbedder();
    const k = addKnowledge(db, { scopeType: 'GLOBAL', statement: 'original statement' });
    const first = await reindexEmbeddings(db, e);
    expect(first).toEqual({ embedded: 1, skipped: 0 });
    const second = await reindexEmbeddings(db, e);
    expect(second).toEqual({ embedded: 0, skipped: 1 });
    db.$client.prepare('UPDATE knowledge SET statement = ? WHERE id = ?').run('changed statement', k.id);
    const third = await reindexEmbeddings(db, e);
    expect(third.embedded).toBe(1);
    expect(db.select().from(embeddings).all()).toHaveLength(1); // upsert, not duplicate
  });
  it('reindexes in chunks, one embed call per chunk, reporting progress', async () => {
    const db = createTestDb();
    const base = fakeEmbedder();
    let calls = 0;
    const e: Embedder = { model: base.model, embed: (t) => { calls++; return base.embed(t); } };
    for (let i = 0; i < 5; i++) addKnowledge(db, { scopeType: 'GLOBAL', statement: `fact number ${i}` });
    const progress: [number, number][] = [];
    const res = await reindexEmbeddings(db, e, { chunkSize: 2, onProgress: (d, t) => progress.push([d, t]) });
    expect(res).toEqual({ embedded: 5, skipped: 0 });
    expect(calls).toBe(3);
    expect(progress).toEqual([[2, 5], [4, 5], [5, 5]]);
    expect(db.select().from(embeddings).all()).toHaveLength(5);
  });

  it('persists completed chunks when a later chunk fails', async () => {
    const db = createTestDb();
    const base = fakeEmbedder();
    let calls = 0;
    const flaky: Embedder = {
      model: base.model,
      embed: (t) => { calls++; if (calls === 2) throw new Error('boom'); return base.embed(t); },
    };
    for (let i = 0; i < 5; i++) addKnowledge(db, { scopeType: 'GLOBAL', statement: `fact number ${i}` });
    await expect(reindexEmbeddings(db, flaky, { chunkSize: 2 })).rejects.toThrow('boom');
    expect(db.select().from(embeddings).all()).toHaveLength(2);
    const rerun = await reindexEmbeddings(db, base, { chunkSize: 2 });
    expect(rerun).toEqual({ embedded: 3, skipped: 2 });
    expect(db.select().from(embeddings).all()).toHaveLength(5);
  });
});

import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { fakeEmbedder } from '../src/services/embedder.js';
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
});

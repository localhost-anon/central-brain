import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import {
  decisions, embeddings, failures, goals, knowledge, learnings, observations,
} from '../db/schema.js';
import { toBlob, type Embedder } from './embedder.js';
import type { SearchType } from './search.js';

export interface EmbeddableRow {
  type: SearchType | 'observation';
  id: string;
  text: string;
  scopeType: string | null;
  scopeId: string | null;
}

const now = () => new Date().toISOString();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export function gatherEmbeddable(db: BrainDb): EmbeddableRow[] {
  const rows: EmbeddableRow[] = [];
  for (const k of db.select().from(knowledge).where(eq(knowledge.status, 'active')).all()) {
    rows.push({ type: 'knowledge', id: String(k.id), text: k.statement, scopeType: k.scopeType, scopeId: k.scopeId });
  }
  for (const l of db.select().from(learnings).all()) {
    rows.push({ type: 'learning', id: String(l.id), text: l.learning, scopeType: l.scopeType, scopeId: l.scopeId });
  }
  for (const d of db.select().from(decisions).all()) {
    rows.push({ type: 'decision', id: String(d.id), text: d.reason ? `${d.decision}: ${d.reason}` : d.decision, scopeType: d.scopeType, scopeId: d.scopeId });
  }
  for (const f of db.select().from(failures).all()) {
    if (f.errorMessage) rows.push({ type: 'failure', id: String(f.id), text: f.errorMessage, scopeType: null, scopeId: null });
  }
  for (const g of db.select().from(goals).all()) {
    rows.push({ type: 'goal', id: g.id, text: `${g.title}: ${g.objective}`, scopeType: 'GOAL', scopeId: `goal:${g.id}` });
  }
  for (const o of db.select().from(observations).all()) {
    rows.push({ type: 'observation', id: String(o.id), text: o.observation, scopeType: o.scopeType, scopeId: o.scopeId });
  }
  return rows;
}

export async function reindexEmbeddings(db: BrainDb, embedder: Embedder): Promise<{ embedded: number; skipped: number }> {
  const rows = gatherEmbeddable(db);
  const pending: EmbeddableRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const existing = db.select().from(embeddings).where(and(
      eq(embeddings.sourceType, r.type), eq(embeddings.sourceId, r.id), eq(embeddings.model, embedder.model),
    )).get();
    if (existing && existing.contentHash === sha(r.text)) { skipped++; continue; }
    pending.push(r);
  }
  if (pending.length > 0) {
    const vectors = await embedder.embed(pending.map(p => p.text));
    for (let i = 0; i < pending.length; i++) {
      const r = pending[i]!;
      db.delete(embeddings).where(and(
        eq(embeddings.sourceType, r.type), eq(embeddings.sourceId, r.id), eq(embeddings.model, embedder.model),
      )).run();
      db.insert(embeddings).values({
        sourceType: r.type, sourceId: r.id, model: embedder.model,
        contentHash: sha(r.text), vector: toBlob(vectors[i]!), createdAt: now(),
      }).run();
    }
  }
  return { embedded: pending.length, skipped };
}

export function loadEmbeddings(db: BrainDb, model: string) {
  return db.select().from(embeddings).where(eq(embeddings.model, model)).all();
}

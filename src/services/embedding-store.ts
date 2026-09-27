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

export interface ReindexOptions {
  chunkSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function reindexEmbeddings(
  db: BrainDb, embedder: Embedder, opts: ReindexOptions = {},
): Promise<{ embedded: number; skipped: number }> {
  const chunkSize = Math.max(1, opts.chunkSize ?? 256);
  const existing = new Map<string, string>();
  for (const e of db.select({ sourceType: embeddings.sourceType, sourceId: embeddings.sourceId, contentHash: embeddings.contentHash })
    .from(embeddings).where(eq(embeddings.model, embedder.model)).all()) {
    existing.set(`${e.sourceType}:${e.sourceId}`, e.contentHash);
  }
  const pending: { row: EmbeddableRow; hash: string }[] = [];
  let skipped = 0;
  for (const r of gatherEmbeddable(db)) {
    const hash = sha(r.text);
    if (existing.get(`${r.type}:${r.id}`) === hash) { skipped++; continue; }
    pending.push({ row: r, hash });
  }
  let done = 0;
  for (let start = 0; start < pending.length; start += chunkSize) {
    const chunk = pending.slice(start, start + chunkSize);
    const vectors = await embedder.embed(chunk.map(p => p.row.text));
    // One synchronous transaction per chunk: a crash loses at most the current chunk.
    db.transaction((tx) => {
      const createdAt = now();
      chunk.forEach(({ row: r, hash }, i) => {
        tx.delete(embeddings).where(and(
          eq(embeddings.sourceType, r.type), eq(embeddings.sourceId, r.id), eq(embeddings.model, embedder.model),
        )).run();
        tx.insert(embeddings).values({
          sourceType: r.type, sourceId: r.id, model: embedder.model,
          contentHash: hash, vector: toBlob(vectors[i]!), createdAt,
        }).run();
      });
    });
    done += chunk.length;
    opts.onProgress?.(done, pending.length);
  }
  return { embedded: pending.length, skipped };
}

export function loadEmbeddings(db: BrainDb, model: string) {
  return db.select().from(embeddings).where(eq(embeddings.model, model)).all();
}

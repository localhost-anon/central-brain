import type { BrainDb } from '../db/connection.js';
import { cosine, fromBlob, type Embedder } from './embedder.js';
import { gatherEmbeddable, loadEmbeddings } from './embedding-store.js';
import { search, type SearchResult, type SearchType } from './search.js';

const RRF_K = 60;

export async function hybridSearch(
  db: BrainDb, embedder: Embedder, query: string,
  opts: { types?: SearchType[]; limit?: number } = {},
): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const limit = opts.limit ?? 20;
  const fts = search(db, query, { types: opts.types, limit: limit * 2 });

  const [qv] = await embedder.embed([query]);
  const stored = loadEmbeddings(db, embedder.model)
    .filter(e => !opts.types || opts.types.includes(e.sourceType as SearchType));
  const semantic = stored
    .map(e => ({ e, sim: cosine(qv!, fromBlob(e.vector as Buffer)) }))
    .filter(s => s.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit * 2);

  const fused = new Map<string, { result: SearchResult | null; type: string; id: string; score: number }>();
  const key = (t: string, i: string) => `${t}:${i}`;
  fts.forEach((r, i) => {
    const k = key(r.type, r.id);
    const cur = fused.get(k) ?? { result: r, type: r.type, id: r.id, score: 0 };
    cur.result ??= r;
    cur.score += 1 / (RRF_K + i + 1);
    fused.set(k, cur);
  });
  semantic.forEach((s, i) => {
    const k = key(s.e.sourceType, s.e.sourceId);
    const cur = fused.get(k) ?? { result: null, type: s.e.sourceType, id: s.e.sourceId, score: 0 };
    cur.score += 1 / (RRF_K + i + 1);
    fused.set(k, cur);
  });

  // hydrate semantic-only hits
  const needText = [...fused.values()].some(v => v.result === null);
  const rows = needText ? gatherEmbeddable(db) : [];
  const results: SearchResult[] = [];
  for (const v of [...fused.values()].sort((a, b) => b.score - a.score)) {
    if (v.result) {
      results.push({ ...v.result, score: -v.score }); // keep "lower is better" convention
    } else {
      const row = rows.find(r => r.type === v.type && r.id === v.id);
      if (row) results.push({
        type: row.type as SearchType, id: row.id, text: row.text,
        score: -v.score, scopeType: row.scopeType, scopeId: row.scopeId,
      });
    }
    if (results.length >= limit) break;
  }
  return results;
}

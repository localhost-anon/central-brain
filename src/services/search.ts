import type { BrainDb } from '../db/connection.js';

export type SearchType = 'knowledge' | 'learning' | 'decision' | 'failure' | 'goal' | 'observation';

export interface SearchResult {
  type: SearchType;
  id: string;
  text: string;
  score: number;
  scopeType: string | null;
  scopeId: string | null;
}

export function ftsQuery(raw: string): string {
  return raw.trim().split(/\s+/).filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

const SOURCES: Record<SearchType, { sql: string }> = {
  knowledge: {
    sql: `SELECT 'knowledge' AS type, CAST(k.id AS TEXT) AS id, k.statement AS text,
                 bm25(knowledge_fts) AS score, k.scope_type AS scopeType, k.scope_id AS scopeId
          FROM knowledge_fts f JOIN knowledge k ON k.id = f.rowid
          WHERE knowledge_fts MATCH ? AND k.status = 'active'`,
  },
  learning: {
    sql: `SELECT 'learning' AS type, CAST(l.id AS TEXT) AS id, l.learning AS text,
                 bm25(learnings_fts) AS score, l.scope_type AS scopeType, l.scope_id AS scopeId
          FROM learnings_fts f JOIN learnings l ON l.id = f.rowid
          WHERE learnings_fts MATCH ?`,
  },
  decision: {
    sql: `SELECT 'decision' AS type, CAST(d.id AS TEXT) AS id, d.decision AS text,
                 bm25(decisions_fts) AS score, d.scope_type AS scopeType, d.scope_id AS scopeId
          FROM decisions_fts f JOIN decisions d ON d.id = f.rowid
          WHERE decisions_fts MATCH ?`,
  },
  failure: {
    sql: `SELECT 'failure' AS type, CAST(x.id AS TEXT) AS id, x.error_message AS text,
                 bm25(failures_fts) AS score, NULL AS scopeType, NULL AS scopeId
          FROM failures_fts f JOIN failures x ON x.id = f.rowid
          WHERE failures_fts MATCH ?`,
  },
  goal: {
    sql: `SELECT 'goal' AS type, g.id AS id, g.title AS text,
                 bm25(goals_fts) AS score, 'GOAL' AS scopeType, ('goal:' || g.id) AS scopeId
          FROM goals_fts f JOIN goals g ON g.rowid = f.rowid
          WHERE goals_fts MATCH ?`,
  },
  observation: {
    sql: `SELECT 'observation' AS type, CAST(o.id AS TEXT) AS id, o.observation AS text,
                 bm25(observations_fts) AS score, o.scope_type AS scopeType, o.scope_id AS scopeId
          FROM observations_fts f JOIN observations o ON o.id = f.rowid
          WHERE observations_fts MATCH ?`,
  },
};

export function search(
  db: BrainDb, query: string,
  opts: { types?: SearchType[]; limit?: number } = {},
): SearchResult[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const limit = opts.limit ?? 20;
  const types = opts.types ?? (Object.keys(SOURCES) as SearchType[]);
  const results: SearchResult[] = [];
  for (const t of types) {
    const rows = db.$client.prepare(SOURCES[t].sql).all(match) as SearchResult[];
    results.push(...rows);
  }
  return results.sort((a, b) => a.score - b.score).slice(0, limit);
}

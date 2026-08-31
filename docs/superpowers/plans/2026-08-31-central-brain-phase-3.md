# Central Brain Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hybrid semantic search using local ONNX embeddings (fastembed / bge-small-en-v1.5, in-process, zero external services) with vectors stored in brain.db, plus a one-time idempotent import of ~10.8k claude-mem observations — tracked as GOAL-2026-0003 in the live brain.

**Architecture:** An `Embedder` interface (real: fastembed ONNX; fake: deterministic bag-of-words for tests) feeds an `embeddings` table (Float32 BLOBs, content-hash staleness). `hybridSearch(db, embedder, query)` merges the existing FTS5 `search()` with brute-force cosine top-k via reciprocal-rank fusion; the sync `search()` stays untouched so existing sync callers are unaffected — CLI/MCP search surfaces switch to the async hybrid. Observations become searchable (new FTS table) so the claude-mem import lands in retrievable memory. Import reads `~/.claude-mem/claude-mem.db` strictly read-only.

**Tech Stack:** adds one production dependency: `fastembed` (^2.1.0, verified on npm; bundles onnxruntime). Everything else unchanged.

**Spec:** `ARCHITECTURE.md` v0.2 — §17.3 backend v2 (as amended 2026-08-31: ONNX-local, no Qdrant), §2.4/§79 (claude-mem import), §28 (imported facts carry confidence/source), §30 (observations).

## Global Constraints

- ESM only; relative imports carry `.js` extensions; suite currently 65/65 green at `29a9007` (plus one spec-docs commit after); every task keeps `npx tsc --noEmit` clean and full `npx vitest run` green before its commit.
- **Sync/async boundary:** `search()` in src/services/search.ts KEEPS its sync signature (context engine and failures service depend on it). Semantic retrieval lives in the new async `hybridSearch()`. Only CLI actions (via `parseAsync`) and MCP handlers (already async-wrapped) may await.
- **Model cache:** default `~/.central-brain/models` (configurable `cacheDir` param). This is a build-artifact cache, not user data — the one real-model integration test MAY use the default cache (downloads bge-small ~34MB once, then reuses). All other tests use `fakeEmbedder()` — no network, no model init.
- Tests use `createTestDb()` and mkdtemp fixtures; never write to `~/.claude-mem` (importer opens it `{ readonly: true }`) and never write user data outside temp dirs; the live import/reindex happens only in the final task.
- Vector encoding: Float32Array ↔ Buffer via the Task 2 helpers; cosine on Float32Array; RRF constant 60.
- Embedding staleness: `content_hash` = sha256 hex of the embedded text; re-embed only when hash or model changes.
- Import idempotency: `observations.source_ref = 'claude-mem:<id>'`; existing refs are skipped.
- Commit after every task; messages end with `Goal: GOAL-2026-0003` and `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` on separate lines.
- Existing interfaces consumed (do not modify): `search(db, q, {types, limit})` sync + `SearchResult`, `listProjects`, `slugify`, `createTestDb`, schema tables, `migrateDb` (auto-snapshots file DBs with pending migrations — expected to fire once on the live upgrade in the final task).

---

### Task 1: Schema — embeddings table, observations.source_ref, observations FTS

**Files:**
- Modify: `src/db/schema.ts`
- Create: generated migration + one custom FTS migration under `drizzle/`
- Test: extend `tests/db.test.ts`

**Interfaces:**
- Consumes: existing schema/migration setup
- Produces: `embeddings` table object (columns below); `observations.sourceRef`; `observations_fts` virtual table + sync triggers. Later tasks rely on exactly these names.

- [ ] **Step 1: Extend the Drizzle schema**

In `src/db/schema.ts`: extend the sqlite-core import to include `blob` and `uniqueIndex`, add `sourceRef: text('source_ref'),` to the `observations` table (after `confidence`), and append:

```ts
export const embeddings = sqliteTable('embeddings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  model: text('model').notNull(),
  contentHash: text('content_hash').notNull(),
  vector: blob('vector', { mode: 'buffer' }).notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [uniqueIndex('embeddings_source_model').on(t.sourceType, t.sourceId, t.model)]);
```

- [ ] **Step 2: Generate migrations**

```bash
npx drizzle-kit generate
npx drizzle-kit generate --custom --name=observations_fts
```

Fill the custom file with (same external-content pattern as `drizzle/0001_fts.sql`, statements separated by `--> statement-breakpoint`):

```sql
CREATE VIRTUAL TABLE observations_fts USING fts5(observation, content='observations', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, observation) VALUES (new.id, new.observation);
END;
--> statement-breakpoint
CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, observation) VALUES ('delete', old.id, old.observation);
END;
--> statement-breakpoint
CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, observation) VALUES ('delete', old.id, old.observation);
  INSERT INTO observations_fts(rowid, observation) VALUES (new.id, new.observation);
END;
```

- [ ] **Step 3: Failing test, then pass**

Append to `tests/db.test.ts` in the existing describe block:

```ts
  it('phase 3 schema: embeddings table and observations_fts exist', () => {
    const db = createTestDb();
    const names = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((r: any) => r.name);
    expect(names).toContain('embeddings');
    expect(names).toContain('observations_fts');
    db.$client.prepare(
      "INSERT INTO observations (observation, created_at) VALUES ('truenas hosts seafile', ?)"
    ).run(new Date().toISOString());
    const hits = db.$client.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'seafile'").all();
    expect(hits.length).toBe(1);
  });
```

Run: `npx vitest run tests/db.test.ts` — new test FAILS before Steps 1–2, PASSES after (5 total in file). Full suite green; `npx tsc --noEmit` clean.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle tests/db.test.ts
git commit -m "feat: embeddings table, observations source_ref + FTS (phase 3 schema)

Goal: GOAL-2026-0003

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Embedder interface, fastembed wrapper, vector utils

**Files:**
- Create: `src/services/embedder.ts`
- Test: `tests/embedder.test.ts` (fake + utils), `tests/embedder-real.test.ts` (one real-model integration test)

**Interfaces:**
- Consumes: `fastembed` (add to package.json: `npm install fastembed` in this task), node:os/path
- Produces (from `src/services/embedder.js`):
  - `interface Embedder { readonly model: string; embed(texts: string[]): Promise<Float32Array[]> }`
  - `toBlob(v: Float32Array): Buffer` / `fromBlob(b: Buffer): Float32Array` / `cosine(a, b): number`
  - `createFastEmbedder(cacheDir?: string): Embedder` — lazy-inits fastembed's `FlagEmbedding` with `BGESmallENV15`, model name `'bge-small-en-v1.5'`, default cacheDir `~/.central-brain/models`
  - `fakeEmbedder(dims = 32): Embedder` — deterministic bag-of-words hashing (model `'fake-32'`); shared-word texts get high cosine, disjoint texts low — good enough for ranking tests

- [ ] **Step 1: Install the dependency**

```bash
npm install fastembed
```

- [ ] **Step 2: Write failing tests (fake + utils)**

`tests/embedder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fakeEmbedder, toBlob, fromBlob, cosine } from '../src/services/embedder.js';

describe('embedder utils + fake', () => {
  it('round-trips vectors through Buffer', () => {
    const v = new Float32Array([0.25, -1.5, 3]);
    expect(Array.from(fromBlob(toBlob(v)))).toEqual([0.25, -1.5, 3]);
  });

  it('cosine behaves', () => {
    const a = new Float32Array([1, 0]);
    expect(cosine(a, new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(a, new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosine(a, new Float32Array([0, 0]))).toBe(0);
  });

  it('fake embedder is deterministic and overlap-sensitive', async () => {
    const e = fakeEmbedder();
    const [a1, a2, b] = await e.embed([
      'seafile file sync server', 'seafile sync', 'trading bot latency']);
    const [a1b] = await e.embed(['seafile file sync server']);
    expect(Array.from(a1)).toEqual(Array.from(a1b));
    expect(cosine(a1, a2)).toBeGreaterThan(cosine(a1, b));
  });
});
```

- [ ] **Step 3: Implement**

`src/services/embedder.ts`:

```ts
import os from 'node:os';
import path from 'node:path';

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function createFastEmbedder(
  cacheDir: string = path.join(os.homedir(), '.central-brain', 'models'),
): Embedder {
  let modelPromise: Promise<any> | undefined;
  const load = () => {
    modelPromise ??= (async () => {
      const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
      return FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir, showDownloadProgress: false });
    })();
    return modelPromise;
  };
  return {
    model: 'bge-small-en-v1.5',
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const m = await load();
      const out: Float32Array[] = [];
      for await (const batch of m.embed(texts, 32)) {
        for (const v of batch) out.push(Float32Array.from(v));
      }
      return out;
    },
  };
}

export function fakeEmbedder(dims = 32): Embedder {
  return {
    model: `fake-${dims}`,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(t => {
        const v = new Float32Array(dims);
        for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
          v[h % dims] += 1;
        }
        return v;
      });
    },
  };
}
```

NOTE for the implementer: verify the installed fastembed API before trusting the wrapper — `grep -n "FlagEmbedding\|EmbeddingModel\|embed" node_modules/fastembed/lib/*.d.ts | head -20` (targeted grep only, never read the files wholesale). If names differ (e.g. init options, generator shape), adapt ONLY inside `createFastEmbedder` and note it in your report.

- [ ] **Step 4: Real-model integration test**

`tests/embedder-real.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createFastEmbedder, cosine } from '../src/services/embedder.js';

describe('fastembed real model (downloads once to ~/.central-brain/models)', () => {
  it('embeds semantically: paraphrase beats unrelated', { timeout: 300000 }, async () => {
    const e = createFastEmbedder();
    const [nas, para, other] = await e.embed([
      'TrueNAS server hosts the Seafile file sync service',
      'network attached storage box running a document sync app',
      'candlestick chart colors for the trading dashboard',
    ]);
    expect(nas.length).toBeGreaterThan(100);
    expect(cosine(nas, para)).toBeGreaterThan(cosine(nas, other));
  });
});
```

- [ ] **Step 5: Run everything, commit**

Run: `npx vitest run tests/embedder.test.ts` (3 PASS, fast), then `npx vitest run tests/embedder-real.test.ts` (1 PASS; first run downloads the model — slow once). Full suite green; tsc clean.

```bash
git add package.json package-lock.json src/services/embedder.ts tests/embedder.test.ts tests/embedder-real.test.ts
git commit -m "feat: local ONNX embedder (fastembed) with fake for tests

Goal: GOAL-2026-0003

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Embedding store & reindex

**Files:**
- Create: `src/services/embedding-store.ts`
- Test: `tests/embedding-store.test.ts`

**Interfaces:**
- Consumes: `embeddings` table (Task 1), `Embedder`/`toBlob` (Task 2), all content tables, node:crypto
- Produces (from `src/services/embedding-store.js`):
  - `interface EmbeddableRow { type: SearchType | 'observation'; id: string; text: string; scopeType: string | null; scopeId: string | null }` (reuse `SearchType` from search.js; observations included)
  - `gatherEmbeddable(db): EmbeddableRow[]` — knowledge (active only, statement), learnings (learning), decisions (decision + ': ' + reason when set), failures (errorMessage), goals (title + ': ' + objective), observations (observation). Ids as strings (goal ids verbatim; numeric ids stringified).
  - `reindexEmbeddings(db, embedder): Promise<{ embedded: number; skipped: number }>` — sha256 content hash; skip when an `embeddings` row for (type, id, model) has the same hash; else embed in one batch and upsert (delete stale row + insert)
  - `loadEmbeddings(db, model): { row: typeof embeddings.$inferSelect }[]` — all rows for a model

- [ ] **Step 1: Write failing tests**

`tests/embedding-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Implement**

`src/services/embedding-store.ts`:

```ts
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
```

- [ ] **Step 3: Run to pass, full suite, commit**

Run: `npx vitest run tests/embedding-store.test.ts` — 2 PASS. Full suite green; tsc clean.

```bash
git add src/services/embedding-store.ts tests/embedding-store.test.ts
git commit -m "feat: embedding store with hash-keyed reindex

Goal: GOAL-2026-0003

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Hybrid search (FTS + cosine, RRF merge) + observation FTS type

**Files:**
- Modify: `src/services/search.ts` (add `'observation'` source)
- Create: `src/services/hybrid-search.ts`
- Test: `tests/hybrid-search.test.ts`

**Interfaces:**
- Consumes: `search`/`SearchType`/`SearchResult` (search.js), `gatherEmbeddable`/`loadEmbeddings` (Task 3), `cosine`/`fromBlob`/`Embedder` (Task 2)
- Produces:
  - search.ts: `SearchType` union gains `'observation'`; `SOURCES` gains an observation entry (SQL below); everything else untouched — `search()` stays sync
  - `hybridSearch(db, embedder, query, opts?: { types?: SearchType[]; limit?: number }): Promise<SearchResult[]>` — FTS candidates (limit×2) + cosine top-(limit×2) over stored vectors for the embedder's model, merged by RRF (k=60), hydrated via `gatherEmbeddable` for semantic-only hits, sorted by fused score desc, sliced to limit (default 20). Empty/whitespace query → []. Rows without embeddings are still reachable via the FTS half.

- [ ] **Step 1: Add the observation FTS source**

In `src/services/search.ts`: change the `SearchType` union to `'knowledge' | 'learning' | 'decision' | 'failure' | 'goal' | 'observation'` and add to `SOURCES`:

```ts
  observation: {
    sql: `SELECT 'observation' AS type, CAST(o.id AS TEXT) AS id, o.observation AS text,
                 bm25(observations_fts) AS score, o.scope_type AS scopeType, o.scope_id AS scopeId
          FROM observations_fts f JOIN observations o ON o.id = f.rowid
          WHERE observations_fts MATCH ?`,
  },
```

- [ ] **Step 2: Write failing tests**

`tests/hybrid-search.test.ts`:

```ts
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
```

- [ ] **Step 3: Implement**

`src/services/hybrid-search.ts`:

```ts
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
```

- [ ] **Step 4: Run to pass, full suite, commit**

Run: `npx vitest run tests/hybrid-search.test.ts` — 3 PASS. Full suite green; tsc clean.

```bash
git add src/services/search.ts src/services/hybrid-search.ts tests/hybrid-search.test.ts
git commit -m "feat: hybrid FTS+cosine search with RRF merge; observations searchable

Goal: GOAL-2026-0003

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: claude-mem importer

**Files:**
- Create: `src/services/import-claude-mem.ts`
- Test: `tests/import-claude-mem.test.ts`

**Interfaces:**
- Consumes: `observations` table (with sourceRef), `listProjects`, `slugify`, better-sqlite3 (readonly open)
- Produces (from `src/services/import-claude-mem.js`):
  - `interface ImportResult { imported: number; skipped: number; projectScoped: number }`
  - `importClaudeMem(db, sourcePath?): ImportResult` — default path `~/.claude-mem/claude-mem.db`, opened `{ readonly: true, fileMustExist: true }`; maps each source observation to a Brain observation: text = `title: text` (title-only or text-only when one is missing), truncated to 2000 chars; `scopeType 'PROJECT'` + `scopeId 'project:<slug>'` when `slugify(project)` matches a registered project, else `'GLOBAL'`/null; `confidence 0.6` (historical, per §23); `sourceRef 'claude-mem:<id>'`; createdAt from source epoch/ISO when parseable else now. Rows whose sourceRef already exists are skipped (idempotent). All inserts inside one transaction.

- [ ] **Step 1: Write failing tests**

`tests/import-claude-mem.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers.js';
import { importClaudeMem } from '../src/services/import-claude-mem.js';
import { addProject } from '../src/services/projects.js';
import { observations } from '../src/db/schema.js';

function makeSourceDb(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cmimport-')), 'claude-mem.db');
  const s = new Database(p);
  s.exec(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY, project TEXT, type TEXT, title TEXT, text TEXT,
    created_at TEXT, created_at_epoch INTEGER)`);
  const ins = s.prepare('INSERT INTO observations (id, project, type, title, text, created_at_epoch) VALUES (?,?,?,?,?,?)');
  ins.run(1, 'central-brain', 'decision', 'Chose SQLite', 'zero infrastructure wins', 1756500000000);
  ins.run(2, 'unknown-proj', 'bugfix', 'Fixed timezone bug', 'UTC conversion at boundary', 1756500001000);
  ins.run(3, 'central-brain', 'discovery', null, 'FTS5 supports external content tables', 1756500002000);
  s.close();
  return p;
}

describe('claude-mem import', () => {
  it('imports with project scoping and source refs; re-run is idempotent', () => {
    const db = createTestDb();
    addProject(db, { name: 'central-brain' });
    const src = makeSourceDb();
    const r1 = importClaudeMem(db, src);
    expect(r1).toEqual({ imported: 3, skipped: 0, projectScoped: 2 });
    const rows = db.select().from(observations).all();
    expect(rows).toHaveLength(3);
    const scoped = rows.filter(r => r.scopeId === 'project:central-brain');
    expect(scoped).toHaveLength(2);
    expect(rows.every(r => r.sourceRef?.startsWith('claude-mem:'))).toBe(true);
    expect(rows.find(r => r.sourceRef === 'claude-mem:1')!.observation).toBe('Chose SQLite: zero infrastructure wins');
    expect(rows.find(r => r.sourceRef === 'claude-mem:3')!.observation).toBe('FTS5 supports external content tables');
    const r2 = importClaudeMem(db, src);
    expect(r2).toEqual({ imported: 0, skipped: 3, projectScoped: 0 });
    expect(db.select().from(observations).all()).toHaveLength(3);
  });

  it('throws when the source db does not exist', () => {
    const db = createTestDb();
    expect(() => importClaudeMem(db, '/nonexistent/claude-mem.db')).toThrow();
  });
});
```

- [ ] **Step 2: Implement**

`src/services/import-claude-mem.ts`:

```ts
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import type { BrainDb } from '../db/connection.js';
import { observations } from '../db/schema.js';
import { slugify } from '../ids.js';
import { listProjects } from './projects.js';

export interface ImportResult { imported: number; skipped: number; projectScoped: number }

interface SourceRow {
  id: number; project: string | null; type: string | null;
  title: string | null; text: string | null;
  created_at: string | null; created_at_epoch: number | null;
}

function toIso(r: SourceRow): string {
  if (r.created_at_epoch) return new Date(r.created_at_epoch).toISOString();
  if (r.created_at) {
    const t = Date.parse(r.created_at);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

export function importClaudeMem(
  db: BrainDb,
  sourcePath: string = path.join(os.homedir(), '.claude-mem', 'claude-mem.db'),
): ImportResult {
  const src = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const rows = src.prepare(
      'SELECT id, project, type, title, text, created_at, created_at_epoch FROM observations',
    ).all() as SourceRow[];
    const existing = new Set(
      db.select({ ref: observations.sourceRef }).from(observations).all()
        .map(r => r.ref).filter((r): r is string => r !== null));
    const projectIds = new Set(listProjects(db).map(p => p.id));
    let imported = 0, skipped = 0, projectScoped = 0;
    db.transaction(() => {
      for (const r of rows) {
        const ref = `claude-mem:${r.id}`;
        if (existing.has(ref)) { skipped++; continue; }
        const text = [r.title, r.text].filter(Boolean).join(': ').slice(0, 2000);
        if (!text) { skipped++; continue; }
        const slug = r.project ? slugify(r.project) : '';
        const scoped = slug !== '' && projectIds.has(slug);
        if (scoped) projectScoped++;
        db.insert(observations).values({
          observation: text,
          scopeType: scoped ? 'PROJECT' : 'GLOBAL',
          scopeId: scoped ? `project:${slug}` : null,
          sourceRef: ref, confidence: 0.6, createdAt: toIso(r),
        }).run();
        imported++;
      }
    });
    return { imported, skipped, projectScoped };
  } finally {
    src.close();
  }
}
```

NOTE for the implementer: `db.transaction(cb)` is drizzle's sync transaction on better-sqlite3 — if the installed drizzle version requires `db.transaction((tx) => ...)` with inserts on `tx`, use that form; behavior must stay all-or-nothing.

- [ ] **Step 3: Run to pass, full suite, commit**

Run: `npx vitest run tests/import-claude-mem.test.ts` — 2 PASS. Full suite green; tsc clean.

```bash
git add src/services/import-claude-mem.ts tests/import-claude-mem.test.ts
git commit -m "feat: idempotent claude-mem observation import with project scoping

Goal: GOAL-2026-0003

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: CLI + MCP wiring (async surfaces)

**Files:**
- Modify: `src/cli/index.ts`, `src/mcp/server.ts`
- Test: extend `tests/cli.test.ts`, `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `createFastEmbedder`, `reindexEmbeddings`, `hybridSearch`, `importClaudeMem`
- Produces:
  - CLI: `brain embed reindex`, `brain import claude-mem [path]`; `knowledge search`, `learning search`, `failure search`, `context search` switch to `hybridSearch` with a lazily created real embedder; `program.parse()` becomes `await program.parseAsync()` (top-level await is fine in ESM); `run()` gains an async-capable sibling `runAsync(fn: () => Promise<void>)` with identical error handling.
  - MCP: `tool()` helper awaits handler results (`await fn(a)`); new tools `brain_embed_reindex` ({}), `brain_import_claude_mem` ({ path: z.string().optional() }); `brain_knowledge_search`, `brain_learning_search`, `brain_failure_search`, `brain_context_search` handlers switch to `hybridSearch` (server holds one lazy `createFastEmbedder()`); 42 tools total.
  - IMPORTANT: `brain context get` (the SessionStart hook path) must NOT touch the embedder — no model init cost at session start.

- [ ] **Step 1: CLI changes**

In `src/cli/index.ts` add imports:

```ts
import { createFastEmbedder } from '../services/embedder.js';
import { reindexEmbeddings } from '../services/embedding-store.js';
import { hybridSearch } from '../services/hybrid-search.js';
import { importClaudeMem } from '../services/import-claude-mem.js';
```

Add after the `run` helper:

```ts
let embedderSingleton: ReturnType<typeof createFastEmbedder> | undefined;
const embedder = () => (embedderSingleton ??= createFastEmbedder());

async function runAsync(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
```

Switch the four search actions to hybrid (same options), e.g. knowledge:

```ts
know.command('search <query>').option('-n, --limit <n>')
  .action((query, o) => runAsync(async () => out(await hybridSearch(db(), embedder(), query, {
    types: ['knowledge'], limit: o.limit ? Number(o.limit) : undefined,
  }))));
```

(learning → types ['learning']; failure → types ['failure']; context search → no types filter.)

Add new groups before `// ---- model routing ----`:

```ts
// ---- embeddings & import ----
const embedCmd = program.command('embed');
embedCmd.command('reindex').description('Embed all missing/stale rows locally (ONNX)')
  .action(() => runAsync(async () => out(await reindexEmbeddings(db(), embedder()))));

const importCmd = program.command('import');
importCmd.command('claude-mem [path]').description('One-time idempotent claude-mem import (§79)')
  .action((p) => runAsync(async () => {
    const res = importClaudeMem(db(), p);
    out(res);
  }));
```

Change the last line `program.parse();` to `await program.parseAsync();`.

- [ ] **Step 2: MCP changes**

In `src/mcp/server.ts`: in the `tool()` helper change `fn(args)` to `await fn(args)`; add imports (embedder, reindexEmbeddings, hybridSearch, importClaudeMem); add inside `buildServer` before tool registrations: `let emb: ReturnType<typeof createFastEmbedder> | undefined; const embedder = () => (emb ??= createFastEmbedder());`; switch the four search tool handlers to `(a) => hybridSearch(db, embedder(), a.query, { types: [...], limit: a.limit })` (context_search without types); add before `return server;`:

```ts
  tool('brain_embed_reindex', 'Embed all missing/stale rows locally (ONNX)', {},
    () => reindexEmbeddings(db, embedder()));
  tool('brain_import_claude_mem', 'One-time idempotent claude-mem observation import', {
    path: z.string().optional(),
  }, (a) => importClaudeMem(db, a.path));
```

- [ ] **Step 3: Tests**

tests/mcp.test.ts: add `'brain_embed_reindex'` to the tool-surface array. (The search tools now lazily create a real embedder only when CALLED — the existing tests never call them, so no model download in tests.)
tests/cli.test.ts: append (options-second-arg style):

```ts
  it('phase 3: import + reindex + hybrid search e2e', { timeout: 300000 }, () => {
    brain('knowledge', 'add', 'TrueNAS box runs the Seafile document sync service', '-s', 'GLOBAL');
    const re = brain('embed', 'reindex');
    expect(re.embedded).toBeGreaterThan(0);
    const hits = brain('knowledge', 'search', 'network storage appliance for syncing files');
    expect(hits.some((h: any) => h.text.includes('Seafile'))).toBe(true);
  });
```

(This e2e uses the real model — slow on first-ever run, cached after.)

- [ ] **Step 4: Run everything, build, commit**

`npx tsc --noEmit` clean; full `npx vitest run` green; `npm run build`.

```bash
git add src/cli/index.ts src/mcp/server.ts tests/cli.test.ts tests/mcp.test.ts
git commit -m "feat: hybrid search on CLI/MCP surfaces, embed reindex, claude-mem import commands

Goal: GOAL-2026-0003

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Live run — reindex, import 10.8k observations, verify, complete

**Files:**
- Modify: `README.md`
- No src changes — runs the system for real (live DB migration will auto-snapshot first: expected, verify it happened).

- [ ] **Step 1: Lock and start the goal; migrate live DB**

```bash
node dist/cli/index.js goal lock GOAL-2026-0003
node dist/cli/index.js goal start GOAL-2026-0003
ls ~/.central-brain/backups/ | tail -2   # pre-migration auto-snapshot should appear after first CLI call
```

- [ ] **Step 2: Reindex existing memory, then import**

```bash
node dist/cli/index.js embed reindex          # embeds existing knowledge/learnings/goals/etc.
node dist/cli/index.js import claude-mem      # ~10.8k rows; report imported/skipped/projectScoped
node dist/cli/index.js embed reindex          # embeds the imported observations (few minutes, local CPU)
node dist/cli/index.js import claude-mem      # idempotency proof: imported 0
```

Record all four outputs in the report.

- [ ] **Step 3: Semantic spot checks (record actual outputs)**

```bash
node dist/cli/index.js context search "voice agent platform deployment" | head -30
node dist/cli/index.js knowledge search "file syncing server" | head -20
```

Expect echo-app/voiceflowx-related and Seafile/TrueNAS-related hits respectively, including imported claude-mem observations for the first.

- [ ] **Step 4: Verify criteria via the verification path, complete, backup**

Get requirement ids from `goal show GOAL-2026-0003`; `verify add` each with honest actuals (suite run, reindex outputs, hybrid hit evidence, import counts + idempotency, CLI/MCP surface). Then `verify goal` (allRequiredPassed true) → `goal complete GOAL-2026-0003` → `backup`.

- [ ] **Step 5: README + learnings + commit**

Append to README commands:

```markdown
- Semantic: `brain embed reindex` (local ONNX, model cached in ~/.central-brain/models); all `search` commands are hybrid FTS+vector
- Import: `brain import claude-mem` (idempotent; observations carry `claude-mem:<id>` refs)
```

```bash
node dist/cli/index.js learning add "After bulk-adding memory (import/scan), run brain embed reindex so semantic search covers it" -s GLOBAL
git add README.md
git commit -m "docs: phase 3 command surface

Goal: GOAL-2026-0003

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification (whole-phase)

- Full suite green, tsc clean, build clean
- Live DB migrated with pre-migration auto-snapshot present
- 10.8k-row import completed; re-run imports 0; observations searchable
- A paraphrase query (no keyword overlap) returns the right fact via hybrid search — recorded evidence
- GOAL-2026-0003 COMPLETED through `verify` (no force); backup taken
- SessionStart hook still fast (context get path never touches the embedder)

## Out of scope

- sqlite-vec / ANN indexing (revisit if brain.db vectors exceed ~100k rows)
- Embedding-on-write hooks (reindex-on-demand is the v1 contract)
- Re-ranking models, remote embedding backends (interface-compatible swaps later)

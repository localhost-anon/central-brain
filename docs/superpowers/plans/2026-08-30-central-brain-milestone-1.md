# Central Brain Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the persistent Central Brain — SQLite (WAL + FTS5) memory, full service layer, `brain` CLI, MCP server, and Claude Code session hooks — per ARCHITECTURE.md v0.2 Milestone 1 (§76–77).

**Architecture:** A single service layer (pure functions over a Drizzle/better-sqlite3 database handle) is wrapped twice: by a Commander CLI (`brain ...`) and by an MCP stdio server (`brain_*` tools). All search goes through FTS5 virtual tables kept in sync by triggers. The database lives at `~/.central-brain/brain.db` (`BRAIN_DB` overrides), never in the repo.

**Tech Stack:** Node.js ≥ 20, TypeScript (strict, ESM/NodeNext), better-sqlite3, Drizzle ORM + drizzle-kit, Zod, Commander.js, @modelcontextprotocol/sdk, vitest, tsx.

**Spec:** `ARCHITECTURE.md` (v0.2, in repo root). Section references (§N) below point into it.

## Global Constraints

- ESM only: `"type": "module"`, tsconfig `module`/`moduleResolution` = `NodeNext`, relative imports carry `.js` extensions.
- DB path: default `~/.central-brain/brain.db`; `BRAIN_DB` env var overrides; `:memory:` allowed for tests (§17.1). Never create `brain.db` inside the repo.
- Every connection sets `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON` (§17.2).
- All search is FTS5 with bm25 ranking — `LIKE` search is forbidden (§17.3).
- Reference fields (`scope_id`, relationship endpoints, `artifacts.entity_id`) use type-prefixed IDs: `project:x`, `repo:x`, `goal:GOAL-...`, `entity:x`, `wu:WU-...` (§16.1).
- Goal IDs: `GOAL-<year>-<zero-padded 4-digit seq>` e.g. `GOAL-2026-0001`. Work unit IDs: goal ID with `GOAL`→`WU` plus `.<seq>` e.g. `WU-2026-0001.3`.
- Timestamps are ISO-8601 UTC strings from `new Date().toISOString()`.
- Never store secrets in the DB (§69). Knowledge search/context return only `status='active'` rows by default (§28).
- Requirement statuses: `PENDING|PASSED|FAILED|NOT_APPLICABLE`; goal cannot complete while a required success criterion is not `PASSED`/`NOT_APPLICABLE` (§64).
- Tests use vitest against an in-memory migrated DB via `tests/helpers.ts#createTestDb` — no test touches `~/.central-brain`.
- Commit after every task; append `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` to every commit message.
- Git identity: this is a personal repo — before the first commit copy the anonymous identity from an existing personal repo (`git -C ~/Projects/ai-fleet-research-agent config user.name` / `user.email`) into local `git config`; do not use the work identity.

---

### Task 1: Repository scaffold & toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `drizzle.config.ts`, `.gitignore`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a git repo where `npx tsc --noEmit` and `npx vitest run` succeed; all later tasks assume these dependencies are installed.

- [ ] **Step 1: Init git with the anonymous identity and commit the docs**

```bash
cd $HOME/Projects/central-brain
git init
git config user.name  "$(git -C ~/Projects/ai-fleet-research-agent config user.name)"
git config user.email "$(git -C ~/Projects/ai-fleet-research-agent config user.email)"
git add ARCHITECTURE.md CLAUDE.md docs/
git commit -m "docs: architecture spec v0.2 and milestone 1 plan

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(If the ai-fleet repo has no local identity set, fall back to the global `git config user.name`/`user.email` — just never the EAFI work identity.)

- [ ] **Step 2: Scaffold npm project and install dependencies**

```bash
npm init -y
npm install better-sqlite3 drizzle-orm zod commander nanoid @modelcontextprotocol/sdk
npm install -D typescript tsx @types/node @types/better-sqlite3 drizzle-kit vitest
```

- [ ] **Step 3: Write config files**

`package.json` — edit the generated file so it contains exactly these top-level fields (keep the generated `dependencies`/`devDependencies`):

```json
{
  "name": "central-brain",
  "version": "0.1.0",
  "type": "module",
  "bin": { "brain": "bin/brain.js", "brain-claude": "bin/brain-claude" },
  "scripts": {
    "brain": "tsx src/cli/index.ts",
    "mcp": "tsx src/mcp/server.ts",
    "build": "tsc",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src"]
}
```

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
```

`.gitignore`:

```text
node_modules/
dist/
*.db
*.db-wal
*.db-shm
.env
```

- [ ] **Step 4: Verify toolchain**

Run: `npx tsc --noEmit` (expect: exits 0 — no sources yet) and `npx vitest run` (expect: "No test files found" exit; that's fine).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json drizzle.config.ts .gitignore
git commit -m "chore: scaffold TypeScript/ESM toolchain

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Schema, migrations, FTS5, connection, test helper

**Files:**
- Create: `src/db/schema.ts`, `src/db/connection.ts`, `drizzle/` (generated + one custom FTS migration), `tests/helpers.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: Task 1 toolchain
- Produces:
  - `openDb(dbPath?: string): BrainDb` and `migrateDb(db: BrainDb): void` from `src/db/connection.js`; `resolveDbPath(): string`
  - `BrainDb` type (drizzle better-sqlite3 instance with `schema` attached; raw handle on `db.$client`)
  - all table objects exported from `src/db/schema.js` with the exact column names below
  - `createTestDb(): BrainDb` from `tests/helpers.js`

- [ ] **Step 1: Write the Drizzle schema (all tables from spec §18–35 + §21.1 + §23)**

`src/db/schema.ts`:

```ts
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  objective: text('objective').notNull(),
  status: text('status').notNull().default('DRAFT'),
  autonomyLevel: text('autonomy_level').notNull().default('full'),
  clarificationStatus: text('clarification_status').notNull().default('pending'),
  riskLevel: text('risk_level'),
  complexity: text('complexity'),
  contractSnapshot: text('contract_snapshot'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lockedAt: text('locked_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

export const goalRequirements = sqliteTable('goal_requirements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id').notNull().references(() => goals.id),
  requirementType: text('requirement_type').notNull(),
  description: text('description').notNull(),
  priority: text('priority').notNull().default('required'),
  status: text('status').notNull().default('PENDING'),
  statusReason: text('status_reason'),
});

export const goalQuestions = sqliteTable('goal_questions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id').notNull().references(() => goals.id),
  question: text('question').notNull(),
  answer: text('answer'),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  answeredAt: text('answered_at'),
});

export const decisions = sqliteTable('decisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  scopeType: text('scope_type'),
  scopeId: text('scope_id'),
  decision: text('decision').notNull(),
  reason: text('reason'),
  alternatives: text('alternatives'),
  riskLevel: text('risk_level'),
  reversible: integer('reversible').notNull().default(1),
  executor: text('executor'),
  createdAt: text('created_at').notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id').references(() => goals.id),
  decisionId: integer('decision_id').references(() => decisions.id),
  action: text('action').notNull(),
  riskLevel: text('risk_level').notNull(),
  status: text('status').notNull().default('pending'),
  requestedAt: text('requested_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const workUnits = sqliteTable('work_units', {
  id: text('id').primaryKey(),
  goalId: text('goal_id').notNull().references(() => goals.id),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  description: text('description'),
  workType: text('work_type'),
  complexity: text('complexity'),
  status: text('status').notNull().default('PENDING'),
  priority: integer('priority').notNull().default(100),
  attemptCount: integer('attempt_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

export const workUnitDependencies = sqliteTable('work_unit_dependencies', {
  workUnitId: text('work_unit_id').notNull(),
  dependsOn: text('depends_on').notNull(),
}, (t) => [primaryKey({ columns: [t.workUnitId, t.dependsOn] })]);

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  rootPath: text('root_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id),
  name: text('name').notNull(),
  path: text('path'),
  remoteUrl: text('remote_url'),
  defaultBranch: text('default_branch'),
  language: text('language'),
  framework: text('framework'),
  createdAt: text('created_at').notNull(),
});

export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const relationships = sqliteTable('relationships', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('source_id').notNull(),
  relationshipType: text('relationship_type').notNull(),
  targetId: text('target_id').notNull(),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
});

export const knowledge = sqliteTable('knowledge', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scopeType: text('scope_type').notNull(),
  scopeId: text('scope_id'),
  category: text('category'),
  statement: text('statement').notNull(),
  confidence: real('confidence').notNull().default(1.0),
  sourceType: text('source_type'),
  sourceReference: text('source_reference'),
  status: text('status').notNull().default('active'),
  supersededBy: integer('superseded_by'),
  createdAt: text('created_at').notNull(),
  lastVerifiedAt: text('last_verified_at'),
});

export const learnings = sqliteTable('learnings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scopeType: text('scope_type'),
  scopeId: text('scope_id'),
  trigger: text('trigger'),
  learning: text('learning').notNull(),
  usefulnessScore: real('usefulness_score').notNull().default(1),
  timesUsed: integer('times_used').notNull().default(0),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
});

export const observations = sqliteTable('observations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  scopeType: text('scope_type'),
  scopeId: text('scope_id'),
  observation: text('observation').notNull(),
  confidence: real('confidence').notNull().default(1),
  createdAt: text('created_at').notNull(),
});

export const failures = sqliteTable('failures', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  failureType: text('failure_type'),
  errorMessage: text('error_message'),
  context: text('context'),
  resolved: integer('resolved').notNull().default(0),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const failureSolutions = sqliteTable('failure_solutions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  failureId: integer('failure_id').notNull().references(() => failures.id),
  solution: text('solution').notNull(),
  successful: integer('successful'),
  createdAt: text('created_at').notNull(),
});

export const executions = sqliteTable('executions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  executor: text('executor'),
  actionType: text('action_type'),
  command: text('command'),
  result: text('result'),
  exitCode: integer('exit_code'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

export const artifacts = sqliteTable('artifacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  artifactType: text('artifact_type'),
  path: text('path'),
  entityId: text('entity_id'),
  changeType: text('change_type'),
  createdAt: text('created_at').notNull(),
});

export const verificationRuns = sqliteTable('verification_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  requirementId: integer('requirement_id').references(() => goalRequirements.id),
  verificationType: text('verification_type'),
  command: text('command'),
  expectedResult: text('expected_result'),
  actualResult: text('actual_result'),
  passed: integer('passed'),
  createdAt: text('created_at').notNull(),
});
```

- [ ] **Step 2: Write the connection module**

`src/db/connection.ts`:

```ts
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type BrainDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function resolveDbPath(): string {
  return process.env.BRAIN_DB ?? path.join(os.homedir(), '.central-brain', 'brain.db');
}

export function packageRoot(): string {
  // src/db/connection.ts -> repo root (works from dist/db/connection.js too)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function openDb(dbPath: string = resolveDbPath()): BrainDb {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema }) as BrainDb;
}

export function migrateDb(db: BrainDb): void {
  migrate(db, { migrationsFolder: path.join(packageRoot(), 'drizzle') });
}
```

- [ ] **Step 3: Generate the schema migration, then add the custom FTS5 migration**

```bash
npx drizzle-kit generate
npx drizzle-kit generate --custom --name=fts
```

The second command creates an empty `drizzle/000X_fts.sql`. Fill it with (pattern shown in full for `knowledge` and `goals`; repeat the same three-trigger pattern for `learnings`(fields: `learning`, `trigger`), `decisions`(fields: `decision`, `reason`), `failures`(fields: `error_message`, `context`)):

```sql
CREATE VIRTUAL TABLE knowledge_fts USING fts5(statement, category, content='knowledge', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, statement, category) VALUES (new.id, new.statement, new.category);
END;
--> statement-breakpoint
CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, statement, category) VALUES ('delete', old.id, old.statement, old.category);
END;
--> statement-breakpoint
CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, statement, category) VALUES ('delete', old.id, old.statement, old.category);
  INSERT INTO knowledge_fts(rowid, statement, category) VALUES (new.id, new.statement, new.category);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE goals_fts USING fts5(title, objective, content='goals', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER goals_ai AFTER INSERT ON goals BEGIN
  INSERT INTO goals_fts(rowid, title, objective) VALUES (new.rowid, new.title, new.objective);
END;
--> statement-breakpoint
CREATE TRIGGER goals_ad AFTER DELETE ON goals BEGIN
  INSERT INTO goals_fts(goals_fts, rowid, title, objective) VALUES ('delete', old.rowid, old.title, old.objective);
END;
--> statement-breakpoint
CREATE TRIGGER goals_au AFTER UPDATE ON goals BEGIN
  INSERT INTO goals_fts(goals_fts, rowid, title, objective) VALUES ('delete', old.rowid, old.title, old.objective);
  INSERT INTO goals_fts(rowid, title, objective) VALUES (new.rowid, new.title, new.objective);
END;
```

Note: `learnings.trigger` is a reserved-looking word — quote it as `"trigger"` in the FTS DDL and trigger bodies.

- [ ] **Step 4: Write the test helper and a failing DB test**

`tests/helpers.ts`:

```ts
import { openDb, migrateDb, type BrainDb } from '../src/db/connection.js';

export function createTestDb(): BrainDb {
  const db = openDb(':memory:');
  migrateDb(db);
  return db;
}
```

`tests/db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';

describe('database', () => {
  it('applies migrations: core and FTS tables exist', () => {
    const db = createTestDb();
    const names = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of ['goals', 'goal_requirements', 'work_units', 'work_unit_dependencies',
      'projects', 'repositories', 'entities', 'relationships', 'knowledge', 'learnings',
      'observations', 'failures', 'failure_solutions', 'executions', 'artifacts',
      'verification_runs', 'decisions', 'approvals', 'goal_questions']) {
      expect(names, `missing table ${t}`).toContain(t);
    }
    for (const f of ['knowledge_fts', 'learnings_fts', 'decisions_fts', 'failures_fts', 'goals_fts']) {
      expect(names, `missing fts table ${f}`).toContain(f);
    }
  });

  it('fts triggers index inserted rows', () => {
    const db = createTestDb();
    db.$client.prepare(
      "INSERT INTO knowledge (scope_type, statement, created_at) VALUES ('GLOBAL', 'Prospera API uses PostgreSQL', ?)"
    ).run(new Date().toISOString());
    const hits = db.$client.prepare("SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH 'postgresql'").all();
    expect(hits.length).toBe(1);
  });

  it('enforces WAL-compatible pragmas on file DBs and foreign keys everywhere', () => {
    const db = createTestDb();
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail, then pass**

Run: `npx vitest run tests/db.test.ts` — first run before Step 1–3 files exist would fail; after writing everything expect: 3 PASS. If the FTS migration was written correctly the second test passes; a missing trigger shows up here.

- [ ] **Step 6: Verify typecheck and commit**

```bash
npx tsc --noEmit
git add src/db drizzle tests package.json
git commit -m "feat: SQLite schema, migrations, FTS5 index, connection layer

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: ID & slug utilities

**Files:**
- Create: `src/ids.ts`
- Test: `tests/ids.test.ts`

**Interfaces:**
- Consumes: `BrainDb` from Task 2
- Produces (from `src/ids.js`):
  - `nextGoalId(db: BrainDb, now?: Date): string` → `GOAL-2026-0001`, `GOAL-2026-0002`, ... (per-year sequence)
  - `workUnitIdFor(db: BrainDb, goalId: string): string` → `WU-2026-0001.1`, `.2`, ...
  - `prefixedId(type: 'project'|'repo'|'goal'|'entity'|'wu', id: string): string`
  - `parsePrefixedId(s: string): { type: string; id: string }` (throws on unprefixed input)
  - `slugify(name: string): string` → lowercase, alphanumerics and dashes

- [ ] **Step 1: Write failing tests**

`tests/ids.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { nextGoalId, workUnitIdFor, prefixedId, parsePrefixedId, slugify } from '../src/ids.js';
import { goals, workUnits } from '../src/db/schema.js';

const now = () => new Date().toISOString();

describe('ids', () => {
  it('generates sequential per-year goal ids', () => {
    const db = createTestDb();
    const d = new Date('2026-08-30T00:00:00Z');
    const id1 = nextGoalId(db, d);
    expect(id1).toBe('GOAL-2026-0001');
    db.insert(goals).values({ id: id1, title: 't', objective: 'o', createdAt: now(), updatedAt: now() }).run();
    expect(nextGoalId(db, d)).toBe('GOAL-2026-0002');
  });

  it('generates work unit ids scoped to the goal', () => {
    const db = createTestDb();
    db.insert(goals).values({ id: 'GOAL-2026-0001', title: 't', objective: 'o', createdAt: now(), updatedAt: now() }).run();
    const wu1 = workUnitIdFor(db, 'GOAL-2026-0001');
    expect(wu1).toBe('WU-2026-0001.1');
    db.insert(workUnits).values({ id: wu1, goalId: 'GOAL-2026-0001', title: 'w', createdAt: now() }).run();
    expect(workUnitIdFor(db, 'GOAL-2026-0001')).toBe('WU-2026-0001.2');
  });

  it('formats and parses prefixed ids', () => {
    expect(prefixedId('project', 'prospera')).toBe('project:prospera');
    expect(parsePrefixedId('repo:prospera-api')).toEqual({ type: 'repo', id: 'prospera-api' });
    expect(() => parsePrefixedId('prospera')).toThrow();
  });

  it('slugifies names', () => {
    expect(slugify('Prospera API!')).toBe('prospera-api');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ids.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/ids.ts`:

```ts
import { like } from 'drizzle-orm';
import type { BrainDb } from './db/connection.js';
import { goals, workUnits } from './db/schema.js';

const PREFIX_TYPES = ['project', 'repo', 'goal', 'entity', 'wu'] as const;
export type PrefixType = (typeof PREFIX_TYPES)[number];

export function nextGoalId(db: BrainDb, nowDate: Date = new Date()): string {
  const year = nowDate.getUTCFullYear();
  const rows = db.select({ id: goals.id }).from(goals).where(like(goals.id, `GOAL-${year}-%`)).all();
  const max = rows.reduce((m, r) => Math.max(m, Number(r.id.split('-')[2]) || 0), 0);
  return `GOAL-${year}-${String(max + 1).padStart(4, '0')}`;
}

export function workUnitIdFor(db: BrainDb, goalId: string): string {
  const base = goalId.replace(/^GOAL/, 'WU');
  const rows = db.select({ id: workUnits.id }).from(workUnits).where(like(workUnits.id, `${base}.%`)).all();
  const max = rows.reduce((m, r) => Math.max(m, Number(r.id.slice(base.length + 1)) || 0), 0);
  return `${base}.${max + 1}`;
}

export function prefixedId(type: PrefixType, id: string): string {
  return `${type}:${id}`;
}

export function parsePrefixedId(s: string): { type: PrefixType; id: string } {
  const i = s.indexOf(':');
  const type = i > 0 ? (s.slice(0, i) as PrefixType) : undefined;
  if (!type || !PREFIX_TYPES.includes(type) || i === s.length - 1) {
    throw new Error(`Invalid prefixed id "${s}". Expected <${PREFIX_TYPES.join('|')}>:<id> (ARCHITECTURE.md §16.1).`);
  }
  return { type, id: s.slice(i + 1) };
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/ids.test.ts` — Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ids.ts tests/ids.test.ts
git commit -m "feat: goal/work-unit id generation and prefixed-id addressing

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Goals & requirements service

**Files:**
- Create: `src/services/goals.ts`
- Test: `tests/goals.test.ts`

**Interfaces:**
- Consumes: `createTestDb`, `nextGoalId`, schema tables
- Produces (from `src/services/goals.js`):
  - `createGoal(db, input: { title: string; objective: string; autonomyLevel?: string; riskLevel?: string; complexity?: string }): Goal`
  - `getGoal(db, id: string): Goal` (throws if missing) / `listGoals(db, opts?: { status?: string }): Goal[]`
  - `currentGoal(db): Goal | undefined` — most recently updated goal whose status is in `ACTIVE_STATUSES = ['LOCKED','PLANNING','EXECUTING','VERIFYING','BLOCKED']`
  - `addRequirement(db, goalId, input: { type: string; description: string; priority?: 'required'|'optional' }): Requirement` — throws `GoalLockedError` if goal is locked
  - `setRequirementStatus(db, requirementId: number, status: 'PENDING'|'PASSED'|'FAILED'|'NOT_APPLICABLE', reason?: string): void` — `NOT_APPLICABLE` without reason throws
  - `lockGoal(db, id): Goal` — snapshots contract JSON into `contractSnapshot`, sets `lockedAt`, status `LOCKED`
  - `startGoal(db, id): Goal` (LOCKED→EXECUTING), `blockGoal(db, id, reason: string): Goal` (→BLOCKED + observation row)
  - `completeGoal(db, id, opts?: { force?: boolean }): Goal` — throws `IncompleteCriteriaError` listing unmet required success criteria unless `force`
  - `Goal` = row type of `goals` table (`typeof goals.$inferSelect`); `Requirement` = `typeof goalRequirements.$inferSelect`

- [ ] **Step 1: Write failing tests**

`tests/goals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import {
  createGoal, getGoal, listGoals, currentGoal, addRequirement,
  setRequirementStatus, lockGoal, startGoal, blockGoal, completeGoal,
} from '../src/services/goals.js';
import { observations, goalRequirements } from '../src/db/schema.js';

describe('goals service', () => {
  it('creates a DRAFT goal with a generated id', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Add SSO', objective: 'Users authenticate with Microsoft' });
    expect(g.id).toMatch(/^GOAL-\d{4}-\d{4}$/);
    expect(g.status).toBe('DRAFT');
    expect(getGoal(db, g.id).title).toBe('Add SSO');
  });

  it('lock snapshots the contract and freezes requirements', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Add SSO', objective: 'MS auth works' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'MS login works' });
    const locked = lockGoal(db, g.id);
    expect(locked.status).toBe('LOCKED');
    expect(locked.lockedAt).toBeTruthy();
    const snap = JSON.parse(locked.contractSnapshot!);
    expect(snap.objective).toBe('MS auth works');
    expect(snap.requirements).toHaveLength(1);
    expect(() => addRequirement(db, g.id, { type: 'constraint', description: 'late add' }))
      .toThrow(/locked/i);
  });

  it('refuses completion while required success criteria are unmet', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'tests pass' });
    lockGoal(db, g.id);
    startGoal(db, g.id);
    expect(() => completeGoal(db, g.id)).toThrow(/tests pass/);
    setRequirementStatus(db, r.id, 'PASSED');
    expect(completeGoal(db, g.id).status).toBe('COMPLETED');
  });

  it('NOT_APPLICABLE requires a reason', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'x' });
    expect(() => setRequirementStatus(db, r.id, 'NOT_APPLICABLE')).toThrow(/reason/i);
    setRequirementStatus(db, r.id, 'NOT_APPLICABLE', 'superseded by design change');
    const row = db.select().from(goalRequirements).all()[0];
    expect(row.status).toBe('NOT_APPLICABLE');
  });

  it('blockGoal records an observation; currentGoal returns the active goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(currentGoal(db)).toBeUndefined(); // DRAFT is not active
    lockGoal(db, g.id);
    expect(currentGoal(db)?.id).toBe(g.id);
    blockGoal(db, g.id, 'AWS auth expired');
    expect(getGoal(db, g.id).status).toBe('BLOCKED');
    expect(db.select().from(observations).all()[0].observation).toContain('AWS auth expired');
    expect(listGoals(db, { status: 'BLOCKED' })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/goals.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/goals.ts`:

```ts
import { desc, eq, inArray } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goals, goalRequirements, observations } from '../db/schema.js';
import { nextGoalId } from '../ids.js';

export type Goal = typeof goals.$inferSelect;
export type Requirement = typeof goalRequirements.$inferSelect;

export const ACTIVE_STATUSES = ['LOCKED', 'PLANNING', 'EXECUTING', 'VERIFYING', 'BLOCKED'];
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

export class GoalLockedError extends Error {}
export class IncompleteCriteriaError extends Error {}

const now = () => new Date().toISOString();

export function createGoal(
  db: BrainDb,
  input: { title: string; objective: string; autonomyLevel?: string; riskLevel?: string; complexity?: string },
): Goal {
  const id = nextGoalId(db);
  const ts = now();
  db.insert(goals).values({
    id, title: input.title, objective: input.objective,
    autonomyLevel: input.autonomyLevel ?? 'full', riskLevel: input.riskLevel ?? null,
    complexity: input.complexity ?? null,
    status: 'DRAFT', createdAt: ts, updatedAt: ts,
  }).run();
  return getGoal(db, id);
}

export function getGoal(db: BrainDb, id: string): Goal {
  const g = db.select().from(goals).where(eq(goals.id, id)).get();
  if (!g) throw new Error(`Goal not found: ${id}`);
  return g;
}

export function listGoals(db: BrainDb, opts: { status?: string } = {}): Goal[] {
  const q = db.select().from(goals);
  const rows = opts.status ? q.where(eq(goals.status, opts.status)).all() : q.all();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function currentGoal(db: BrainDb): Goal | undefined {
  return db.select().from(goals)
    .where(inArray(goals.status, ACTIVE_STATUSES))
    .orderBy(desc(goals.updatedAt))
    .get();
}

export function listRequirements(db: BrainDb, goalId: string): Requirement[] {
  return db.select().from(goalRequirements).where(eq(goalRequirements.goalId, goalId)).all();
}

export function addRequirement(
  db: BrainDb, goalId: string,
  input: { type: string; description: string; priority?: 'required' | 'optional' },
): Requirement {
  const g = getGoal(db, goalId);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${goalId} is locked; requirements are frozen (§18).`);
  const res = db.insert(goalRequirements).values({
    goalId, requirementType: input.type, description: input.description,
    priority: input.priority ?? 'required',
  }).run();
  return db.select().from(goalRequirements)
    .where(eq(goalRequirements.id, Number(res.lastInsertRowid))).get()!;
}

export function setRequirementStatus(
  db: BrainDb, requirementId: number,
  status: 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_APPLICABLE', reason?: string,
): void {
  if (status === 'NOT_APPLICABLE' && !reason) {
    throw new Error('NOT_APPLICABLE requires a status reason (§19).');
  }
  db.update(goalRequirements)
    .set({ status, statusReason: reason ?? null })
    .where(eq(goalRequirements.id, requirementId)).run();
}

function setStatus(db: BrainDb, id: string, status: string, extra: Partial<typeof goals.$inferInsert> = {}): Goal {
  db.update(goals).set({ status, updatedAt: now(), ...extra }).where(eq(goals.id, id)).run();
  return getGoal(db, id);
}

export function lockGoal(db: BrainDb, id: string): Goal {
  const g = getGoal(db, id);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${id} is already locked.`);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot lock.`);
  const snapshot = JSON.stringify({
    objective: g.objective,
    requirements: listRequirements(db, id).map(r => ({
      type: r.requirementType, description: r.description, priority: r.priority,
    })),
  });
  return setStatus(db, id, 'LOCKED', {
    lockedAt: now(), contractSnapshot: snapshot, clarificationStatus: 'complete',
  });
}

export function startGoal(db: BrainDb, id: string): Goal {
  const g = getGoal(db, id);
  if (!g.lockedAt) throw new Error(`Goal ${id} must be locked before starting (§10).`);
  return setStatus(db, id, 'EXECUTING', { startedAt: g.startedAt ?? now() });
}

export function blockGoal(db: BrainDb, id: string, reason: string): Goal {
  getGoal(db, id);
  db.insert(observations).values({
    goalId: id, scopeType: 'GOAL', scopeId: `goal:${id}`,
    observation: `Goal blocked: ${reason}`, createdAt: now(),
  }).run();
  return setStatus(db, id, 'BLOCKED');
}

export function completeGoal(db: BrainDb, id: string, opts: { force?: boolean } = {}): Goal {
  getGoal(db, id);
  if (!opts.force) {
    const unmet = listRequirements(db, id).filter(r =>
      r.requirementType === 'success_criterion' && r.priority === 'required' &&
      !['PASSED', 'NOT_APPLICABLE'].includes(r.status));
    if (unmet.length > 0) {
      throw new IncompleteCriteriaError(
        `Cannot complete ${id}; unmet required success criteria (§64): ` +
        unmet.map(r => `#${r.id} ${r.description} [${r.status}]`).join('; '));
    }
  }
  return setStatus(db, id, 'COMPLETED', { completedAt: now() });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/goals.test.ts` — Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/goals.ts tests/goals.test.ts
git commit -m "feat: goals service with contract lock and completion rule

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Work units service

**Files:**
- Create: `src/services/work.ts`
- Test: `tests/work.test.ts`

**Interfaces:**
- Consumes: `workUnitIdFor`, `getGoal`, schema tables
- Produces (from `src/services/work.js`):
  - `createWorkUnit(db, input: { goalId: string; title: string; description?: string; workType?: string; complexity?: string; priority?: number; parentId?: string; dependsOn?: string[] }): WorkUnit`
  - `updateWorkUnit(db, id: string, patch: { status?: string; title?: string; description?: string; priority?: number }): WorkUnit` — sets `startedAt` on first `RUNNING`, `completedAt` on `COMPLETED`, increments `attemptCount` on `RUNNING`
  - `listWorkUnits(db, goalId: string): WorkUnit[]`
  - `readyWorkUnits(db, goalId: string): WorkUnit[]` — status `PENDING`/`READY` and every dependency `COMPLETED` or `SKIPPED`, ordered by `priority` asc
  - `WorkUnit` = `typeof workUnits.$inferSelect`

- [ ] **Step 1: Write failing tests**

`tests/work.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal } from '../src/services/goals.js';
import { createWorkUnit, updateWorkUnit, listWorkUnits, readyWorkUnits } from '../src/services/work.js';

describe('work units', () => {
  it('creates sequenced work units under a goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const wu1 = createWorkUnit(db, { goalId: g.id, title: 'Inspect auth' });
    const wu2 = createWorkUnit(db, { goalId: g.id, title: 'Modify backend' });
    expect(wu1.id.endsWith('.1')).toBe(true);
    expect(wu2.id.endsWith('.2')).toBe(true);
    expect(listWorkUnits(db, g.id)).toHaveLength(2);
  });

  it('readyWorkUnits respects dependencies', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const a = createWorkUnit(db, { goalId: g.id, title: 'A' });
    const b = createWorkUnit(db, { goalId: g.id, title: 'B', dependsOn: [a.id] });
    expect(readyWorkUnits(db, g.id).map(w => w.id)).toEqual([a.id]);
    updateWorkUnit(db, a.id, { status: 'COMPLETED' });
    expect(readyWorkUnits(db, g.id).map(w => w.id)).toEqual([b.id]);
  });

  it('tracks lifecycle timestamps and attempts', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const wu = createWorkUnit(db, { goalId: g.id, title: 'A' });
    const running = updateWorkUnit(db, wu.id, { status: 'RUNNING' });
    expect(running.startedAt).toBeTruthy();
    expect(running.attemptCount).toBe(1);
    const done = updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    expect(done.completedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/work.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/work.ts`:

```ts
import { asc, eq, inArray } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { workUnits, workUnitDependencies } from '../db/schema.js';
import { workUnitIdFor } from '../ids.js';
import { getGoal } from './goals.js';

export type WorkUnit = typeof workUnits.$inferSelect;

const now = () => new Date().toISOString();

export function createWorkUnit(db: BrainDb, input: {
  goalId: string; title: string; description?: string; workType?: string;
  complexity?: string; priority?: number; parentId?: string; dependsOn?: string[];
}): WorkUnit {
  getGoal(db, input.goalId);
  const id = workUnitIdFor(db, input.goalId);
  db.insert(workUnits).values({
    id, goalId: input.goalId, title: input.title,
    description: input.description ?? null, workType: input.workType ?? null,
    complexity: input.complexity ?? null,
    priority: input.priority ?? 100, parentId: input.parentId ?? null,
    status: 'PENDING', createdAt: now(),
  }).run();
  for (const dep of input.dependsOn ?? []) {
    db.insert(workUnitDependencies).values({ workUnitId: id, dependsOn: dep }).run();
  }
  return getWorkUnit(db, id);
}

export function getWorkUnit(db: BrainDb, id: string): WorkUnit {
  const wu = db.select().from(workUnits).where(eq(workUnits.id, id)).get();
  if (!wu) throw new Error(`Work unit not found: ${id}`);
  return wu;
}

export function updateWorkUnit(db: BrainDb, id: string, patch: {
  status?: string; title?: string; description?: string; priority?: number;
}): WorkUnit {
  const wu = getWorkUnit(db, id);
  const set: Partial<typeof workUnits.$inferInsert> = { ...patch };
  if (patch.status === 'RUNNING') {
    set.startedAt = wu.startedAt ?? now();
    set.attemptCount = wu.attemptCount + 1;
  }
  if (patch.status === 'COMPLETED') set.completedAt = now();
  db.update(workUnits).set(set).where(eq(workUnits.id, id)).run();
  return getWorkUnit(db, id);
}

export function listWorkUnits(db: BrainDb, goalId: string): WorkUnit[] {
  return db.select().from(workUnits)
    .where(eq(workUnits.goalId, goalId)).orderBy(asc(workUnits.id)).all();
}

export function readyWorkUnits(db: BrainDb, goalId: string): WorkUnit[] {
  const candidates = db.select().from(workUnits)
    .where(eq(workUnits.goalId, goalId)).orderBy(asc(workUnits.priority)).all()
    .filter(w => ['PENDING', 'READY'].includes(w.status));
  if (candidates.length === 0) return [];
  const deps = db.select().from(workUnitDependencies)
    .where(inArray(workUnitDependencies.workUnitId, candidates.map(c => c.id))).all();
  const done = new Set(
    db.select().from(workUnits).where(eq(workUnits.goalId, goalId)).all()
      .filter(w => ['COMPLETED', 'SKIPPED'].includes(w.status)).map(w => w.id));
  return candidates.filter(c =>
    deps.filter(d => d.workUnitId === c.id).every(d => done.has(d.dependsOn)));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/work.test.ts` — Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/work.ts tests/work.test.ts
git commit -m "feat: work unit service with dependency-aware readiness

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Projects & repositories service

**Files:**
- Create: `src/services/projects.ts`
- Test: `tests/projects.test.ts`

**Interfaces:**
- Consumes: `slugify`, schema tables
- Produces (from `src/services/projects.js`):
  - `addProject(db, input: { name: string; rootPath?: string; description?: string }): Project` (id = slug; duplicate id throws)
  - `getProject(db, idOrName: string): Project` / `listProjects(db): Project[]`
  - `addRepo(db, input: { name: string; projectId?: string; path?: string; remoteUrl?: string; defaultBranch?: string; language?: string; framework?: string }): Repo`
  - `listRepos(db, projectId?: string): Repo[]`
  - `Project` = `typeof projects.$inferSelect`; `Repo` = `typeof repositories.$inferSelect`

- [ ] **Step 1: Write failing tests**

`tests/projects.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { addProject, getProject, listProjects, addRepo, listRepos } from '../src/services/projects.js';

describe('projects & repos', () => {
  it('adds and resolves projects by id or name', () => {
    const db = createTestDb();
    const p = addProject(db, { name: 'Central Brain', rootPath: '$HOME/Projects/central-brain' });
    expect(p.id).toBe('central-brain');
    expect(getProject(db, 'central-brain').name).toBe('Central Brain');
    expect(getProject(db, 'Central Brain').id).toBe('central-brain');
    expect(listProjects(db)).toHaveLength(1);
    expect(() => addProject(db, { name: 'Central Brain' })).toThrow(/exists/i);
  });

  it('adds repos linked to projects', () => {
    const db = createTestDb();
    const p = addProject(db, { name: 'Prospera' });
    const r = addRepo(db, { name: 'prospera-api', projectId: p.id, language: 'typescript' });
    expect(r.id).toBe('prospera-api');
    expect(listRepos(db, p.id)).toHaveLength(1);
    expect(() => addRepo(db, { name: 'x', projectId: 'nope' })).toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/projects.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/projects.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { projects, repositories } from '../db/schema.js';
import { slugify } from '../ids.js';

export type Project = typeof projects.$inferSelect;
export type Repo = typeof repositories.$inferSelect;

const now = () => new Date().toISOString();

export function addProject(db: BrainDb, input: { name: string; rootPath?: string; description?: string }): Project {
  const id = slugify(input.name);
  if (db.select().from(projects).where(eq(projects.id, id)).get()) {
    throw new Error(`Project already exists: ${id}`);
  }
  const ts = now();
  db.insert(projects).values({
    id, name: input.name, rootPath: input.rootPath ?? null,
    description: input.description ?? null, createdAt: ts, updatedAt: ts,
  }).run();
  return getProject(db, id);
}

export function getProject(db: BrainDb, idOrName: string): Project {
  const p = db.select().from(projects).where(eq(projects.id, idOrName)).get()
    ?? db.select().from(projects).where(eq(projects.name, idOrName)).get()
    ?? db.select().from(projects).where(eq(projects.id, slugify(idOrName))).get();
  if (!p) throw new Error(`Project not found: ${idOrName}`);
  return p;
}

export function listProjects(db: BrainDb): Project[] {
  return db.select().from(projects).all();
}

export function addRepo(db: BrainDb, input: {
  name: string; projectId?: string; path?: string; remoteUrl?: string;
  defaultBranch?: string; language?: string; framework?: string;
}): Repo {
  if (input.projectId) getProject(db, input.projectId);
  const id = slugify(input.name);
  if (db.select().from(repositories).where(eq(repositories.id, id)).get()) {
    throw new Error(`Repository already exists: ${id}`);
  }
  db.insert(repositories).values({
    id, name: input.name, projectId: input.projectId ?? null,
    path: input.path ?? null, remoteUrl: input.remoteUrl ?? null,
    defaultBranch: input.defaultBranch ?? null, language: input.language ?? null,
    framework: input.framework ?? null, createdAt: now(),
  }).run();
  return db.select().from(repositories).where(eq(repositories.id, id)).get()!;
}

export function listRepos(db: BrainDb, projectId?: string): Repo[] {
  const q = db.select().from(repositories);
  return projectId ? q.where(eq(repositories.projectId, projectId)).all() : q.all();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/projects.test.ts` — Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/projects.ts tests/projects.test.ts
git commit -m "feat: project and repository registry

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Knowledge & learnings service (with lifecycle)

**Files:**
- Create: `src/services/knowledge.ts`
- Test: `tests/knowledge.test.ts`

**Interfaces:**
- Consumes: `parsePrefixedId`, schema tables
- Produces (from `src/services/knowledge.js`):
  - `addKnowledge(db, input: { scopeType: string; scopeId?: string; category?: string; statement: string; confidence?: number; sourceType?: string; sourceReference?: string }): Knowledge` — a non-GLOBAL scope with a `scopeId` must be prefixed (§16.1) or it throws
  - `verifyKnowledge(db, id: number): Knowledge` (bumps `lastVerifiedAt`)
  - `invalidateKnowledge(db, id: number): Knowledge` (status `invalid`)
  - `supersedeKnowledge(db, oldId: number, input: { statement: string; confidence?: number; sourceType?: string; sourceReference?: string }): Knowledge` — inserts replacement inheriting scope/category, marks old row `superseded` + `supersededBy`
  - `listKnowledge(db, opts?: { scopeType?: string; scopeId?: string; includeInactive?: boolean }): Knowledge[]` — active-only by default
  - `addLearning(db, input: { learning: string; scopeType?: string; scopeId?: string; trigger?: string }): Learning`
  - `markLearningUseful(db, id: number): Learning` (increments `timesUsed`, sets `lastUsedAt`)
  - `listLearnings(db, opts?: { scopeType?: string; scopeId?: string }): Learning[]`
  - `Knowledge` = `typeof knowledge.$inferSelect`; `Learning` = `typeof learnings.$inferSelect`

- [ ] **Step 1: Write failing tests**

`tests/knowledge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import {
  addKnowledge, verifyKnowledge, invalidateKnowledge, supersedeKnowledge,
  listKnowledge, addLearning, markLearningUseful, listLearnings,
} from '../src/services/knowledge.js';

describe('knowledge lifecycle', () => {
  it('adds scoped knowledge and enforces prefixed scope ids', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { scopeType: 'REPOSITORY', scopeId: 'repo:prospera-api', statement: 'Uses PostgreSQL via Sequelize' });
    expect(k.status).toBe('active');
    expect(() => addKnowledge(db, { scopeType: 'REPOSITORY', scopeId: 'prospera-api', statement: 'x' }))
      .toThrow(/prefixed/i);
  });

  it('supersede preserves history and hides the old fact', () => {
    const db = createTestDb();
    const old = addKnowledge(db, { scopeType: 'GLOBAL', statement: 'Server IP is 192.0.2.10' });
    const neu = supersedeKnowledge(db, old.id, { statement: 'Server IP is 192.0.2.20' });
    const active = listKnowledge(db);
    expect(active.map(k => k.id)).toEqual([neu.id]);
    const all = listKnowledge(db, { includeInactive: true });
    const oldRow = all.find(k => k.id === old.id)!;
    expect(oldRow.status).toBe('superseded');
    expect(oldRow.supersededBy).toBe(neu.id);
  });

  it('verify and invalidate update lifecycle fields', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { scopeType: 'GLOBAL', statement: 'fact' });
    expect(verifyKnowledge(db, k.id).lastVerifiedAt).toBeTruthy();
    expect(invalidateKnowledge(db, k.id).status).toBe('invalid');
    expect(listKnowledge(db)).toHaveLength(0);
  });

  it('learnings track usefulness', () => {
    const db = createTestDb();
    const l = addLearning(db, { learning: 'Verify UTC conversion at API boundaries', trigger: 'timezone bug' });
    const used = markLearningUseful(db, l.id);
    expect(used.timesUsed).toBe(1);
    expect(used.lastUsedAt).toBeTruthy();
    expect(listLearnings(db)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/knowledge.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/knowledge.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { knowledge, learnings } from '../db/schema.js';
import { parsePrefixedId } from '../ids.js';

export type Knowledge = typeof knowledge.$inferSelect;
export type Learning = typeof learnings.$inferSelect;

const now = () => new Date().toISOString();

function assertScope(scopeId?: string): void {
  if (scopeId) parsePrefixedId(scopeId); // throws with "prefixed" guidance if invalid
}

export function addKnowledge(db: BrainDb, input: {
  scopeType: string; scopeId?: string; category?: string; statement: string;
  confidence?: number; sourceType?: string; sourceReference?: string;
}): Knowledge {
  assertScope(input.scopeId);
  const res = db.insert(knowledge).values({
    scopeType: input.scopeType, scopeId: input.scopeId ?? null,
    category: input.category ?? null, statement: input.statement,
    confidence: input.confidence ?? 1.0, sourceType: input.sourceType ?? null,
    sourceReference: input.sourceReference ?? null, createdAt: now(),
  }).run();
  return getKnowledge(db, Number(res.lastInsertRowid));
}

export function getKnowledge(db: BrainDb, id: number): Knowledge {
  const k = db.select().from(knowledge).where(eq(knowledge.id, id)).get();
  if (!k) throw new Error(`Knowledge not found: ${id}`);
  return k;
}

export function verifyKnowledge(db: BrainDb, id: number): Knowledge {
  getKnowledge(db, id);
  db.update(knowledge).set({ lastVerifiedAt: now() }).where(eq(knowledge.id, id)).run();
  return getKnowledge(db, id);
}

export function invalidateKnowledge(db: BrainDb, id: number): Knowledge {
  getKnowledge(db, id);
  db.update(knowledge).set({ status: 'invalid' }).where(eq(knowledge.id, id)).run();
  return getKnowledge(db, id);
}

export function supersedeKnowledge(db: BrainDb, oldId: number, input: {
  statement: string; confidence?: number; sourceType?: string; sourceReference?: string;
}): Knowledge {
  const old = getKnowledge(db, oldId);
  const neu = addKnowledge(db, {
    scopeType: old.scopeType, scopeId: old.scopeId ?? undefined,
    category: old.category ?? undefined, statement: input.statement,
    confidence: input.confidence, sourceType: input.sourceType,
    sourceReference: input.sourceReference,
  });
  db.update(knowledge).set({ status: 'superseded', supersededBy: neu.id })
    .where(eq(knowledge.id, oldId)).run();
  return neu;
}

export function listKnowledge(db: BrainDb, opts: {
  scopeType?: string; scopeId?: string; includeInactive?: boolean;
} = {}): Knowledge[] {
  const conds = [];
  if (!opts.includeInactive) conds.push(eq(knowledge.status, 'active'));
  if (opts.scopeType) conds.push(eq(knowledge.scopeType, opts.scopeType));
  if (opts.scopeId) conds.push(eq(knowledge.scopeId, opts.scopeId));
  const q = db.select().from(knowledge);
  return conds.length ? q.where(and(...conds)).all() : q.all();
}

export function addLearning(db: BrainDb, input: {
  learning: string; scopeType?: string; scopeId?: string; trigger?: string;
}): Learning {
  assertScope(input.scopeId);
  const res = db.insert(learnings).values({
    learning: input.learning, scopeType: input.scopeType ?? null,
    scopeId: input.scopeId ?? null, trigger: input.trigger ?? null, createdAt: now(),
  }).run();
  return db.select().from(learnings).where(eq(learnings.id, Number(res.lastInsertRowid))).get()!;
}

export function markLearningUseful(db: BrainDb, id: number): Learning {
  const l = db.select().from(learnings).where(eq(learnings.id, id)).get();
  if (!l) throw new Error(`Learning not found: ${id}`);
  db.update(learnings).set({ timesUsed: l.timesUsed + 1, lastUsedAt: now() })
    .where(eq(learnings.id, id)).run();
  return db.select().from(learnings).where(eq(learnings.id, id)).get()!;
}

export function listLearnings(db: BrainDb, opts: { scopeType?: string; scopeId?: string } = {}): Learning[] {
  const conds = [];
  if (opts.scopeType) conds.push(eq(learnings.scopeType, opts.scopeType));
  if (opts.scopeId) conds.push(eq(learnings.scopeId, opts.scopeId));
  const q = db.select().from(learnings);
  return conds.length ? q.where(and(...conds)).all() : q.all();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/knowledge.test.ts` — Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/knowledge.ts tests/knowledge.test.ts
git commit -m "feat: knowledge lifecycle (active/superseded/invalid) and learnings

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Decisions, observations & approvals service

**Files:**
- Create: `src/services/decisions.ts`
- Test: `tests/decisions.test.ts`

**Interfaces:**
- Consumes: `parsePrefixedId`, schema tables
- Produces (from `src/services/decisions.js`):
  - `addDecision(db, input: { decision: string; goalId?: string; scopeType?: string; scopeId?: string; reason?: string; alternatives?: string; riskLevel?: string; reversible?: boolean; executor?: string }): Decision`
  - `listDecisions(db, opts?: { goalId?: string }): Decision[]`
  - `addObservation(db, input: { observation: string; goalId?: string; workUnitId?: string; scopeType?: string; scopeId?: string; confidence?: number }): Observation`
  - `addApproval(db, input: { action: string; riskLevel: string; goalId?: string; decisionId?: number }): Approval`
  - `resolveApproval(db, id: number, status: 'approved'|'denied'): Approval`
  - Row types: `Decision`, `Observation`, `Approval` (drizzle `$inferSelect` of their tables)

- [ ] **Step 1: Write failing tests**

`tests/decisions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal } from '../src/services/goals.js';
import {
  addDecision, listDecisions, addObservation, addApproval, resolveApproval,
} from '../src/services/decisions.js';

describe('decisions, observations, approvals', () => {
  it('records decisions against goals', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addDecision(db, {
      goalId: g.id, decision: 'Use library C for OAuth',
      reason: 'PKCE support', alternatives: 'library A, library B', riskLevel: 'MEDIUM',
    });
    expect(listDecisions(db, { goalId: g.id })).toHaveLength(1);
    expect(listDecisions(db)).toHaveLength(1);
  });

  it('records observations', () => {
    const db = createTestDb();
    const o = addObservation(db, { observation: 'Port 8020 already in use by voiceflowx', scopeType: 'MACHINE', scopeId: 'entity:truenas' });
    expect(o.id).toBeGreaterThan(0);
  });

  it('approvals resolve to approved/denied with timestamps', () => {
    const db = createTestDb();
    const a = addApproval(db, { action: 'Delete production database', riskLevel: 'IRREVERSIBLE' });
    expect(a.status).toBe('pending');
    const resolved = resolveApproval(db, a.id, 'denied');
    expect(resolved.status).toBe('denied');
    expect(resolved.resolvedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/decisions.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/decisions.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { decisions, observations, approvals } from '../db/schema.js';
import { parsePrefixedId } from '../ids.js';

export type Decision = typeof decisions.$inferSelect;
export type Observation = typeof observations.$inferSelect;
export type Approval = typeof approvals.$inferSelect;

const now = () => new Date().toISOString();
const assertScope = (scopeId?: string) => { if (scopeId) parsePrefixedId(scopeId); };

export function addDecision(db: BrainDb, input: {
  decision: string; goalId?: string; scopeType?: string; scopeId?: string;
  reason?: string; alternatives?: string; riskLevel?: string;
  reversible?: boolean; executor?: string;
}): Decision {
  assertScope(input.scopeId);
  const res = db.insert(decisions).values({
    decision: input.decision, goalId: input.goalId ?? null,
    scopeType: input.scopeType ?? null, scopeId: input.scopeId ?? null,
    reason: input.reason ?? null, alternatives: input.alternatives ?? null,
    riskLevel: input.riskLevel ?? null,
    reversible: input.reversible === false ? 0 : 1,
    executor: input.executor ?? null, createdAt: now(),
  }).run();
  return db.select().from(decisions).where(eq(decisions.id, Number(res.lastInsertRowid))).get()!;
}

export function listDecisions(db: BrainDb, opts: { goalId?: string } = {}): Decision[] {
  const q = db.select().from(decisions);
  return opts.goalId ? q.where(eq(decisions.goalId, opts.goalId)).all() : q.all();
}

export function addObservation(db: BrainDb, input: {
  observation: string; goalId?: string; workUnitId?: string;
  scopeType?: string; scopeId?: string; confidence?: number;
}): Observation {
  assertScope(input.scopeId);
  const res = db.insert(observations).values({
    observation: input.observation, goalId: input.goalId ?? null,
    workUnitId: input.workUnitId ?? null, scopeType: input.scopeType ?? null,
    scopeId: input.scopeId ?? null, confidence: input.confidence ?? 1, createdAt: now(),
  }).run();
  return db.select().from(observations).where(eq(observations.id, Number(res.lastInsertRowid))).get()!;
}

export function addApproval(db: BrainDb, input: {
  action: string; riskLevel: string; goalId?: string; decisionId?: number;
}): Approval {
  const res = db.insert(approvals).values({
    action: input.action, riskLevel: input.riskLevel,
    goalId: input.goalId ?? null, decisionId: input.decisionId ?? null,
    requestedAt: now(),
  }).run();
  return db.select().from(approvals).where(eq(approvals.id, Number(res.lastInsertRowid))).get()!;
}

export function resolveApproval(db: BrainDb, id: number, status: 'approved' | 'denied'): Approval {
  const a = db.select().from(approvals).where(eq(approvals.id, id)).get();
  if (!a) throw new Error(`Approval not found: ${id}`);
  db.update(approvals).set({ status, resolvedAt: now() }).where(eq(approvals.id, id)).run();
  return db.select().from(approvals).where(eq(approvals.id, id)).get()!;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/decisions.test.ts` — Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/decisions.ts tests/decisions.test.ts
git commit -m "feat: decisions, observations, and approvals

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: FTS5 search service

**Files:**
- Create: `src/services/search.ts`
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: FTS tables from Task 2; base tables
- Produces (from `src/services/search.js`):
  - `type SearchType = 'knowledge' | 'learning' | 'decision' | 'failure' | 'goal'`
  - `interface SearchResult { type: SearchType; id: string; text: string; score: number; scopeType: string | null; scopeId: string | null }`
  - `search(db, query: string, opts?: { types?: SearchType[]; limit?: number }): SearchResult[]` — bm25-ranked (lower bm25 = better; results sorted ascending by score), merged across types, default limit 20; knowledge results exclude non-`active` rows; empty/whitespace query returns `[]`
  - `ftsQuery(raw: string): string` — turns free text into a safe FTS5 prefix-match query (each token quoted + `*`)

- [ ] **Step 1: Write failing tests**

`tests/search.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { addKnowledge, invalidateKnowledge, addLearning } from '../src/services/knowledge.js';
import { addDecision } from '../src/services/decisions.js';
import { createGoal } from '../src/services/goals.js';
import { search, ftsQuery } from '../src/services/search.js';

describe('fts search', () => {
  it('sanitizes queries into prefix matches', () => {
    expect(ftsQuery('postgres migration')).toBe('"postgres"* "migration"*');
    expect(ftsQuery('it\'s "quoted"')).toBe('"it\'s"* """quoted"""*');
  });

  it('finds matches across types, ranked', () => {
    const db = createTestDb();
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'Prospera API uses PostgreSQL via Sequelize' });
    addLearning(db, { learning: 'Backward-compatible postgres migrations are preferred' });
    addDecision(db, { decision: 'Adopt PostgreSQL for the billing service', reason: 'transactional integrity' });
    createGoal(db, { title: 'Migrate to PostgreSQL 16', objective: 'upgrade db' });
    const results = search(db, 'postgres');
    const types = new Set(results.map(r => r.type));
    expect(types).toContain('knowledge');
    expect(types).toContain('learning');
    expect(types).toContain('decision');
    expect(types).toContain('goal');
    expect(results.length).toBeGreaterThanOrEqual(4);
  });

  it('excludes inactive knowledge and respects type filter + limit', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { scopeType: 'GLOBAL', statement: 'stale timezone fact' });
    invalidateKnowledge(db, k.id);
    addLearning(db, { learning: 'timezone conversions bite at API boundaries' });
    const res = search(db, 'timezone', { types: ['knowledge', 'learning'] });
    expect(res.map(r => r.type)).toEqual(['learning']);
    expect(search(db, 'timezone', { limit: 0 })).toEqual([]);
    expect(search(db, '   ')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/search.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/search.ts`:

```ts
import type { BrainDb } from '../db/connection.js';

export type SearchType = 'knowledge' | 'learning' | 'decision' | 'failure' | 'goal';

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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/search.test.ts` — Expected: 3 PASS. (If the learnings/decisions/failures FTS tables were mis-created in Task 2's custom migration, this is where it surfaces — fix the migration, not the service.)

- [ ] **Step 5: Commit**

```bash
git add src/services/search.ts tests/search.test.ts
git commit -m "feat: FTS5 bm25 search across knowledge, learnings, decisions, failures, goals

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9.5: Model routing service

**Files:**
- Create: `src/services/model.ts`
- Test: `tests/model.test.ts`

**Interfaces:**
- Consumes: `getGoal`, `currentGoal`, `createGoal` from Task 4
- Produces (from `src/services/model.js`):
  - `type Complexity = 'trivial' | 'low' | 'medium' | 'high' | 'critical'`
  - `interface ModelRouting { model: string; complexity: Complexity; source: 'explicit' | 'goal' | 'default' }`
  - `modelMap(configPath?: string): Record<Complexity, string>` — defaults (`trivial→haiku, low→sonnet, medium→sonnet, high→opus, critical→fable`) merged with the `modelMap` key of `~/.central-brain/config.json` if present
  - `recommendModel(db, opts?: { goalId?: string; complexity?: Complexity; configPath?: string }): ModelRouting` — explicit complexity wins; else the named goal's (or current goal's) complexity; default `medium`; a goal with `riskLevel` HIGH/IRREVERSIBLE is bumped to at least `high` (§12.1)

- [ ] **Step 1: Write failing tests**

`tests/model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers.js';
import { createGoal, lockGoal } from '../src/services/goals.js';
import { recommendModel } from '../src/services/model.js';

describe('model routing', () => {
  it('maps explicit complexity via the default map', () => {
    const db = createTestDb();
    expect(recommendModel(db, { complexity: 'trivial' }))
      .toEqual({ model: 'haiku', complexity: 'trivial', source: 'explicit' });
    expect(recommendModel(db, { complexity: 'critical' }).model).toBe('fable');
  });

  it('routes by goal complexity, defaulting to medium', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', complexity: 'high' });
    expect(recommendModel(db, { goalId: g.id }))
      .toEqual({ model: 'opus', complexity: 'high', source: 'goal' });
    const plain = createGoal(db, { title: 'p', objective: 'o' });
    expect(recommendModel(db, { goalId: plain.id }))
      .toEqual({ model: 'sonnet', complexity: 'medium', source: 'default' });
  });

  it('bumps HIGH/IRREVERSIBLE-risk goals to at least high complexity', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', complexity: 'low', riskLevel: 'IRREVERSIBLE' });
    expect(recommendModel(db, { goalId: g.id }).model).toBe('opus');
  });

  it('uses the current active goal when no goalId is given', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', complexity: 'critical' });
    lockGoal(db, g.id);
    expect(recommendModel(db).model).toBe('fable');
  });

  it('honors modelMap overrides from config.json', () => {
    const db = createTestDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cfg-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ modelMap: { critical: 'opus' } }));
    expect(recommendModel(db, { complexity: 'critical', configPath: cfg }).model).toBe('opus');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/model.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/model.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrainDb } from '../db/connection.js';
import { currentGoal, getGoal } from './goals.js';

export type Complexity = 'trivial' | 'low' | 'medium' | 'high' | 'critical';

export interface ModelRouting {
  model: string;
  complexity: Complexity;
  source: 'explicit' | 'goal' | 'default';
}

const DEFAULT_MAP: Record<Complexity, string> = {
  trivial: 'haiku', low: 'sonnet', medium: 'sonnet', high: 'opus', critical: 'fable',
};

const ORDER: Complexity[] = ['trivial', 'low', 'medium', 'high', 'critical'];

export function modelMap(
  configPath: string = path.join(os.homedir(), '.central-brain', 'config.json'),
): Record<Complexity, string> {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { ...DEFAULT_MAP, ...(cfg.modelMap ?? {}) };
  } catch {
    return { ...DEFAULT_MAP };
  }
}

export function recommendModel(
  db: BrainDb,
  opts: { goalId?: string; complexity?: Complexity; configPath?: string } = {},
): ModelRouting {
  const map = modelMap(opts.configPath);
  if (opts.complexity) {
    return { model: map[opts.complexity], complexity: opts.complexity, source: 'explicit' };
  }
  const goal = opts.goalId ? getGoal(db, opts.goalId) : currentGoal(db);
  let complexity = (goal?.complexity ?? 'medium') as Complexity;
  if (!ORDER.includes(complexity)) complexity = 'medium';
  if (goal?.riskLevel && ['HIGH', 'IRREVERSIBLE'].includes(goal.riskLevel.toUpperCase())
      && ORDER.indexOf(complexity) < ORDER.indexOf('high')) {
    complexity = 'high';
  }
  return { model: map[complexity], complexity, source: goal?.complexity ? 'goal' : 'default' };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/model.test.ts` — Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/model.ts tests/model.test.ts
git commit -m "feat: complexity-based model routing (§12.1)

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Context engine

**Files:**
- Create: `src/services/context.ts`
- Test: `tests/context.test.ts`

**Interfaces:**
- Consumes: goals/work/knowledge/decisions services, `search`, `recommendModel` (Task 9.5)
- Produces (from `src/services/context.js`):
  - `getContext(db, opts: { goalId?: string; budget?: number }): BrainContext` — if `goalId` omitted, uses `currentGoal`; if no active goal, returns `{ goal: null, ... }` with global knowledge/learnings only
  - `interface BrainContext { goal: Goal | null; requirements: Requirement[]; workUnits: WorkUnit[]; decisions: Decision[]; knowledge: Knowledge[]; learnings: Learning[]; relatedGoals: { id: string; title: string; status: string }[]; recommendedModel: ModelRouting }`
  - Budget (default 30) caps the combined size of `decisions + knowledge + learnings + relatedGoals` (requirements and open work units are always included in full — they are the contract). Knowledge ranked: goal-scoped first, then GLOBAL, then rest; within a group by `lastVerifiedAt ?? createdAt` desc, then confidence desc.
  - `searchContext(db, query: string, opts?: { limit?: number }): SearchResult[]` — thin alias over `search`

- [ ] **Step 1: Write failing tests**

`tests/context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal, addRequirement, lockGoal } from '../src/services/goals.js';
import { createWorkUnit } from '../src/services/work.js';
import { addKnowledge } from '../src/services/knowledge.js';
import { addDecision } from '../src/services/decisions.js';
import { getContext, searchContext } from '../src/services/context.js';

describe('context engine', () => {
  it('assembles goal context with requirements and open work', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Add SSO', objective: 'MS auth' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'login works' });
    lockGoal(db, g.id);
    createWorkUnit(db, { goalId: g.id, title: 'Inspect auth' });
    addDecision(db, { goalId: g.id, decision: 'Use MSAL' });
    addKnowledge(db, { scopeType: 'GOAL', scopeId: `goal:${g.id}`, statement: 'frontend is Next.js' });
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'Prefer reversible changes' });
    const ctx = getContext(db, { goalId: g.id });
    expect(ctx.goal?.id).toBe(g.id);
    expect(ctx.requirements).toHaveLength(1);
    expect(ctx.workUnits).toHaveLength(1);
    expect(ctx.decisions).toHaveLength(1);
    // goal-scoped knowledge ranks before global
    expect(ctx.knowledge[0].statement).toBe('frontend is Next.js');
    expect(ctx.knowledge[1].statement).toBe('Prefer reversible changes');
    // no complexity set on the goal -> default medium -> sonnet
    expect(ctx.recommendedModel).toEqual({ model: 'sonnet', complexity: 'medium', source: 'default' });
  });

  it('falls back to the current active goal and respects budget', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Active goal', objective: 'o' });
    lockGoal(db, g.id);
    for (let i = 0; i < 50; i++) {
      addKnowledge(db, { scopeType: 'GLOBAL', statement: `fact number ${i}` });
    }
    const ctx = getContext(db, { budget: 10 });
    expect(ctx.goal?.id).toBe(g.id);
    const total = ctx.decisions.length + ctx.knowledge.length + ctx.learnings.length + ctx.relatedGoals.length;
    expect(total).toBeLessThanOrEqual(10);
  });

  it('returns global-only context when no goal is active', () => {
    const db = createTestDb();
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'Do not commit .env files' });
    const ctx = getContext(db, {});
    expect(ctx.goal).toBeNull();
    expect(ctx.knowledge.length).toBe(1);
  });

  it('searchContext proxies fts search', () => {
    const db = createTestDb();
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'truenas runs seafile on port 8088' });
    expect(searchContext(db, 'seafile')[0].type).toBe('knowledge');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/context.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/context.ts`:

```ts
import type { BrainDb } from '../db/connection.js';
import { currentGoal, getGoal, listRequirements, type Goal, type Requirement } from './goals.js';
import { listWorkUnits, type WorkUnit } from './work.js';
import { listKnowledge, listLearnings, type Knowledge, type Learning } from './knowledge.js';
import { listDecisions, type Decision } from './decisions.js';
import { listGoals } from './goals.js';
import { recommendModel, type ModelRouting } from './model.js';
import { search, type SearchResult } from './search.js';

export interface BrainContext {
  goal: Goal | null;
  requirements: Requirement[];
  workUnits: WorkUnit[];
  decisions: Decision[];
  knowledge: Knowledge[];
  learnings: Learning[];
  relatedGoals: { id: string; title: string; status: string }[];
  recommendedModel: ModelRouting;
}

function rankKnowledge(rows: Knowledge[], goalId?: string): Knowledge[] {
  const bucket = (k: Knowledge) =>
    goalId && k.scopeId === `goal:${goalId}` ? 0 : k.scopeType === 'GLOBAL' ? 1 : 2;
  return [...rows].sort((a, b) =>
    bucket(a) - bucket(b) ||
    (b.lastVerifiedAt ?? b.createdAt).localeCompare(a.lastVerifiedAt ?? a.createdAt) ||
    b.confidence - a.confidence);
}

export function getContext(db: BrainDb, opts: { goalId?: string; budget?: number } = {}): BrainContext {
  const budget = opts.budget ?? 30;
  const goal = opts.goalId ? getGoal(db, opts.goalId) : currentGoal(db) ?? null;

  const requirements = goal ? listRequirements(db, goal.id) : [];
  const workUnits = goal
    ? listWorkUnits(db, goal.id).filter(w => !['COMPLETED', 'SKIPPED'].includes(w.status))
    : [];

  const decisionsAll = goal ? listDecisions(db, { goalId: goal.id }) : [];
  const knowledgeAll = rankKnowledge(listKnowledge(db), goal?.id);
  const learningsAll = listLearnings(db)
    .sort((a, b) => b.usefulnessScore - a.usefulnessScore || b.timesUsed - a.timesUsed);
  const relatedAll = listGoals(db)
    .filter(g => g.id !== goal?.id)
    .slice(0, 10)
    .map(g => ({ id: g.id, title: g.title, status: g.status }));

  // Allocate the budget across the four capped categories, then backfill.
  const cats: { rows: unknown[] }[] = [
    { rows: decisionsAll }, { rows: knowledgeAll }, { rows: learningsAll }, { rows: relatedAll },
  ];
  const per = Math.floor(budget / cats.length);
  const caps = cats.map(c => Math.min(c.rows.length, per));
  let remaining = budget - caps.reduce((s, n) => s + n, 0);
  for (let i = 0; i < cats.length && remaining > 0; i++) {
    const extra = Math.min(remaining, cats[i].rows.length - caps[i]);
    caps[i] += extra;
    remaining -= extra;
  }

  return {
    goal,
    requirements,
    workUnits,
    decisions: decisionsAll.slice(0, caps[0]) as Decision[],
    knowledge: knowledgeAll.slice(0, caps[1]),
    learnings: learningsAll.slice(0, caps[2]) as Learning[],
    relatedGoals: relatedAll.slice(0, caps[3]),
    recommendedModel: recommendModel(db, { goalId: goal?.id }),
  };
}

export function searchContext(db: BrainDb, query: string, opts: { limit?: number } = {}): SearchResult[] {
  return search(db, query, { limit: opts.limit ?? 20 });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/context.test.ts` — Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/context.ts tests/context.test.ts
git commit -m "feat: budgeted, ranked context retrieval

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: `brain` CLI

**Files:**
- Create: `src/cli/index.ts`, `src/db/backup.ts`, `bin/brain.js`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: every service from Tasks 4–10, `openDb`/`migrateDb`/`resolveDbPath`, `backupDb`
- Produces:
  - executable `brain` command (via `npm run brain --` in dev, `bin/brain.js` after build) covering §77: `init`, `goal create|list|show|current|lock|start|block|complete`, `goal requirement add|status`, `work create|update|list|ready`, `project add|list|show`, `repo add|list`, `knowledge add|search|verify|invalidate|supersede`, `learning add|search|useful`, `decision add|list`, `observe`, `context get|search`, `approval add|resolve`, `model recommend`, `backup`
  - all commands print pretty JSON to stdout; errors go to stderr with exit code 1
  - `backupDb(db, destDir?): string` from `src/db/backup.js` — `VACUUM INTO` a timestamped file under `~/.central-brain/backups/`, prunes to the 10 newest, returns the written path

- [ ] **Step 1: Write the backup module**

`src/db/backup.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrainDb } from './connection.js';

export function backupDb(
  db: BrainDb,
  destDir: string = path.join(os.homedir(), '.central-brain', 'backups'),
): string {
  fs.mkdirSync(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(destDir, `brain-${stamp}.db`);
  db.$client.prepare('VACUUM INTO ?').run(dest);
  const snapshots = fs.readdirSync(destDir)
    .filter(f => f.startsWith('brain-') && f.endsWith('.db')).sort().reverse();
  for (const old of snapshots.slice(10)) fs.rmSync(path.join(destDir, old));
  return dest;
}
```

- [ ] **Step 2: Write the CLI**

`src/cli/index.ts` (full file; one `Command` tree; every action opens the DB lazily so `--help` works without a DB):

```ts
import { Command } from 'commander';
import { openDb, migrateDb, resolveDbPath, type BrainDb } from '../db/connection.js';
import { backupDb } from '../db/backup.js';
import * as goals from '../services/goals.js';
import * as work from '../services/work.js';
import * as projects from '../services/projects.js';
import * as knowledge from '../services/knowledge.js';
import * as decisions from '../services/decisions.js';
import * as context from '../services/context.js';
import { recommendModel, type Complexity } from '../services/model.js';
import { search } from '../services/search.js';

function db(): BrainDb {
  const handle = openDb();
  migrateDb(handle); // idempotent; keeps CLI usable right after upgrades
  return handle;
}

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

function run(fn: () => void): void {
  try { fn(); } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

const program = new Command('brain').description('Central Brain CLI');

program.command('init').description('Create the database and apply migrations')
  .action(() => run(() => { db(); out({ ok: true, database: resolveDbPath() }); }));

program.command('backup').description('Snapshot the database (VACUUM INTO)')
  .action(() => run(() => out({ backup: backupDb(db()) })));

// ---- goal ----
const goal = program.command('goal');
goal.command('create <title>').option('-o, --objective <text>')
  .option('--risk <level>').option('--autonomy <level>')
  .option('--complexity <level>', 'trivial|low|medium|high|critical')
  .action((title, o) => run(() => out(goals.createGoal(db(), {
    title, objective: o.objective ?? title, riskLevel: o.risk,
    autonomyLevel: o.autonomy, complexity: o.complexity,
  }))));
goal.command('list').option('--status <status>')
  .action((o) => run(() => out(goals.listGoals(db(), { status: o.status }))));
goal.command('show <id>').action((id) => run(() => {
  const d = db();
  out({ ...goals.getGoal(d, id), requirements: goals.listRequirements(d, id) });
}));
goal.command('current').action(() => run(() => out(goals.currentGoal(db()) ?? null)));
goal.command('lock <id>').action((id) => run(() => out(goals.lockGoal(db(), id))));
goal.command('start <id>').action((id) => run(() => out(goals.startGoal(db(), id))));
goal.command('block <id> <reason>').action((id, reason) => run(() => out(goals.blockGoal(db(), id, reason))));
goal.command('complete <id>').option('--force')
  .action((id, o) => run(() => out(goals.completeGoal(db(), id, { force: o.force }))));

const req = goal.command('requirement');
req.command('add <goalId> <description>')
  .option('-t, --type <type>', 'objective|constraint|success_criterion|exclusion|assumption', 'success_criterion')
  .option('-p, --priority <p>', 'required|optional', 'required')
  .action((goalId, description, o) => run(() =>
    out(goals.addRequirement(db(), goalId, { type: o.type, description, priority: o.priority }))));
req.command('status <id> <status>').option('-r, --reason <text>')
  .action((id, status, o) => run(() => {
    goals.setRequirementStatus(db(), Number(id), status, o.reason);
    out({ ok: true });
  }));

// ---- work ----
const workCmd = program.command('work');
workCmd.command('create <goalId> <title>')
  .option('-d, --description <text>').option('--type <workType>')
  .option('--complexity <level>', 'trivial|low|medium|high|critical')
  .option('--priority <n>').option('--depends-on <ids>', 'comma-separated work unit ids')
  .action((goalId, title, o) => run(() => out(work.createWorkUnit(db(), {
    goalId, title, description: o.description, workType: o.type,
    complexity: o.complexity,
    priority: o.priority ? Number(o.priority) : undefined,
    dependsOn: o.dependsOn ? String(o.dependsOn).split(',') : undefined,
  }))));
workCmd.command('update <id>').option('--status <status>').option('--title <t>')
  .action((id, o) => run(() => out(work.updateWorkUnit(db(), id, { status: o.status, title: o.title }))));
workCmd.command('list <goalId>').action((goalId) => run(() => out(work.listWorkUnits(db(), goalId))));
workCmd.command('ready <goalId>').action((goalId) => run(() => out(work.readyWorkUnits(db(), goalId))));

// ---- project / repo ----
const proj = program.command('project');
proj.command('add <name>').option('--path <rootPath>').option('-d, --description <text>')
  .action((name, o) => run(() => out(projects.addProject(db(), { name, rootPath: o.path, description: o.description }))));
proj.command('list').action(() => run(() => out(projects.listProjects(db()))));
proj.command('show <idOrName>').action((idOrName) => run(() => out(projects.getProject(db(), idOrName))));

const repo = program.command('repo');
repo.command('add <name>').option('--project <projectId>').option('--path <path>')
  .option('--remote <url>').option('--branch <branch>').option('--language <lang>').option('--framework <fw>')
  .action((name, o) => run(() => out(projects.addRepo(db(), {
    name, projectId: o.project, path: o.path, remoteUrl: o.remote,
    defaultBranch: o.branch, language: o.language, framework: o.framework,
  }))));
repo.command('list').option('--project <projectId>')
  .action((o) => run(() => out(projects.listRepos(db(), o.project))));

// ---- knowledge / learning ----
const know = program.command('knowledge');
know.command('add <statement>')
  .option('-s, --scope <scopeType>', 'GLOBAL|PROJECT|REPOSITORY|SERVICE|ENVIRONMENT|MACHINE|FILE|MODULE|GOAL', 'GLOBAL')
  .option('--scope-id <prefixedId>').option('-c, --category <cat>')
  .option('--confidence <n>').option('--source <sourceType>').option('--source-ref <ref>')
  .action((statement, o) => run(() => out(knowledge.addKnowledge(db(), {
    scopeType: o.scope, scopeId: o.scopeId, category: o.category, statement,
    confidence: o.confidence ? Number(o.confidence) : undefined,
    sourceType: o.source, sourceReference: o.sourceRef,
  }))));
know.command('search <query>').option('-n, --limit <n>')
  .action((query, o) => run(() => out(search(db(), query, {
    types: ['knowledge'], limit: o.limit ? Number(o.limit) : undefined,
  }))));
know.command('verify <id>').action((id) => run(() => out(knowledge.verifyKnowledge(db(), Number(id)))));
know.command('invalidate <id>').action((id) => run(() => out(knowledge.invalidateKnowledge(db(), Number(id)))));
know.command('supersede <id> <statement>')
  .action((id, statement) => run(() => out(knowledge.supersedeKnowledge(db(), Number(id), { statement }))));

const learn = program.command('learning');
learn.command('add <learning>').option('-s, --scope <scopeType>').option('--scope-id <prefixedId>').option('--trigger <text>')
  .action((text, o) => run(() => out(knowledge.addLearning(db(), {
    learning: text, scopeType: o.scope, scopeId: o.scopeId, trigger: o.trigger,
  }))));
learn.command('search <query>').action((query) => run(() => out(search(db(), query, { types: ['learning'] }))));
learn.command('useful <id>').action((id) => run(() => out(knowledge.markLearningUseful(db(), Number(id)))));

// ---- decision / observation / approval ----
const dec = program.command('decision');
dec.command('add <decision>').option('-g, --goal <goalId>').option('-r, --reason <text>')
  .option('--alternatives <text>').option('--risk <level>').option('--irreversible')
  .action((text, o) => run(() => out(decisions.addDecision(db(), {
    decision: text, goalId: o.goal, reason: o.reason, alternatives: o.alternatives,
    riskLevel: o.risk, reversible: !o.irreversible,
  }))));
dec.command('list').option('-g, --goal <goalId>')
  .action((o) => run(() => out(decisions.listDecisions(db(), { goalId: o.goal }))));

program.command('observe <observation>').option('-g, --goal <goalId>')
  .option('-s, --scope <scopeType>').option('--scope-id <prefixedId>')
  .action((text, o) => run(() => out(decisions.addObservation(db(), {
    observation: text, goalId: o.goal, scopeType: o.scope, scopeId: o.scopeId,
  }))));

const appr = program.command('approval');
appr.command('add <action>').option('--risk <level>', 'risk level', 'IRREVERSIBLE').option('-g, --goal <goalId>')
  .action((action, o) => run(() => out(decisions.addApproval(db(), { action, riskLevel: o.risk, goalId: o.goal }))));
appr.command('resolve <id> <status>')
  .action((id, status) => run(() => out(decisions.resolveApproval(db(), Number(id), status))));

// ---- context ----
const ctx = program.command('context');
ctx.command('get').option('-g, --goal <goalId>').option('--current')
  .option('-b, --budget <n>', 'max items', '30')
  .action((o) => run(() => out(context.getContext(db(), {
    goalId: o.goal, budget: Number(o.budget),
  }))));
ctx.command('search <query>').option('-n, --limit <n>')
  .action((query, o) => run(() => out(context.searchContext(db(), query, {
    limit: o.limit ? Number(o.limit) : undefined,
  }))));

// ---- model routing ----
const modelCmd = program.command('model');
modelCmd.command('recommend').description('Recommend a Claude model (§12.1)')
  .option('-g, --goal <goalId>').option('-c, --complexity <level>')
  .action((o) => run(() => out(recommendModel(db(), {
    goalId: o.goal, complexity: o.complexity as Complexity | undefined,
  }))));

program.parse();
```

`bin/brain.js`:

```js
#!/usr/bin/env node
import('../dist/cli/index.js');
```

- [ ] **Step 3: Write an end-to-end CLI test (spawns the real CLI against a temp DB)**

`tests/cli.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cli-'));
const env = { ...process.env, BRAIN_DB: path.join(tmp, 'brain.db') };

function brain(...args: string[]): any {
  const stdout = execFileSync('npx', ['tsx', 'src/cli/index.ts', ...args], { env, encoding: 'utf8' });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

describe('brain CLI end-to-end', () => {
  beforeAll(() => { brain('init'); });

  it('runs the §89 initial-deliverable flow', () => {
    const p = brain('project', 'add', 'central-brain', '--path', process.cwd());
    expect(p.id).toBe('central-brain');

    const g = brain('goal', 'create', 'Implement project scanning', '-o', 'Brain can scan ~/Projects');
    expect(g.status).toBe('DRAFT');

    const r = brain('goal', 'requirement', 'add', g.id, 'scanner detects package.json projects');
    brain('goal', 'lock', g.id);
    brain('goal', 'start', g.id);

    const wu = brain('work', 'create', g.id, 'Write scanner');
    expect(wu.id).toMatch(/^WU-/);

    brain('decision', 'add', 'Use fast-glob for scanning', '-g', g.id, '-r', 'simplest');
    brain('knowledge', 'add', 'Projects live under ~/Projects', '-s', 'GLOBAL');
    brain('learning', 'add', 'Scanning node_modules wastes minutes; always exclude it');

    const ctx = brain('context', 'get', '-g', g.id);
    expect(ctx.goal.id).toBe(g.id);
    expect(ctx.requirements.length).toBe(1);
    expect(ctx.knowledge.length).toBeGreaterThan(0);

    const hits = brain('knowledge', 'search', 'projects');
    expect(hits.length).toBeGreaterThan(0);

    const rec = brain('model', 'recommend', '-c', 'trivial');
    expect(rec.model).toBe('haiku');

    brain('work', 'update', wu.id, '--status', 'COMPLETED');
    brain('goal', 'requirement', 'status', String(r.id), 'PASSED');
    const done = brain('goal', 'complete', g.id);
    expect(done.status).toBe('COMPLETED');
  });

  it('fails loudly when completing with unmet criteria', () => {
    const g = brain('goal', 'create', 'Another goal');
    brain('goal', 'requirement', 'add', g.id, 'never verified');
    brain('goal', 'lock', g.id);
    expect(() => brain('goal', 'complete', g.id)).toThrow();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cli.test.ts` — Expected: 2 PASS (slow-ish; each `brain()` call spawns tsx). Then run the full suite: `npx vitest run` — Expected: all files PASS. Also run `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli src/db/backup.ts bin tests/cli.test.ts
git commit -m "feat: brain CLI covering full Phase 1 scope plus backup

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: MCP server

**Files:**
- Create: `src/mcp/server.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: all services; `openDb`/`migrateDb`
- Produces:
  - `buildServer(db: BrainDb): McpServer` exported for tests; running `npm run mcp` starts it on stdio
  - tools (each returns `{ content: [{ type: 'text', text: <pretty JSON> }] }`; errors return `isError: true` with the message): `brain_goal_create`, `brain_goal_get`, `brain_goal_list`, `brain_goal_current`, `brain_goal_lock`, `brain_goal_start`, `brain_goal_block`, `brain_goal_complete`, `brain_requirement_add`, `brain_requirement_set_status`, `brain_work_create`, `brain_work_update`, `brain_work_list`, `brain_project_add`, `brain_project_list`, `brain_repo_add`, `brain_knowledge_add`, `brain_knowledge_search`, `brain_knowledge_verify`, `brain_knowledge_invalidate`, `brain_learning_add`, `brain_learning_search`, `brain_learning_useful`, `brain_decision_add`, `brain_observation_add`, `brain_context_get`, `brain_context_search`, `brain_model_recommend`

- [ ] **Step 1: Write failing tests (in-memory client/server pair)**

`tests/mcp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDb } from './helpers.js';
import { buildServer } from '../src/mcp/server.js';

async function connect() {
  const db = createTestDb();
  const server = buildServer(db);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const text = (res: any) => JSON.parse(res.content[0].text);

describe('brain MCP server', () => {
  it('exposes the brain_* tool surface', async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map(t => t.name);
    for (const t of ['brain_goal_create', 'brain_context_get', 'brain_knowledge_search', 'brain_decision_add', 'brain_model_recommend']) {
      expect(tools).toContain(t);
    }
  });

  it('creates, locks, and retrieves context for a goal via tools', async () => {
    const client = await connect();
    const g = text(await client.callTool({
      name: 'brain_goal_create',
      arguments: { title: 'Add SSO', objective: 'MS auth works' },
    }));
    expect(g.id).toMatch(/^GOAL-/);
    await client.callTool({
      name: 'brain_requirement_add',
      arguments: { goalId: g.id, description: 'login works', type: 'success_criterion' },
    });
    await client.callTool({ name: 'brain_goal_lock', arguments: { id: g.id } });
    const ctx = text(await client.callTool({ name: 'brain_context_get', arguments: {} }));
    expect(ctx.goal.id).toBe(g.id);
    expect(ctx.requirements).toHaveLength(1);
  });

  it('surfaces service errors as tool errors', async () => {
    const client = await connect();
    const res: any = await client.callTool({ name: 'brain_goal_get', arguments: { id: 'GOAL-9999-9999' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mcp.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/mcp/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, type ZodRawShape } from 'zod';
import { openDb, migrateDb, type BrainDb } from '../db/connection.js';
import * as goals from '../services/goals.js';
import * as work from '../services/work.js';
import * as projects from '../services/projects.js';
import * as knowledge from '../services/knowledge.js';
import * as decisions from '../services/decisions.js';
import * as context from '../services/context.js';
import { recommendModel } from '../services/model.js';
import { search, type SearchType } from '../services/search.js';

export function buildServer(db: BrainDb): McpServer {
  const server = new McpServer({ name: 'central-brain', version: '0.1.0' });

  const tool = (name: string, description: string, shape: ZodRawShape, fn: (args: any) => unknown) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args: any) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(fn(args) ?? null, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    });
  };

  // goals
  tool('brain_goal_create', 'Create a new goal (DRAFT)', {
    title: z.string(), objective: z.string(),
    riskLevel: z.string().optional(), autonomyLevel: z.string().optional(),
    complexity: z.enum(['trivial', 'low', 'medium', 'high', 'critical']).optional(),
  }, (a) => goals.createGoal(db, a));
  tool('brain_goal_get', 'Get a goal with its requirements', { id: z.string() },
    (a) => ({ ...goals.getGoal(db, a.id), requirements: goals.listRequirements(db, a.id) }));
  tool('brain_goal_list', 'List goals, optionally by status', { status: z.string().optional() },
    (a) => goals.listGoals(db, a));
  tool('brain_goal_current', 'Get the currently active goal', {}, () => goals.currentGoal(db) ?? null);
  tool('brain_goal_lock', 'Lock the goal contract (freezes requirements)', { id: z.string() },
    (a) => goals.lockGoal(db, a.id));
  tool('brain_goal_start', 'Start executing a locked goal', { id: z.string() },
    (a) => goals.startGoal(db, a.id));
  tool('brain_goal_block', 'Mark a goal blocked with a reason', { id: z.string(), reason: z.string() },
    (a) => goals.blockGoal(db, a.id, a.reason));
  tool('brain_goal_complete', 'Complete a goal (fails on unmet required success criteria)', {
    id: z.string(), force: z.boolean().optional(),
  }, (a) => goals.completeGoal(db, a.id, { force: a.force }));
  tool('brain_requirement_add', 'Add a requirement to an unlocked goal', {
    goalId: z.string(), description: z.string(),
    type: z.string().default('success_criterion'),
    priority: z.enum(['required', 'optional']).optional(),
  }, (a) => goals.addRequirement(db, a.goalId, a));
  tool('brain_requirement_set_status', 'Set requirement status (PENDING|PASSED|FAILED|NOT_APPLICABLE)', {
    id: z.number(), status: z.enum(['PENDING', 'PASSED', 'FAILED', 'NOT_APPLICABLE']),
    reason: z.string().optional(),
  }, (a) => { goals.setRequirementStatus(db, a.id, a.status, a.reason); return { ok: true }; });

  // work
  tool('brain_work_create', 'Create a work unit under a goal', {
    goalId: z.string(), title: z.string(), description: z.string().optional(),
    workType: z.string().optional(), priority: z.number().optional(),
    complexity: z.enum(['trivial', 'low', 'medium', 'high', 'critical']).optional(),
    dependsOn: z.array(z.string()).optional(),
  }, (a) => work.createWorkUnit(db, a));
  tool('brain_work_update', 'Update a work unit (status/title)', {
    id: z.string(), status: z.string().optional(), title: z.string().optional(),
  }, (a) => work.updateWorkUnit(db, a.id, a));
  tool('brain_work_list', 'List work units for a goal', { goalId: z.string() },
    (a) => work.listWorkUnits(db, a.goalId));

  // projects / repos
  tool('brain_project_add', 'Register a project', {
    name: z.string(), rootPath: z.string().optional(), description: z.string().optional(),
  }, (a) => projects.addProject(db, a));
  tool('brain_project_list', 'List projects', {}, () => projects.listProjects(db));
  tool('brain_repo_add', 'Register a repository', {
    name: z.string(), projectId: z.string().optional(), path: z.string().optional(),
    remoteUrl: z.string().optional(), defaultBranch: z.string().optional(),
    language: z.string().optional(), framework: z.string().optional(),
  }, (a) => projects.addRepo(db, a));

  // knowledge / learnings
  tool('brain_knowledge_add', 'Store an atomic fact (scoped, confidence-rated)', {
    statement: z.string(), scopeType: z.string().default('GLOBAL'),
    scopeId: z.string().optional(), category: z.string().optional(),
    confidence: z.number().optional(), sourceType: z.string().optional(),
    sourceReference: z.string().optional(),
  }, (a) => knowledge.addKnowledge(db, a));
  tool('brain_knowledge_search', 'FTS search over active knowledge', {
    query: z.string(), limit: z.number().optional(),
  }, (a) => search(db, a.query, { types: ['knowledge' as SearchType], limit: a.limit }));
  tool('brain_knowledge_verify', 'Mark a fact as re-verified now', { id: z.number() },
    (a) => knowledge.verifyKnowledge(db, a.id));
  tool('brain_knowledge_invalidate', 'Mark a fact invalid', { id: z.number() },
    (a) => knowledge.invalidateKnowledge(db, a.id));
  tool('brain_learning_add', 'Store reusable experience-derived guidance', {
    learning: z.string(), scopeType: z.string().optional(),
    scopeId: z.string().optional(), trigger: z.string().optional(),
  }, (a) => knowledge.addLearning(db, a));
  tool('brain_learning_search', 'FTS search over learnings', {
    query: z.string(), limit: z.number().optional(),
  }, (a) => search(db, a.query, { types: ['learning' as SearchType], limit: a.limit }));
  tool('brain_learning_useful', 'Record that a learning was useful', { id: z.number() },
    (a) => knowledge.markLearningUseful(db, a.id));

  // decisions / observations
  tool('brain_decision_add', 'Record a decision with reasoning', {
    decision: z.string(), goalId: z.string().optional(), reason: z.string().optional(),
    alternatives: z.string().optional(), riskLevel: z.string().optional(),
    reversible: z.boolean().optional(), scopeType: z.string().optional(),
    scopeId: z.string().optional(),
  }, (a) => decisions.addDecision(db, a));
  tool('brain_observation_add', 'Record an observed fact during execution', {
    observation: z.string(), goalId: z.string().optional(), workUnitId: z.string().optional(),
    scopeType: z.string().optional(), scopeId: z.string().optional(),
  }, (a) => decisions.addObservation(db, a));

  // context
  tool('brain_context_get', 'Budgeted context for a goal (or the current goal)', {
    goalId: z.string().optional(), budget: z.number().optional(),
  }, (a) => context.getContext(db, a));
  tool('brain_context_search', 'FTS search across knowledge, learnings, decisions, failures, goals', {
    query: z.string(), limit: z.number().optional(),
  }, (a) => context.searchContext(db, a.query, a));

  // model routing
  tool('brain_model_recommend', 'Recommend a Claude model for a goal or explicit complexity (§12.1)', {
    goalId: z.string().optional(),
    complexity: z.enum(['trivial', 'low', 'medium', 'high', 'critical']).optional(),
  }, (a) => recommendModel(db, a));

  return server;
}

async function main(): Promise<void> {
  const db = openDb();
  migrateDb(db);
  await buildServer(db).connect(new StdioServerTransport());
}

// Only start stdio transport when run directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mcp.test.ts` — Expected: 3 PASS. Then `npx tsc --noEmit` — Expected: clean. (If the SDK's `registerTool` signature differs in the installed version, check `node_modules/@modelcontextprotocol/sdk` — do not guess; adjust the `tool()` helper only.)

- [ ] **Step 5: Commit**

```bash
git add src/mcp tests/mcp.test.ts
git commit -m "feat: MCP server exposing brain_* tools over the service layer

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Packaging, hooks, registration & bootstrap

**Files:**
- Create: `hooks/session-start.sh`, `README.md`
- Modify: `~/.claude/settings.json` (add SessionStart hook), Claude Code MCP registration (via `claude mcp add`)

**Interfaces:**
- Consumes: everything
- Produces: a globally-runnable `brain` command, a registered `central-brain` MCP server, a SessionStart hook injecting `brain context get`, and GOAL-001 recorded in the Brain itself (§90 bootstrap).

- [ ] **Step 1: Build and link the CLI globally (plus the `brain-claude` launcher)**

`bin/brain-claude`:

```bash
#!/usr/bin/env bash
# Launch Claude Code with the Brain-recommended model (ARCHITECTURE.md §12.1).
MODEL=$(node $HOME/Projects/central-brain/dist/cli/index.js model recommend 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).model)}catch{process.stdout.write('sonnet')}})")
exec claude --model "${MODEL:-sonnet}" "$@"
```

```bash
npm run build
chmod +x bin/brain.js bin/brain-claude
npm link
brain init
```

Expected: `{ "ok": true, "database": "$HOME/.central-brain/brain.db" }`. Then `brain model recommend -c trivial` prints `{ "model": "haiku", ... }`.

- [ ] **Step 2: Register the MCP server with Claude Code (user scope)**

```bash
claude mcp add central-brain -s user -- node $HOME/Projects/central-brain/dist/mcp/server.js
claude mcp list
```

Expected: `central-brain` listed. (Uses the built `dist` output so no tsx dependency at runtime.)

- [ ] **Step 3: Create the SessionStart hook**

`hooks/session-start.sh`:

```bash
#!/usr/bin/env bash
# Injects current Brain context into every Claude Code session (ARCHITECTURE.md §52.1).
node $HOME/Projects/central-brain/dist/cli/index.js context get --current --budget 30 2>/dev/null || true
```

```bash
chmod +x hooks/session-start.sh
```

Then add to `~/.claude/settings.json` under `hooks` (merge with any existing hooks — read the file first and preserve existing entries):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/Projects/central-brain/hooks/session-start.sh" }
        ]
      }
    ]
  }
}
```

Verify: start a new `claude` session in any directory and confirm the Brain context JSON appears in the session's injected context (or run the hook script manually and check it prints JSON).

- [ ] **Step 4: Bootstrap — record GOAL-001 in the Brain (§89–90)**

```bash
brain project add "central-brain" --path $HOME/Projects/central-brain
brain repo add "central-brain" --project central-brain --language typescript --framework node
brain goal create "Build Central Brain MVP" -o "Persistent SQLite brain with CLI, MCP server, FTS5 search, and session hooks per ARCHITECTURE.md v0.2 Milestone 1"
# note the printed id (GOAL-<year>-0001) and use it below
brain goal requirement add GOAL-<year>-0001 "All vitest suites pass" -t success_criterion
brain goal requirement add GOAL-<year>-0001 "brain CLI covers the full §77 command scope" -t success_criterion
brain goal requirement add GOAL-<year>-0001 "MCP server registered and tools callable from Claude Code" -t success_criterion
brain goal lock GOAL-<year>-0001
brain goal start GOAL-<year>-0001
brain decision add "Pulled MCP + hooks into Milestone 1; Central Brain replaces claude-mem (no coexistence)" -g GOAL-<year>-0001 -r "Claude Code is the primary consumer; parallel memory systems diverge"
brain knowledge add "brain.db lives at ~/.central-brain/brain.db; BRAIN_DB overrides" -s GLOBAL
```

- [ ] **Step 5: Verify success criteria, complete the goal, disable claude-mem**

```bash
npx vitest run                       # all suites green
brain context get --current          # returns GOAL-001 context
brain goal requirement status 1 PASSED
brain goal requirement status 2 PASSED
brain goal requirement status 3 PASSED
brain goal complete GOAL-<year>-0001
brain backup
```

Then retire claude-mem per §2.4: disable/uninstall the claude-mem plugin for this user (e.g. via `claude plugin` management or its own uninstall path — inspect how it is installed first; do not delete its database, which stays as an archive for the optional Phase 3 import).

- [ ] **Step 6: Write a short README and final commit**

`README.md`:

```markdown
# Central Brain

Persistent goal-oriented memory for Claude Code. See ARCHITECTURE.md.

- DB: `~/.central-brain/brain.db` (override with `BRAIN_DB`)
- CLI: `brain --help` (build: `npm run build`; dev: `npm run brain --`)
- MCP: registered as `central-brain` (tools `brain_*`)
- Hook: `hooks/session-start.sh` injects `brain context get` into every session
- Backup: `brain backup` → `~/.central-brain/backups/`
- Tests: `npm test`
```

```bash
git add hooks README.md
git commit -m "feat: session hooks, MCP registration, bootstrap GOAL-001

Goal: GOAL-001

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification (whole-milestone)

- `npx vitest run` — every suite passes
- `npx tsc --noEmit` — clean
- §89 flow works end-to-end through the real CLI (covered by `tests/cli.test.ts` and repeated live in Task 13)
- `brain context get --current` returns budgeted JSON with the active goal
- MCP tools callable from a live Claude Code session (`/mcp` shows central-brain; `brain_goal_current` returns GOAL-001)
- New Claude session receives Brain context via the SessionStart hook
- `~/.central-brain/backups/` contains at least one snapshot
- `brain model recommend -c trivial` → `haiku`; `brain context get` includes `recommendedModel`; `brain-claude` launches `claude --model <routed>`

## Explicitly out of scope (later phases, per amended spec)

- project/repository scanners, failure CLI, verification CLI (Phase 2)
- claude-mem data import; hybrid semantic search via embeddings/Qdrant (Phase 3)
- goal intake automation, planner, execution engine, approval *enforcement* (Phases 4+)

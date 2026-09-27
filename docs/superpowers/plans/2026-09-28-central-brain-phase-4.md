# Central Brain Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Autonomous Goal Intake — a re-runnable intake report, stored/batched clarification questions, a §9 lock gate, and a migration guard — tracked as GOAL-2026-0004.

**Architecture:** `goals.ts` owns the contract: `checkContract()` (sync, model-free) and a gated `lockGoal()`. A new `questions.ts` owns the question lifecycle. A new `intake.ts` builds the async report (hybrid-search context, review items, duplicates) and upserts deterministic gap questions. Passive entry points (SessionStart `context get`, MCP startup) stop auto-migrating; `brain migrate` is the explicit upgrade.

**Tech Stack:** TypeScript ESM, drizzle-orm + better-sqlite3, commander, @modelcontextprotocol/sdk, zod, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-central-brain-phase-4-goal-intake-design.md` (authority: `ARCHITECTURE.md` §8, §9, §12, §20, §80).

## Global Constraints

- ESM only; relative imports carry `.js`; `npx tsc --noEmit` clean and full `npx vitest run` green before every commit (suite is 86/86 at `4b742f8`).
- Commit after every task; message ends with a blank line, `Goal: GOAL-2026-0004`, a blank line, `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Commit by path (`git commit -m … -- <paths>`), never `git add -A`.
- Risk levels exactly `LOW`, `MEDIUM`, `HIGH`, `IRREVERSIBLE`, accepted case-insensitively and stored uppercase. Requirement types: existing `objective, constraint, success_criterion, exclusion, assumption` plus `scope`, `permission`.
- `--as` answer types exactly: `constraint, exclusion, assumption, scope, permission, success_criterion`.
- Question status: `pending | answered | dismissed`; materiality: `material | detail`; source: `brain | session`.
- Gap check keys: `missing:objective`, `missing:success_criterion`, `missing:scope`, `missing:risk_level`.
- Semantic duplicate threshold: cosine ≥ 0.90. Intake context: top 5 per type.
- Lock-path code (`checkContract`, `lockGoal`, `context get`) must never import or initialise the embedder.
- Never open/write `~/.central-brain/brain.db` or `~/.claude-mem` in tests; temp DBs only. The live DB is touched only in Task 7.
- MCP tool count after this plan: 48 (42 + `brain_goal_intake`, `brain_goal_set`, `brain_question_add`, `brain_question_answer`, `brain_question_dismiss`, `brain_question_list`).
- Existing interfaces kept: sync `search()`, `hybridSearch()`, `getGoal`, `listRequirements`, `addRequirement`, `addDecision`, `createTestDb`.

## Review Focus

1. Filling a contract field directly (e.g. `requirement add -t scope`) without answering its `missing:scope` question must not leave lock blocked — `checkContract` ignores Brain gap questions whose gap is resolved. (Test in Task 3.)
2. Re-running intake after a Brain gap question was answered or dismissed must not recreate it. (Test in Task 4.)
3. Force-locking with open material questions records a decision naming what was unresolved, and `clarificationStatus` stays `pending` (it is no longer forced at lock). (Test in Task 2.)
4. A brand-new DB opened via the passive `context get` path still initialises (fresh DBs have nothing to protect) instead of crashing. (Test in Task 5.)
5. `question answer --as <invalid>` leaves the question pending with no requirement written (no partial write). (Test in Task 3.)

---

### Task 1: Schema — goal_questions intake columns, pending-migration helper, snapshot location

**Files:**
- Modify: `src/db/schema.ts` (goalQuestions table), `src/db/connection.ts`
- Create: generated migration under `drizzle/` (via drizzle-kit)
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `goalQuestions` columns `materiality`, `source`, `checkKey`, `requirementId`, `statusReason`; unique index `goal_questions_goal_check` on (goal_id, check_key); `pendingMigrations(db: BrainDb): number`; `appliedMigrations(db: BrainDb): number`; `snapshotDir(db: BrainDb): string`.

- [ ] **Step 1: Write failing tests** — append inside the existing describe in `tests/db.test.ts` (add imports `pendingMigrations`, `snapshotDir` from `../src/db/connection.js`, `createGoal` from `../src/services/goals.js`, plus `fs`, `os`, `path` from node if not present):

```ts
  it('phase 4 schema: goal_questions intake columns and per-goal unique check key', () => {
    const db = createTestDb();
    const cols = (db.$client.prepare('PRAGMA table_info(goal_questions)').all() as { name: string }[]).map(c => c.name);
    for (const c of ['materiality', 'source', 'check_key', 'requirement_id', 'status_reason']) expect(cols).toContain(c);
    const g = createGoal(db, { title: 't', objective: 'o' });
    const ins = db.$client.prepare('INSERT INTO goal_questions (goal_id, question, check_key, created_at) VALUES (?, ?, ?, ?)');
    const ts = new Date().toISOString();
    ins.run(g.id, 'q1', 'missing:scope', ts);
    expect(() => ins.run(g.id, 'q2', 'missing:scope', ts)).toThrow(/UNIQUE/);
    ins.run(g.id, 'q3', null, ts);
    ins.run(g.id, 'q4', null, ts); // NULL check keys never collide
    const row = db.$client.prepare("SELECT materiality, source, status FROM goal_questions WHERE question = 'q3'").get() as any;
    expect(row).toEqual({ materiality: 'material', source: 'session', status: 'pending' });
  });

  it('pendingMigrations counts journal entries not yet applied', () => {
    const db = createTestDb();
    expect(pendingMigrations(db)).toBe(0);
    db.$client.prepare('DELETE FROM __drizzle_migrations WHERE id = (SELECT max(id) FROM __drizzle_migrations)').run();
    expect(pendingMigrations(db)).toBe(1);
  });

  it('snapshots go next to the database file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-snap-'));
    const db = openDb(path.join(dir, 'brain.db'));
    expect(snapshotDir(db)).toBe(path.join(dir, 'backups'));
  });
```

- [ ] **Step 2: Run** `npx vitest run tests/db.test.ts 2>&1 | tail -15` — the three new tests FAIL (missing exports/columns).

- [ ] **Step 3: Extend the schema.** In `src/db/schema.ts`, replace the `goalQuestions` table with (keep column order; add the table-level index callback):

```ts
export const goalQuestions = sqliteTable('goal_questions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id').notNull().references(() => goals.id),
  question: text('question').notNull(),
  answer: text('answer'),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  answeredAt: text('answered_at'),
  materiality: text('materiality').notNull().default('material'),
  source: text('source').notNull().default('session'),
  checkKey: text('check_key'),
  requirementId: integer('requirement_id'),
  statusReason: text('status_reason'),
}, (t) => [uniqueIndex('goal_questions_goal_check').on(t.goalId, t.checkKey)]);
```

Then `npx drizzle-kit generate 2>&1 | tail -5` and confirm the new SQL file contains five `ALTER TABLE goal_questions ADD …` statements and one `CREATE UNIQUE INDEX goal_questions_goal_check`. (SQLite treats NULLs as distinct in unique indexes, so NULL check keys never collide.)

- [ ] **Step 4: Connection helpers.** In `src/db/connection.ts` add after `packageRoot()`, and make `migrateDb` use them:

```ts
function migrationsFolder(): string {
  return path.join(packageRoot(), 'drizzle');
}

export function appliedMigrations(db: BrainDb): number {
  try {
    return (db.$client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
  } catch {
    return 0; // fresh DB: migrations table does not exist yet
  }
}

export function pendingMigrations(db: BrainDb): number {
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder(), 'meta', '_journal.json'), 'utf8'));
  return Math.max(0, journal.entries.length - appliedMigrations(db));
}

export function snapshotDir(db: BrainDb): string {
  return path.join(path.dirname(db.$client.name), 'backups');
}
```

Replace the body of `migrateDb` with:

```ts
export function migrateDb(db: BrainDb): void {
  const applied = appliedMigrations(db);
  if (applied > 0 && pendingMigrations(db) > 0 && db.$client.name !== ':memory:') {
    backupDb(db, snapshotDir(db));
  }
  migrate(db, { migrationsFolder: migrationsFolder() });
}
```

(For the live DB `snapshotDir` is `~/.central-brain/backups`, identical to today; temp-dir DBs now snapshot into their own directory instead of the user's.)

- [ ] **Step 5: Run** `npx vitest run tests/db.test.ts 2>&1 | tail -8` (all pass), then full suite and `npx tsc --noEmit 2>&1 | tail -5`.

- [ ] **Step 6: Commit** `src/db/schema.ts src/db/connection.ts drizzle tests/db.test.ts` — message `feat: goal_questions intake columns, pending-migration helper, co-located snapshots`.

---

### Task 2: Contract check and gated lock (+ thin CLI/MCP surface so existing flows keep working)

**Files:**
- Modify: `src/services/goals.ts`, `src/cli/index.ts` (goal lock/set, requirement types), `src/mcp/server.ts` (brain_goal_lock args, brain_goal_set, requirement enum)
- Modify tests: `tests/helpers.ts`, `tests/goals.test.ts`, `tests/context.test.ts`, `tests/resume.test.ts`, `tests/model.test.ts`, `tests/cli.test.ts`, `tests/mcp.test.ts`
- Test: `tests/contract.test.ts` (new)

**Interfaces:**
- Consumes: `goalQuestions` (Task 1), `addDecision` from `src/services/decisions.js`.
- Produces (from `src/services/goals.js`): `RISK_LEVELS: readonly string[]`; `type GoalQuestion = typeof goalQuestions.$inferSelect`; `interface ContractGap { field: 'objective' | 'success_criterion' | 'scope' | 'risk_level'; message: string }`; `interface ContractCheck { ready: boolean; gaps: ContractGap[]; openQuestions: GoalQuestion[] }`; `checkContract(db, goalId): ContractCheck`; `setGoalFields(db, id, { riskLevel?, autonomyLevel? }): Goal`; `lockGoal(db, id, opts?: { force?: boolean; reason?: string }): Goal`; `class ContractIncompleteError extends Error`. Test helper `makeLockable(db, goalId)` in `tests/helpers.ts`. CLI `goal set <id> [--risk] [--autonomy]`, `goal lock <id> [--force] [--reason <text>]`. MCP `brain_goal_set {id, risk?, autonomy?}`; `brain_goal_lock {id, force?, reason?}`; `brain_requirement_add` type enum gains `scope`, `permission`.

- [ ] **Step 1: Write failing tests** — create `tests/contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import {
  createGoal, addRequirement, checkContract, lockGoal, setGoalFields, getGoal, ContractIncompleteError,
} from '../src/services/goals.js';
import { listDecisions } from '../src/services/decisions.js';

function addOpenQuestion(db: ReturnType<typeof createTestDb>, goalId: string, q: string) {
  db.$client.prepare('INSERT INTO goal_questions (goal_id, question, created_at) VALUES (?, ?, ?)')
    .run(goalId, q, new Date().toISOString());
}

describe('goal contract (§9) and lock gate', () => {
  it('reports each missing field, then ready once filled', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'SSO', objective: 'Users sign in with Microsoft' });
    expect(checkContract(db, g.id).gaps.map(x => x.field).sort())
      .toEqual(['risk_level', 'scope', 'success_criterion']);
    addRequirement(db, g.id, { type: 'success_criterion', description: 'MS login works' });
    addRequirement(db, g.id, { type: 'scope', description: 'auth service + login UI' });
    setGoalFields(db, g.id, { riskLevel: 'HIGH' });
    expect(checkContract(db, g.id)).toMatchObject({ ready: true, gaps: [] });
  });

  it('optional success criteria do not satisfy the gate; open material questions block', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', riskLevel: 'LOW' });
    addRequirement(db, g.id, { type: 'scope', description: 's' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'nice', priority: 'optional' });
    expect(checkContract(db, g.id).gaps.map(x => x.field)).toEqual(['success_criterion']);
    addRequirement(db, g.id, { type: 'success_criterion', description: 'must' });
    addOpenQuestion(db, g.id, 'Keep password login?');
    const c = checkContract(db, g.id);
    expect(c.ready).toBe(false);
    expect(c.openQuestions.map(q => q.question)).toEqual(['Keep password login?']);
  });

  it('lock refuses an incomplete contract and lists what is missing', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => lockGoal(db, g.id)).toThrow(ContractIncompleteError);
    expect(() => lockGoal(db, g.id)).toThrow(/scope/);
    expect(getGoal(db, g.id).status).toBe('DRAFT');
  });

  it('--force requires a reason, records a decision, keeps clarification pending', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addOpenQuestion(db, g.id, 'Keep password login?');
    expect(() => lockGoal(db, g.id, { force: true })).toThrow(/reason/);
    const locked = lockGoal(db, g.id, { force: true, reason: 'spike, contract later' });
    expect(locked.status).toBe('LOCKED');
    expect(locked.clarificationStatus).toBe('pending');
    const d = listDecisions(db, { goalId: g.id });
    expect(d).toHaveLength(1);
    expect(d[0]!.riskLevel).toBe('MEDIUM');
    expect(d[0]!.reason).toContain('spike, contract later');
    expect(d[0]!.reason).toContain('Keep password login?');
  });

  it('snapshot freezes risk, autonomy and answered questions', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', riskLevel: 'LOW' });
    addRequirement(db, g.id, { type: 'scope', description: 's' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'c' });
    db.$client.prepare("INSERT INTO goal_questions (goal_id, question, answer, status, created_at) VALUES (?, 'Q?', 'A.', 'answered', ?)")
      .run(g.id, new Date().toISOString());
    const snap = JSON.parse(lockGoal(db, g.id).contractSnapshot!);
    expect(snap).toMatchObject({ riskLevel: 'LOW', autonomyLevel: 'full', answeredQuestions: [{ question: 'Q?', answer: 'A.' }] });
    expect(snap.requirements).toHaveLength(2);
  });

  it('risk levels are validated case-insensitively and stored uppercase; locked goals refuse edits', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => setGoalFields(db, g.id, { riskLevel: 'medium-ish' })).toThrow(/risk level/i);
    expect(() => createGoal(db, { title: 'x', objective: 'y', riskLevel: 'extreme' })).toThrow(/risk level/i);
    expect(createGoal(db, { title: 'x', objective: 'y', riskLevel: 'high' }).riskLevel).toBe('HIGH');
    expect(setGoalFields(db, g.id, { riskLevel: 'irreversible' }).riskLevel).toBe('IRREVERSIBLE');
    lockGoal(db, g.id, { force: true, reason: 'test' });
    expect(() => setGoalFields(db, g.id, { riskLevel: 'LOW' })).toThrow(/locked/);
  });

  it('accepts scope and permission requirement types', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(addRequirement(db, g.id, { type: 'permission', description: 'may deploy staging' }).requirementType).toBe('permission');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/contract.test.ts 2>&1 | tail -15` — FAIL (missing exports).

- [ ] **Step 3: Implement in `src/services/goals.ts`.**
  - Imports: `import { and, desc, eq, inArray } from 'drizzle-orm';`, add `goalQuestions` to the schema import, and `import { addDecision } from './decisions.js';`.
  - Add exports near the top:

```ts
export type GoalQuestion = typeof goalQuestions.$inferSelect;
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'IRREVERSIBLE'] as const;
export class ContractIncompleteError extends Error {}
export interface ContractGap { field: 'objective' | 'success_criterion' | 'scope' | 'risk_level'; message: string }
export interface ContractCheck { ready: boolean; gaps: ContractGap[]; openQuestions: GoalQuestion[] }

/** Case-insensitive; returns the canonical uppercase level (model routing already upper-cases). */
function normaliseRiskLevel(level: string): string {
  const up = level.trim().toUpperCase();
  if (!(RISK_LEVELS as readonly string[]).includes(up)) {
    throw new Error(`Invalid risk level: ${level} (expected ${RISK_LEVELS.join(', ')})`);
  }
  return up;
}
```

  - In `createGoal`, before the insert: `const riskLevel = input.riskLevel !== undefined ? normaliseRiskLevel(input.riskLevel) : null;` and insert `riskLevel` instead of `input.riskLevel ?? null`.
  - `VALID_REQUIREMENT_TYPES` becomes `['objective', 'constraint', 'success_criterion', 'exclusion', 'assumption', 'scope', 'permission']`.
  - Add after `listRequirements`:

```ts
export function checkContract(db: BrainDb, goalId: string): ContractCheck {
  const g = getGoal(db, goalId);
  const reqs = listRequirements(db, goalId);
  const gaps: ContractGap[] = [];
  if (!g.objective.trim()) gaps.push({ field: 'objective', message: 'Objective is empty' });
  if (!reqs.some(r => r.requirementType === 'success_criterion' && r.priority === 'required')) {
    gaps.push({ field: 'success_criterion', message: 'No required success criterion' });
  }
  if (!reqs.some(r => r.requirementType === 'scope')) gaps.push({ field: 'scope', message: 'No scope defined' });
  if (!g.riskLevel) gaps.push({ field: 'risk_level', message: 'Risk level not set' });
  const openGapKeys = new Set(gaps.map(x => `missing:${x.field}`));
  const openQuestions = db.select().from(goalQuestions).where(and(
    eq(goalQuestions.goalId, goalId), eq(goalQuestions.status, 'pending'), eq(goalQuestions.materiality, 'material'),
  )).all().filter(q =>
    // a Brain gap question stops blocking as soon as its field is filled (Review Focus 1)
    !(q.source === 'brain' && q.checkKey?.startsWith('missing:') && !openGapKeys.has(q.checkKey)));
  return { ready: gaps.length === 0 && openQuestions.length === 0, gaps, openQuestions };
}

export function setGoalFields(
  db: BrainDb, id: string, input: { riskLevel?: string; autonomyLevel?: string },
): Goal {
  const g = getGoal(db, id);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${id} is locked; contract fields are frozen (§18).`);
  const set: Partial<typeof goals.$inferInsert> = { updatedAt: now() };
  if (input.riskLevel !== undefined) set.riskLevel = normaliseRiskLevel(input.riskLevel);
  if (input.autonomyLevel !== undefined) set.autonomyLevel = input.autonomyLevel;
  db.update(goals).set(set).where(eq(goals.id, id)).run();
  return getGoal(db, id);
}
```

  - Replace `lockGoal`:

```ts
export function lockGoal(db: BrainDb, id: string, opts: { force?: boolean; reason?: string } = {}): Goal {
  const g = getGoal(db, id);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${id} is already locked.`);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot lock.`);
  if (opts.force && !opts.reason?.trim()) throw new Error('Force-locking requires a reason (recorded as a decision).');
  const check = checkContract(db, id);
  const unresolved = [
    ...check.gaps.map(x => x.message),
    ...check.openQuestions.map(q => `open question #${q.id}: ${q.question}`),
  ];
  if (!check.ready) {
    if (!opts.force) {
      throw new ContractIncompleteError(`Cannot lock ${id}; contract incomplete (§9): ${unresolved.join('; ')}`);
    }
    addDecision(db, {
      goalId: id, decision: `Force-locked ${id} with an incomplete contract`,
      reason: `${opts.reason} | unresolved: ${unresolved.join('; ')}`, riskLevel: 'MEDIUM', reversible: true,
    });
  }
  const answered = db.select().from(goalQuestions)
    .where(and(eq(goalQuestions.goalId, id), eq(goalQuestions.status, 'answered'))).all();
  const snapshot = JSON.stringify({
    objective: g.objective, riskLevel: g.riskLevel, autonomyLevel: g.autonomyLevel,
    requirements: listRequirements(db, id).map(r => ({
      type: r.requirementType, description: r.description, priority: r.priority,
    })),
    answeredQuestions: answered.map(q => ({ question: q.question, answer: q.answer })),
  });
  return setStatus(db, id, 'LOCKED', { lockedAt: now(), contractSnapshot: snapshot });
}
```

(`clarificationStatus` is no longer set at lock; Task 3 maintains it.)

- [ ] **Step 4: Thin surfaces.** In `src/cli/index.ts`:
  - Replace `goal.command('lock <id>')…` with:

```ts
goal.command('lock <id>').option('--force', 'lock despite contract gaps (requires --reason)')
  .option('--reason <text>', 'why force-locking is acceptable (recorded as a decision)')
  .action((id, o) => run(() => out(goals.lockGoal(db(), id, { force: o.force, reason: o.reason }))));
goal.command('set <id>').description('Set contract fields on an unlocked goal')
  .option('--risk <level>', 'LOW|MEDIUM|HIGH|IRREVERSIBLE').option('--autonomy <level>')
  .action((id, o) => run(() => out(goals.setGoalFields(db(), id, { riskLevel: o.risk, autonomyLevel: o.autonomy }))));
```

  - In `req.command('add …')`, change the `-t, --type` help text to `'objective|constraint|success_criterion|exclusion|assumption|scope|permission'`.

  In `src/mcp/server.ts`:
  - Replace `brain_goal_lock` with:

```ts
  tool('brain_goal_lock', 'Lock the goal contract; refuses §9 gaps/open material questions unless force+reason', {
    id: z.string(), force: z.boolean().optional(), reason: z.string().optional(),
  }, (a) => goals.lockGoal(db, a.id, { force: a.force, reason: a.reason }));
  tool('brain_goal_set', 'Set contract fields (risk, autonomy) on an unlocked goal', {
    id: z.string(), risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'IRREVERSIBLE']).optional(), autonomy: z.string().optional(),
  }, (a) => goals.setGoalFields(db, a.id, { riskLevel: a.risk, autonomyLevel: a.autonomy }));
```

  - In `brain_requirement_add`, the type enum becomes `z.enum(['objective', 'constraint', 'success_criterion', 'exclusion', 'assumption', 'scope', 'permission'])`.

- [ ] **Step 5: Keep existing tests valid under the gate.** Add to `tests/helpers.ts`:

```ts
import { addRequirement, listRequirements, setGoalFields } from '../src/services/goals.js';

/** Give a test goal the §9 minimum contract so lockGoal passes the gate. */
export function makeLockable(db: BrainDb, goalId: string): void {
  setGoalFields(db, goalId, { riskLevel: 'LOW' });
  addRequirement(db, goalId, { type: 'scope', description: 'test scope' });
  if (!listRequirements(db, goalId).some(r => r.requirementType === 'success_criterion' && r.priority === 'required')) {
    addRequirement(db, goalId, { type: 'success_criterion', description: 'test criterion' });
  }
}
```

  Insert `makeLockable(db, g.id);` immediately before every `lockGoal(db, g.id)` in `tests/goals.test.ts`, `tests/context.test.ts`, `tests/model.test.ts`, `tests/resume.test.ts` (import `makeLockable` from `./helpers.js`). Then update the assertions that counted requirements: `tests/goals.test.ts` snapshot `snap.requirements` → `toHaveLength(2)`; `tests/context.test.ts` `ctx.requirements` → `toHaveLength(2)`.
  In `tests/cli.test.ts`, before each `brain('goal', 'lock', g.id);` insert:

```ts
    brain('goal', 'requirement', 'add', g.id, 'test scope', '-t', 'scope');
    brain('goal', 'set', g.id, '--risk', 'LOW');
```

  In `tests/mcp.test.ts`, before the `brain_goal_lock` call insert:

```ts
    await client.callTool({ name: 'brain_requirement_add', arguments: { goalId: g.id, description: 'auth only', type: 'scope' } });
    await client.callTool({ name: 'brain_goal_set', arguments: { id: g.id, risk: 'LOW' } });
```

  and change its `ctx.requirements` expectation to `toHaveLength(2)`.
  (The resume test's DRAFT recommendation regex is updated in Task 5, not here — it still passes now because `recommend()` is unchanged.)

- [ ] **Step 6: Run** `npx vitest run tests/contract.test.ts 2>&1 | tail -8` (7 pass), full suite, `npx tsc --noEmit`.

- [ ] **Step 7: Commit** `src/services/goals.ts src/cli/index.ts src/mcp/server.ts tests/helpers.ts tests/contract.test.ts tests/goals.test.ts tests/context.test.ts tests/model.test.ts tests/resume.test.ts tests/cli.test.ts tests/mcp.test.ts` — message `feat: §9 contract check and gated goal lock with force+reason`.

---

### Task 3: Question lifecycle service

**Files:**
- Create: `src/services/questions.ts`
- Test: `tests/questions.test.ts`

**Interfaces:**
- Consumes: `goalQuestions` (Task 1); `getGoal`, `addRequirement`, `checkContract`, `GoalLockedError`, `type GoalQuestion` (Task 2).
- Produces (from `src/services/questions.js`): `ANSWER_AS_TYPES`; `getQuestion(db, id: number): GoalQuestion`; `listQuestions(db, goalId, opts?: { open?: boolean }): GoalQuestion[]` (open = status pending); `addQuestion(db, goalId, input: { question: string; materiality?: 'material' | 'detail'; source?: 'brain' | 'session'; checkKey?: string }): GoalQuestion`; `answerQuestion(db, id, answer: string, opts?: { as?: string }): GoalQuestion`; `dismissQuestion(db, id, reason: string): GoalQuestion`; `upsertBrainQuestion(db, goalId, checkKey: string, question: string): { question: GoalQuestion; created: boolean }`; `refreshClarificationStatus(db, goalId): 'pending' | 'complete'`.

- [ ] **Step 1: Write failing tests** — `tests/questions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable } from './helpers.js';
import { createGoal, getGoal, listRequirements, checkContract, lockGoal, setGoalFields, addRequirement } from '../src/services/goals.js';
import {
  addQuestion, answerQuestion, dismissQuestion, listQuestions, upsertBrainQuestion,
} from '../src/services/questions.js';

describe('goal questions', () => {
  it('add → answer --as creates a linked requirement; clarification status tracks open material questions', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const q = addQuestion(db, g.id, { question: 'Keep password login?' });
    expect(q).toMatchObject({ status: 'pending', materiality: 'material', source: 'session' });
    expect(getGoal(db, g.id).clarificationStatus).toBe('pending');
    const a = answerQuestion(db, q.id, 'Yes, keep it as fallback', { as: 'constraint' });
    expect(a.status).toBe('answered');
    const req = listRequirements(db, g.id).find(r => r.id === a.requirementId)!;
    expect(req).toMatchObject({ requirementType: 'constraint', description: 'Yes, keep it as fallback' });
    expect(getGoal(db, g.id).clarificationStatus).toBe('complete');
  });

  it('detail questions never block; dismiss needs a reason', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addQuestion(db, g.id, { question: 'Service class name?', materiality: 'detail' });
    expect(getGoal(db, g.id).clarificationStatus).toBe('complete');
    const q = addQuestion(db, g.id, { question: 'Provision new users?' });
    expect(() => dismissQuestion(db, q.id, ' ')).toThrow(/reason/);
    expect(dismissQuestion(db, q.id, 'implementation detail').status).toBe('dismissed');
    expect(listQuestions(db, g.id, { open: true }).map(x => x.question)).toEqual(['Service class name?']);
  });

  it('invalid --as leaves the question pending and writes no requirement (Review Focus 5)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const q = addQuestion(db, g.id, { question: 'Q?' });
    expect(() => answerQuestion(db, q.id, 'A', { as: 'objective' })).toThrow(/--as/);
    expect(listQuestions(db, g.id)[0]!.status).toBe('pending');
    expect(listRequirements(db, g.id)).toHaveLength(0);
  });

  it('answering twice, empty answers, and edits after lock are rejected', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const q = addQuestion(db, g.id, { question: 'Q?' });
    expect(() => answerQuestion(db, q.id, '  ')).toThrow(/empty/);
    answerQuestion(db, q.id, 'A');
    expect(() => answerQuestion(db, q.id, 'B')).toThrow(/answered/);
    const q2 = addQuestion(db, g.id, { question: 'Q2?', materiality: 'detail' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    expect(() => addQuestion(db, g.id, { question: 'late' })).toThrow(/locked/);
    expect(() => answerQuestion(db, q2.id, 'late')).toThrow(/locked/);
  });

  it('upsertBrainQuestion is idempotent per check key', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(upsertBrainQuestion(db, g.id, 'missing:scope', 'What is in scope?').created).toBe(true);
    expect(upsertBrainQuestion(db, g.id, 'missing:scope', 'What is in scope?').created).toBe(false);
    expect(listQuestions(db, g.id)).toHaveLength(1);
    expect(listQuestions(db, g.id)[0]).toMatchObject({ source: 'brain', checkKey: 'missing:scope' });
  });

  it('filling a field directly unblocks its brain gap question (Review Focus 1)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    upsertBrainQuestion(db, g.id, 'missing:scope', 'What is in scope?');
    addRequirement(db, g.id, { type: 'scope', description: 'auth only' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'c' });
    setGoalFields(db, g.id, { riskLevel: 'LOW' });
    expect(checkContract(db, g.id).ready).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/questions.test.ts 2>&1 | tail -15` — FAIL (module missing).

- [ ] **Step 3: Implement** `src/services/questions.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goalQuestions, goals } from '../db/schema.js';
import { addRequirement, getGoal, GoalLockedError, type GoalQuestion } from './goals.js';

export const ANSWER_AS_TYPES = ['constraint', 'exclusion', 'assumption', 'scope', 'permission', 'success_criterion'];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const now = () => new Date().toISOString();

function assertEditable(db: BrainDb, goalId: string): void {
  const g = getGoal(db, goalId);
  if (g.lockedAt || TERMINAL.includes(g.status)) {
    throw new GoalLockedError(`Goal ${goalId} is locked; questions are frozen (§18).`);
  }
}

export function getQuestion(db: BrainDb, id: number): GoalQuestion {
  const q = db.select().from(goalQuestions).where(eq(goalQuestions.id, id)).get();
  if (!q) throw new Error(`Question not found: #${id}`);
  return q;
}

export function listQuestions(db: BrainDb, goalId: string, opts: { open?: boolean } = {}): GoalQuestion[] {
  const rows = db.select().from(goalQuestions).where(eq(goalQuestions.goalId, goalId)).all();
  return opts.open ? rows.filter(q => q.status === 'pending') : rows;
}

export function refreshClarificationStatus(db: BrainDb, goalId: string): 'pending' | 'complete' {
  const open = db.select().from(goalQuestions).where(and(
    eq(goalQuestions.goalId, goalId), eq(goalQuestions.status, 'pending'), eq(goalQuestions.materiality, 'material'),
  )).all().length;
  const status = open > 0 ? 'pending' : 'complete';
  db.update(goals).set({ clarificationStatus: status }).where(eq(goals.id, goalId)).run();
  return status;
}

export function addQuestion(
  db: BrainDb, goalId: string,
  input: { question: string; materiality?: 'material' | 'detail'; source?: 'brain' | 'session'; checkKey?: string },
): GoalQuestion {
  assertEditable(db, goalId);
  if (!input.question.trim()) throw new Error('Question text is empty.');
  const res = db.insert(goalQuestions).values({
    goalId, question: input.question.trim(), materiality: input.materiality ?? 'material',
    source: input.source ?? 'session', checkKey: input.checkKey ?? null, createdAt: now(),
  }).run();
  refreshClarificationStatus(db, goalId);
  return getQuestion(db, Number(res.lastInsertRowid));
}

export function answerQuestion(db: BrainDb, id: number, answer: string, opts: { as?: string } = {}): GoalQuestion {
  const q = getQuestion(db, id);
  assertEditable(db, q.goalId);
  if (q.status !== 'pending') throw new Error(`Question #${id} is already ${q.status}.`);
  if (!answer.trim()) throw new Error('Answer is empty.');
  if (opts.as !== undefined && !ANSWER_AS_TYPES.includes(opts.as)) {
    throw new Error(`Invalid --as type: ${opts.as} (expected ${ANSWER_AS_TYPES.join(', ')})`);
  }
  const requirementId = opts.as
    ? addRequirement(db, q.goalId, { type: opts.as, description: answer.trim() }).id
    : null;
  db.update(goalQuestions).set({
    answer: answer.trim(), status: 'answered', answeredAt: now(), requirementId,
  }).where(eq(goalQuestions.id, id)).run();
  refreshClarificationStatus(db, q.goalId);
  return getQuestion(db, id);
}

export function dismissQuestion(db: BrainDb, id: number, reason: string): GoalQuestion {
  const q = getQuestion(db, id);
  assertEditable(db, q.goalId);
  if (q.status !== 'pending') throw new Error(`Question #${id} is already ${q.status}.`);
  if (!reason.trim()) throw new Error('Dismissing a question requires a reason.');
  db.update(goalQuestions).set({ status: 'dismissed', statusReason: reason.trim() })
    .where(eq(goalQuestions.id, id)).run();
  refreshClarificationStatus(db, q.goalId);
  return getQuestion(db, id);
}

export function upsertBrainQuestion(
  db: BrainDb, goalId: string, checkKey: string, question: string,
): { question: GoalQuestion; created: boolean } {
  const existing = db.select().from(goalQuestions)
    .where(and(eq(goalQuestions.goalId, goalId), eq(goalQuestions.checkKey, checkKey))).get();
  if (existing) return { question: existing, created: false };
  return { question: addQuestion(db, goalId, { question, source: 'brain', checkKey }), created: true };
}
```

- [ ] **Step 4: Run** `npx vitest run tests/questions.test.ts 2>&1 | tail -8` (6 pass), full suite, tsc.

- [ ] **Step 5: Commit** `src/services/questions.ts tests/questions.test.ts` — message `feat: goal question lifecycle with --as contract lines and clarification tracking`.

---

### Task 4: Intake report

**Files:**
- Create: `src/services/intake.ts`
- Test: `tests/intake.test.ts`

**Interfaces:**
- Consumes: `checkContract`, `getGoal`, `listRequirements`, `ContractGap`, `GoalQuestion`, `Goal` (Task 2); `upsertBrainQuestion`, `answerQuestion`, `listQuestions`, `refreshClarificationStatus` (Task 3); `hybridSearch` (`src/services/hybrid-search.js`), `search` + `SearchResult` + `SearchType` (`src/services/search.js`), `cosine` + `Embedder` (`src/services/embedder.js`), `knowledge` table.
- Produces (from `src/services/intake.js`): `GAP_QUESTIONS: Record<ContractGap['field'], string>`; `interface IntakeReport` (below); `buildIntakeReport(db, embedder, goalId): Promise<IntakeReport>`.

- [ ] **Step 1: Write failing tests** — `tests/intake.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable } from './helpers.js';
import { fakeEmbedder, type Embedder } from '../src/services/embedder.js';
import { reindexEmbeddings } from '../src/services/embedding-store.js';
import { buildIntakeReport } from '../src/services/intake.js';
import { createGoal, addRequirement, lockGoal } from '../src/services/goals.js';
import { listQuestions, answerQuestion, dismissQuestion } from '../src/services/questions.js';
import { addDecision } from '../src/services/decisions.js';

const broken: Embedder = { model: 'broken', async embed() { throw new Error('model unavailable'); } };

describe('intake report', () => {
  it('creates one brain question per gap, idempotently, and names the next action', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Add SSO', objective: 'Users sign in with Microsoft' });
    const r1 = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r1.ready).toBe(false);
    expect(r1.gaps.map(x => x.field).sort()).toEqual(['risk_level', 'scope', 'success_criterion']);
    expect(listQuestions(db, g.id).map(q => q.checkKey).sort())
      .toEqual(['missing:risk_level', 'missing:scope', 'missing:success_criterion']);
    expect(r1.nextAction).toMatch(/answer 3 material question/);
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(listQuestions(db, g.id)).toHaveLength(3);
  });

  it('answered or dismissed gap questions are never recreated (Review Focus 2)', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    const qs = listQuestions(db, g.id);
    answerQuestion(db, qs.find(q => q.checkKey === 'missing:scope')!.id, 'auth service only', { as: 'scope' });
    dismissQuestion(db, qs.find(q => q.checkKey === 'missing:risk_level')!.id, 'will set via goal set');
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(listQuestions(db, g.id)).toHaveLength(3);
  });

  it('auto-answers gap questions once their field is filled; ready → "ready to lock"', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    makeLockable(db, g.id);
    const r = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r.ready).toBe(true);
    expect(r.nextAction).toBe('ready to lock');
    expect(listQuestions(db, g.id).every(q => q.status === 'answered' && q.answer === 'filled via contract')).toBe(true);
  });

  it('finds exact and semantic duplicate requirements', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const a = addRequirement(db, g.id, { type: 'success_criterion', description: 'All suites pass.' });
    const b = addRequirement(db, g.id, { type: 'success_criterion', description: 'all  suites pass' });
    const c = addRequirement(db, g.id, { type: 'success_criterion', description: 'import observations idempotent' });
    const d = addRequirement(db, g.id, { type: 'success_criterion', description: 'observations import idempotent' });
    const r = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r.duplicates).toContainEqual({ a: a.id, b: b.id, reason: 'exact' });
    expect(r.duplicates).toContainEqual({ a: c.id, b: d.id, reason: 'semantic' });
    expect(r.nextAction).toMatch(/answer|fill|duplicate/);
  });

  it('surfaces related context and review items without asking them', async () => {
    const db = createTestDb();
    const e = fakeEmbedder();
    const other = createGoal(db, { title: 'Microsoft sign in', objective: 'users sign in with microsoft accounts' });
    addDecision(db, { decision: 'use microsoft entra for sign in', reason: 'company standard' });
    const g = createGoal(db, { title: 'Microsoft sign in v2', objective: 'users sign in with microsoft' });
    await reindexEmbeddings(db, e);
    const r = await buildIntakeReport(db, e, g.id);
    expect(r.context.goal.some(h => h.id === other.id)).toBe(true);
    expect(r.context.goal.some(h => h.id === g.id)).toBe(false);
    expect(r.reviewItems.some(i => i.kind === 'overlapping_goal' && i.ref === `goal:${other.id}`)).toBe(true);
    expect(r.reviewItems.some(i => i.kind === 'related_decision')).toBe(true);
    expect(listQuestions(db, g.id).every(q => q.source === 'brain')).toBe(true); // review items never auto-asked
    expect(r.semanticUnavailable).toBe(false);
  });

  it('degrades to FTS + exact duplicates when the embedder fails', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Microsoft sign in', objective: 'users sign in' });
    addRequirement(db, g.id, { type: 'scope', description: 'auth only' });
    addRequirement(db, g.id, { type: 'scope', description: 'Auth only.' });
    const r = await buildIntakeReport(db, broken, g.id);
    expect(r.semanticUnavailable).toBe(true);
    expect(r.duplicates).toHaveLength(1);
    expect(r.reviewItems.filter(i => i.kind === 'overlapping_goal')).toHaveLength(0);
  });

  it('is read-only on a locked goal', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    lockGoal(db, g.id, { force: true, reason: 'spike' });
    const r = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r.gaps.length).toBeGreaterThan(0);
    expect(listQuestions(db, g.id)).toHaveLength(0);
  });
});
```

(Note on the semantic duplicate test: with `fakeEmbedder` the two word-permuted descriptions have identical bag-of-words vectors → cosine 1.0 ≥ 0.90, and they differ after normalisation, so the pair is reported as `semantic`, not `exact`.)

- [ ] **Step 2: Run** `npx vitest run tests/intake.test.ts 2>&1 | tail -15` — FAIL (module missing).

- [ ] **Step 3: Implement** `src/services/intake.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { knowledge } from '../db/schema.js';
import { cosine, type Embedder } from './embedder.js';
import {
  checkContract, getGoal, listRequirements, type ContractGap, type Goal, type GoalQuestion,
} from './goals.js';
import { hybridSearch } from './hybrid-search.js';
import { answerQuestion, listQuestions, refreshClarificationStatus, upsertBrainQuestion } from './questions.js';
import { search, type SearchResult, type SearchType } from './search.js';

export const GAP_QUESTIONS: Record<ContractGap['field'], string> = {
  objective: 'What outcome must be true when this goal is done?',
  success_criterion: 'How will we verify the goal is complete (required success criteria)?',
  scope: 'What is in scope, and which systems may change?',
  risk_level: 'What is the risk level (LOW, MEDIUM, HIGH, IRREVERSIBLE)?',
};

const CONTEXT_TYPES = ['decision', 'failure', 'learning', 'knowledge', 'goal', 'observation'] as const;
type ContextType = typeof CONTEXT_TYPES[number];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const DUPLICATE_COSINE = 0.9;
const PER_TYPE = 5;

export interface IntakeReport {
  goal: Goal;
  ready: boolean;
  gaps: ContractGap[];
  openQuestions: GoalQuestion[];
  context: Record<ContextType, SearchResult[]>;
  reviewItems: { kind: 'overlapping_goal' | 'related_decision' | 'user_preference'; ref: string; text: string; score: number }[];
  duplicates: { a: number; b: number; reason: 'exact' | 'semantic' }[];
  semanticUnavailable: boolean;
  nextAction: string;
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?;:,]+$/, '');

export async function buildIntakeReport(db: BrainDb, embedder: Embedder, goalId: string): Promise<IntakeReport> {
  const goal = getGoal(db, goalId);
  const editable = !goal.lockedAt && !TERMINAL.includes(goal.status);

  // 1. deterministic gap questions (never on locked/terminal goals)
  if (editable) {
    const gapKeys = new Set(checkContract(db, goalId).gaps.map(g => `missing:${g.field}`));
    for (const field of Object.keys(GAP_QUESTIONS) as ContractGap['field'][]) {
      if (gapKeys.has(`missing:${field}`)) upsertBrainQuestion(db, goalId, `missing:${field}`, GAP_QUESTIONS[field]);
    }
    for (const q of listQuestions(db, goalId, { open: true })) {
      if (q.source === 'brain' && q.checkKey?.startsWith('missing:') && !gapKeys.has(q.checkKey)) {
        answerQuestion(db, q.id, 'filled via contract');
      }
    }
    refreshClarificationStatus(db, goalId);
  }
  const check = checkContract(db, goalId);

  // 2. related context (hybrid; FTS-only if the embedder fails)
  const query = `${goal.title}: ${goal.objective}`;
  let semanticUnavailable = false;
  const context = {} as Record<ContextType, SearchResult[]>;
  for (const t of CONTEXT_TYPES) {
    let hits: SearchResult[];
    if (!semanticUnavailable) {
      try {
        hits = await hybridSearch(db, embedder, query, { types: [t as SearchType], limit: PER_TYPE + 1 });
      } catch {
        semanticUnavailable = true;
        hits = search(db, query, { types: [t as SearchType], limit: PER_TYPE + 1 });
      }
    } else {
      hits = search(db, query, { types: [t as SearchType], limit: PER_TYPE + 1 });
    }
    context[t] = hits.filter(h => !(h.type === 'goal' && h.id === goalId)).slice(0, PER_TYPE);
  }

  // 3. review items — surfaced for the session to judge, never auto-asked
  const reviewItems: IntakeReport['reviewItems'] = [];
  if (!semanticUnavailable) {
    for (const h of context.goal) {
      const other = getGoal(db, h.id);
      if (!TERMINAL.includes(other.status)) {
        reviewItems.push({ kind: 'overlapping_goal', ref: `goal:${h.id}`, text: h.text, score: -h.score });
      }
    }
  }
  for (const h of context.decision) {
    reviewItems.push({ kind: 'related_decision', ref: `decision:${h.id}`, text: h.text, score: -h.score });
  }
  for (const h of context.knowledge) {
    const k = db.select().from(knowledge).where(eq(knowledge.id, Number(h.id))).get();
    if (k && (k.category === 'preference' || k.statement.startsWith('User preference'))) {
      reviewItems.push({ kind: 'user_preference', ref: `knowledge:${h.id}`, text: h.text, score: -h.score });
    }
  }

  // 4. duplicate requirements
  const reqs = listRequirements(db, goalId);
  const duplicates: IntakeReport['duplicates'] = [];
  let vectors: Float32Array[] | null = null;
  if (!semanticUnavailable && reqs.length > 1) {
    try { vectors = await embedder.embed(reqs.map(r => r.description)); } catch { semanticUnavailable = true; }
  }
  for (let i = 0; i < reqs.length; i++) {
    for (let j = i + 1; j < reqs.length; j++) {
      if (normalise(reqs[i]!.description) === normalise(reqs[j]!.description)) {
        duplicates.push({ a: reqs[i]!.id, b: reqs[j]!.id, reason: 'exact' });
      } else if (vectors && cosine(vectors[i]!, vectors[j]!) >= DUPLICATE_COSINE) {
        duplicates.push({ a: reqs[i]!.id, b: reqs[j]!.id, reason: 'semantic' });
      }
    }
  }

  // 5. next action — first applicable
  let nextAction = 'ready to lock';
  if (check.openQuestions.length > 0) {
    nextAction = `answer ${check.openQuestions.length} material question(s) — ask them in one batch`;
  } else if (check.gaps.length > 0) {
    nextAction = `fill: ${check.gaps.map(g => g.field).join(', ')}`;
  } else if (duplicates.length > 0) {
    nextAction = `resolve ${duplicates.length} duplicate requirement pair(s)`;
  }

  return {
    goal: getGoal(db, goalId), ready: check.ready,
    gaps: check.gaps, openQuestions: check.openQuestions, context, reviewItems, duplicates,
    semanticUnavailable, nextAction,
  };
}
```

(`ready` mirrors `checkContract`: duplicates are advisory and do not block lock, per spec §3's lock-required list; `nextAction` still asks to resolve them.)

- [ ] **Step 4: Run** `npx vitest run tests/intake.test.ts 2>&1 | tail -10` (7 pass), full suite, tsc.

- [ ] **Step 5: Commit** `src/services/intake.ts tests/intake.test.ts` — message `feat: goal intake report — gap questions, related context, review items, duplicates`.

---

### Task 5: Resume/context integration and migration guard

**Files:**
- Modify: `src/services/resume.ts`, `src/services/context.ts`, `src/cli/index.ts` (db opener, `context get`, new `migrate`), `src/mcp/server.ts` (startup, tool error notice)
- Modify tests: `tests/resume.test.ts`
- Test: `tests/guard.test.ts` (new)

**Interfaces:**
- Consumes: `checkContract` (Task 2), `appliedMigrations`, `pendingMigrations` (Task 1).
- Produces: `BrainContext.openMaterialQuestions: number`; resume recommendations (exact strings below); CLI `db({ migrate?: boolean })`; CLI `migrate` → `{ applied: number, pending: number }`; `context get` output adds `schemaPending: boolean` and, when pending, `notice: 'Brain schema update pending — run \`brain migrate\`'`; exported `SCHEMA_NOTICE` from `src/db/connection.js`.

- [ ] **Step 1: Write failing tests.** Replace the `'gives lifecycle-appropriate recommendations'` test in `tests/resume.test.ts` with (import `makeLockable` from `./helpers.js`, `addQuestion` from `../src/services/questions.js`):

```ts
  it('gives lifecycle-appropriate recommendations', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Draft goal', objective: 'o' });
    expect(resumeGoal(db, g.id).nextRecommendedAction).toMatch(/goal intake/i);
    const q = addQuestion(db, g.id, { question: 'Keep passwords?' });
    expect(resumeGoal(db, g.id).nextRecommendedAction).toMatch(/answer 1 open material question/i);
    makeLockable(db, g.id);
    db.$client.prepare("UPDATE goal_questions SET status = 'dismissed' WHERE id = ?").run(q.id);
    expect(resumeGoal(db, g.id).nextRecommendedAction).toMatch(/lock the goal contract/i);
    lockGoal(db, g.id);
    expect(resumeGoal(db, g.id).nextRecommendedAction).toMatch(/start goal/i);
    expect(resumeGoal(db, g.id).contract).not.toBeNull();
  });
```

Create `tests/guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrateDb, pendingMigrations } from '../src/db/connection.js';
import { createTestDb } from './helpers.js';
import { createGoal } from '../src/services/goals.js';
import { addQuestion } from '../src/services/questions.js';
import { getContext } from '../src/services/context.js';

function cli(dbPath: string, ...args: string[]): any {
  const out = execFileSync('npx', ['tsx', 'src/cli/index.ts', ...args],
    { env: { ...process.env, BRAIN_DB: dbPath }, encoding: 'utf8' });
  return JSON.parse(out);
}

describe('migration guard', () => {
  it('passive context get does not migrate an existing DB with pending migrations', { timeout: 60000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-guard-'));
    const dbPath = path.join(dir, 'brain.db');
    const db = openDb(dbPath);
    migrateDb(db);
    db.$client.prepare('DELETE FROM __drizzle_migrations WHERE id = (SELECT max(id) FROM __drizzle_migrations)').run();
    db.$client.close();
    const ctx = cli(dbPath, 'context', 'get');
    expect(ctx.schemaPending).toBe(true);
    expect(ctx.notice).toMatch(/brain migrate/);
    expect(pendingMigrations(openDb(dbPath))).toBe(1); // still unmigrated
  });

  it('passive context get initialises a brand-new DB (Review Focus 4)', { timeout: 60000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-guard-'));
    const ctx = cli(path.join(dir, 'brain.db'), 'context', 'get');
    expect(ctx.schemaPending).toBe(false);
    expect(ctx.goal).toBeNull();
  });

  it('brain migrate applies pending migrations on a fresh DB', { timeout: 60000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-guard-'));
    const res = cli(path.join(dir, 'brain.db'), 'migrate');
    expect(res.pending).toBe(0);
    expect(res.applied).toBeGreaterThan(0);
  });

  it('context reports open material questions for the goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addQuestion(db, g.id, { question: 'Q?' });
    addQuestion(db, g.id, { question: 'detail?', materiality: 'detail' });
    expect(getContext(db, { goalId: g.id }).openMaterialQuestions).toBe(1);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/resume.test.ts tests/guard.test.ts 2>&1 | tail -15` — FAIL.

- [ ] **Step 3: Resume recommendations.** In `src/services/resume.ts` import `checkContract` from `./goals.js`; change `recommend` to take an intake summary and replace its DRAFT case:

```ts
function recommend(
  goal: Goal, ready: WorkUnit[], pending: WorkUnit[], allPassed: boolean,
  intake: { openMaterial: number; ready: boolean },
): string {
  switch (goal.status) {
    case 'DRAFT':
      if (intake.openMaterial > 0) {
        return `Answer ${intake.openMaterial} open material question(s) in one batch (brain goal question list ${goal.id} --open)`;
      }
      if (intake.ready) return `Contract ready — lock the goal contract (brain goal lock ${goal.id})`;
      return `Run goal intake to find contract gaps (brain goal intake ${goal.id})`;
```

(keep the other cases unchanged) and in `resumeGoal` compute before the return:

```ts
  const contractCheck = checkContract(db, id);
  const intake = { openMaterial: contractCheck.openQuestions.length, ready: contractCheck.ready };
```

passing `intake` as the new last argument of `recommend(...)`.

- [ ] **Step 4: Context count.** In `src/services/context.ts`: add `openMaterialQuestions: number` to `BrainContext`; import `and, eq` from `drizzle-orm` and `goalQuestions` from `../db/schema.js`; in `getContext` compute

```ts
  let openMaterialQuestions = 0;
  if (goal) {
    try {
      openMaterialQuestions = db.select().from(goalQuestions).where(and(
        eq(goalQuestions.goalId, goal.id), eq(goalQuestions.status, 'pending'), eq(goalQuestions.materiality, 'material'),
      )).all().length;
    } catch {
      openMaterialQuestions = 0; // schema pending (passive path) — columns may not exist yet
    }
  }
```

and include it in the returned object.

- [ ] **Step 5: Guard.** In `src/db/connection.ts` add `export const SCHEMA_NOTICE = 'Brain schema update pending — run `brain migrate`';` (use a normal string with the backticks inside).
In `src/cli/index.ts` replace the `db()` helper:

```ts
function db(opts: { migrate?: boolean } = {}): BrainDb {
  const handle = openDb();
  // Explicit commands auto-migrate (with snapshot). Passive callers only initialise a brand-new DB.
  if (opts.migrate !== false || appliedMigrations(handle) === 0) migrateDb(handle);
  return handle;
}
```

(import `appliedMigrations`, `pendingMigrations`, `SCHEMA_NOTICE` from `../db/connection.js`). Replace the `ctx.command('get')` action with:

```ts
  .action((o) => run(() => {
    const d = db({ migrate: false });
    const pending = pendingMigrations(d) > 0;
    out({
      ...context.getContext(d, { goalId: o.goal, budget: Number(o.budget) }),
      schemaPending: pending, ...(pending ? { notice: SCHEMA_NOTICE } : {}),
    });
  }));
```

Add after the `backup` command:

```ts
program.command('migrate').description('Snapshot, then apply pending schema migrations')
  .action(() => run(() => {
    const d = openDb();
    const before = pendingMigrations(d);
    migrateDb(d);
    out({ applied: before - pendingMigrations(d), pending: pendingMigrations(d) });
  }));
```

In `src/mcp/server.ts`: import `appliedMigrations`, `pendingMigrations`, `SCHEMA_NOTICE`; in `main()` replace `migrateDb(db);` with `if (appliedMigrations(db) === 0) migrateDb(db); else if (pendingMigrations(db) > 0) console.error(SCHEMA_NOTICE);`; in the `tool()` helper's `catch`, build the message as `const msg = (e as Error).message; const text = pendingMigrations(db) > 0 ? \`${msg}\n${SCHEMA_NOTICE}\` : msg;` and return `text`.

- [ ] **Step 6: Run** `npx vitest run tests/resume.test.ts tests/guard.test.ts 2>&1 | tail -10`, full suite, tsc.

- [ ] **Step 7: Commit** `src/services/resume.ts src/services/context.ts src/db/connection.ts src/cli/index.ts src/mcp/server.ts tests/resume.test.ts tests/guard.test.ts` — message `feat: intake-aware resume, open-question count in context, passive paths stop auto-migrating`.

---

### Task 6: Intake and question surfaces (CLI + MCP)

**Files:**
- Modify: `src/cli/index.ts`, `src/mcp/server.ts`
- Test: `tests/cli.test.ts`, `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `buildIntakeReport` (Task 4); `addQuestion`, `answerQuestion`, `dismissQuestion`, `listQuestions`, `ANSWER_AS_TYPES` (Task 3); the lazy `embedder()` singleton and `runAsync` already in `src/cli/index.ts`, and the per-server lazy `embedder()` in `src/mcp/server.ts`.
- Produces: CLI `goal intake <id>`, `goal question add <goalId> <text> [--detail]`, `goal question answer <qid> <answer> [--as <type>]`, `goal question dismiss <qid> <reason>`, `goal question list <goalId> [--open]`; MCP `brain_goal_intake {id}`, `brain_question_add {goalId, question, detail?}`, `brain_question_answer {id, answer, as?}`, `brain_question_dismiss {id, reason}`, `brain_question_list {goalId, open?}` → 48 tools.

- [ ] **Step 1: Write failing tests.** In `tests/mcp.test.ts` add `'brain_goal_intake', 'brain_goal_set', 'brain_question_add', 'brain_question_answer', 'brain_question_dismiss', 'brain_question_list'` to the tool-surface array, and add:

```ts
  it('registers 48 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(48);
  });
```

(use the same client setup the file's other tests use). Append to `tests/cli.test.ts` (the `brain()` helper throws on a non-zero exit, so a refused lock is asserted with `toThrow`):

```ts
  it('phase 4: intake → answer batch → lock e2e', { timeout: 300000 }, () => {
    const g = brain('goal', 'create', 'Add SSO', '-o', 'Users sign in with Microsoft');
    const r1 = brain('goal', 'intake', g.id);
    expect(r1.ready).toBe(false);
    expect(r1.openQuestions).toHaveLength(3);
    expect(() => brain('goal', 'lock', g.id)).toThrow();
    const qs = brain('goal', 'question', 'list', g.id, '--open');
    const byKey = (k: string) => qs.find((q: any) => q.checkKey === k).id;
    brain('goal', 'question', 'answer', String(byKey('missing:scope')), 'auth service and login UI', '--as', 'scope');
    brain('goal', 'question', 'answer', String(byKey('missing:success_criterion')), 'Microsoft login works end to end', '--as', 'success_criterion');
    brain('goal', 'question', 'answer', String(byKey('missing:risk_level')), 'HIGH');
    brain('goal', 'set', g.id, '--risk', 'HIGH');
    const extra = brain('goal', 'question', 'add', g.id, 'Keep password login?');
    brain('goal', 'question', 'dismiss', String(extra.id), 'covered by existing policy');
    const r2 = brain('goal', 'intake', g.id);
    expect(r2.ready).toBe(true);
    expect(r2.nextAction).toBe('ready to lock');
    const locked = brain('goal', 'lock', g.id);
    expect(locked.status).toBe('LOCKED');
    expect(JSON.parse(locked.contractSnapshot).answeredQuestions.length).toBeGreaterThanOrEqual(3);
  });
```

- [ ] **Step 2: Run** `npx vitest run tests/mcp.test.ts 2>&1 | tail -10` — FAIL (tools missing).

- [ ] **Step 3: CLI.** In `src/cli/index.ts` import `buildIntakeReport` from `../services/intake.js` and `* as questions` from `../services/questions.js`, then add after the `goal set` command:

```ts
goal.command('intake <id>').description('Intake report: context, gaps, review items, duplicates (§8)')
  .action((id) => runAsync(async () => out(await buildIntakeReport(db(), embedder(), id))));

const question = goal.command('question');
question.command('add <goalId> <text>').option('--detail', 'record only; never blocks lock')
  .action((goalId, text, o) => run(() => out(questions.addQuestion(db(), goalId, {
    question: text, materiality: o.detail ? 'detail' : 'material',
  }))));
question.command('answer <id> <answer>')
  .option('--as <type>', 'constraint|exclusion|assumption|scope|permission|success_criterion')
  .action((id, answer, o) => run(() => out(questions.answerQuestion(db(), Number(id), answer, { as: o.as }))));
question.command('dismiss <id> <reason>')
  .action((id, reason) => run(() => out(questions.dismissQuestion(db(), Number(id), reason))));
question.command('list <goalId>').option('--open', 'pending only')
  .action((goalId, o) => run(() => out(questions.listQuestions(db(), goalId, { open: o.open }))));
```

- [ ] **Step 4: MCP.** In `src/mcp/server.ts` import `buildIntakeReport` and `* as questions`, and add before `return server;`:

```ts
  tool('brain_goal_intake', 'Intake report: related context, §9 gaps (auto-questions), review items, duplicate requirements', {
    id: z.string(),
  }, (a) => buildIntakeReport(db, embedder(), a.id));
  tool('brain_question_add', 'Add a clarification question to an unlocked goal (material unless detail)', {
    goalId: z.string(), question: z.string(), detail: z.boolean().optional(),
  }, (a) => questions.addQuestion(db, a.goalId, { question: a.question, materiality: a.detail ? 'detail' : 'material' }));
  tool('brain_question_answer', 'Answer a question; `as` also adds it as a contract line', {
    id: z.number(), answer: z.string(),
    as: z.enum(['constraint', 'exclusion', 'assumption', 'scope', 'permission', 'success_criterion']).optional(),
  }, (a) => questions.answerQuestion(db, a.id, a.answer, { as: a.as }));
  tool('brain_question_dismiss', 'Dismiss a question as not material (reason required)', {
    id: z.number(), reason: z.string(),
  }, (a) => questions.dismissQuestion(db, a.id, a.reason));
  tool('brain_question_list', 'List a goal\'s questions (open = pending only)', {
    goalId: z.string(), open: z.boolean().optional(),
  }, (a) => questions.listQuestions(db, a.goalId, { open: a.open }));
```

Verify `grep -c "tool('brain_" src/mcp/server.ts` → 48.

- [ ] **Step 5: Run** `npx vitest run tests/mcp.test.ts tests/cli.test.ts 2>&1 | tail -10`, full suite, tsc, `npm run build 2>&1 | tail -3`.

- [ ] **Step 6: Commit** `src/cli/index.ts src/mcp/server.ts tests/cli.test.ts tests/mcp.test.ts` — message `feat: goal intake and question commands on CLI and MCP (48 tools)`.

---

### Task 7: Live run — migrate, dogfood intake on GOAL-2026-0004, lock, verify, document

**Files:**
- Modify: `README.md`
- No src changes.

- [ ] **Step 1: Explicit live migration.**

```bash
node dist/cli/index.js context get --current --budget 5 | jq '{schemaPending, notice}'   # expect schemaPending true (guard held)
node dist/cli/index.js migrate                    # expect {applied: 1, pending: 0}
ls ~/.central-brain/backups | tail -1             # pre-migration snapshot present
```

- [ ] **Step 2: Dogfood intake on GOAL-2026-0004.** Run `node dist/cli/index.js goal intake GOAL-2026-0004`; record gaps, open questions, review items (expect the Phase 3 goal as related context), duplicates. Fill the contract through the new commands only: answer the gap questions with `--as scope` / `--as success_criterion` using the spec's §1 success statements (one criterion per statement), `goal set GOAL-2026-0004 --risk MEDIUM`, resolve any duplicates the report names. Re-run intake until `ready: true`. Then `goal lock GOAL-2026-0004` (no `--force`) and `goal start GOAL-2026-0004`.

- [ ] **Step 3: Verify each success criterion** via `node dist/cli/index.js verify add -g GOAL-2026-0004 -r <id> --passed --type live …` with honest actuals: suite/tsc/build; intake report evidence; question lifecycle evidence from the dogfood run; the refused-then-accepted lock; guard evidence from Step 1; MCP tool count 48. Then `verify goal GOAL-2026-0004` → all required passed → `goal complete GOAL-2026-0004` → `backup`.

- [ ] **Step 4: README + learning + commit.** Append to the README command list:

```markdown
- Intake: `brain goal intake GOAL-…` (context, §9 gaps → questions, review items, duplicates); `brain goal question add|answer [--as type]|dismiss|list`; `brain goal set --risk`; `brain goal lock` refuses incomplete contracts (`--force --reason` records a decision)
- Schema: sessions never auto-migrate the live DB; run `brain migrate` after pulling schema changes
```

```bash
node dist/cli/index.js learning add "Start every new goal with brain goal intake; answer its material questions in one batch before locking" -s GLOBAL
git commit -m "docs: phase 4 command surface" -m "Goal: GOAL-2026-0004" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- README.md
```

---

## Verification (whole-phase)

- Full suite green, tsc clean, build clean; MCP tool count 48.
- Live DB unchanged by session starts until `brain migrate` (Step 1 evidence), snapshot present.
- GOAL-2026-0004 itself went intake → answered questions → gated lock without `--force` → COMPLETED through `verify`.

## Out of scope

- LLM calls from Brain; automatic contradiction judgment.
- Parsing free-text requests into goals; Phase 5 work-unit planning.
- Re-gating already locked or completed goals.

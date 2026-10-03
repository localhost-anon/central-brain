# Brain Lifecycle Gaps (spec-kit mirror) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brain enforces in code the following, with goals locked before the upgrade grandfathered:
- atomic, verify-method-tagged success criteria
- typed evidence and a converge gate on completion
- a criterion-coverage gate on start
- per-project principles acknowledged at lock
- capped coverage-taxonomy intake
- stale-goal hygiene
- reproduction-backed failure resolution

**Architecture:**
- One pure module, `src/services/contract-rules.ts`, defines every rule as a function over plain rows that returns `Finding[]`.
- `src/services/converge.ts` loads rows straight from schema tables, without importing other services, so there are no import cycles. It runs the rules and is called by `goals.ts` gates, `resume.ts` and the CLI/MCP.
- `src/services/activity.ts` holds `touchGoal` and staleness, and imports only schema.
- One additive drizzle migration.

**Tech Stack:** TypeScript (strict, ESM), drizzle-orm + better-sqlite3, vitest, commander (CLI), @modelcontextprotocol/sdk + zod (MCP).

**Spec:** `docs/superpowers/specs/2026-10-03-brain-spec-kit-gaps-design.md` (Brain goal GOAL-2026-0031)

## Global Constraints

- Goals locked before the upgrade keep today's rules: `rules_version = 0` (column default). `lockGoal` sets 1.
- Every `--force` requires a non-empty reason, recorded as a `MEDIUM` decision. Forced completion sets `completion_mode = 'forced'`.
- Failure resolution rule applies to all failures, with no grandfathering.
- `BRAIN_STALE_DAYS` default `7`.
- Max **5** material **session** questions per goal. Brain questions (`missing:*`, `review:*`) don't count.
- Verify methods: `test`, `command`, `api`, `inspection`, `manual`.
- Verdicts: `verified`, `partial`, `failed`.
- Coverage categories: `behaviour`, `data`, `failure_modes`, `edge_cases`, `non_functional`, `integration`, `completion`.
- No LLM calls inside Brain; all rules are deterministic.
- The migration is additive only (ADD COLUMN / CREATE TABLE). Never run `brain migrate` against `~/.central-brain/brain.db` during implementation; that is the user's step.
- Every commit message ends with `Goal: GOAL-2026-0031` and the `Co-Authored-By` trailer.
- Work happens in a git worktree on branch `brain-spec-kit-gaps`.

## Review Focus

1. **Legacy callers on v1 goals.** `brain_verification_record {passed:true}` with no `actualResult` on a v1 goal is rejected with a message naming the missing field, not a generic error. Test in Task 7.
2. **Reruns.** `goal_intake` run twice doesn't duplicate `review:coverage`, and stays idempotent after the coverage answer. Test in Task 5.
3. **Ordinary prose isn't flagged as non-atomic.** A criterion with "e.g. 1.5s" or a version like "v2.1" passes. Test in Task 2.
4. **Stale goals stay reachable.** `goal_current` skips them, but `goal_get`/`goal_resume` by id still work, and resume un-stales. Test in Task 3.
5. **v0 goals are not gated by v1 rules.** A grandfathered EXECUTING goal (like GOAL-2026-0028) can still record `passed:true` without a verdict and complete under the old rule. Test in Task 7.

---

### Task 0: Worktree

- [ ] **Step 1:** Use superpowers:using-git-worktrees to create a worktree on new branch `brain-spec-kit-gaps` from `main`. Run `npm install` there, then `npm test`. Expected: all green (the baseline).

---

### Task 1: Schema and migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0005_*.sql` (generated), `drizzle/meta/0005_snapshot.json`, `drizzle/meta/_journal.json` (generated)
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces:
  - drizzle tables `goalProjects`, `workUnitRequirements`, `goalPrincipleAcks`
  - new columns `goals.rulesVersion`, `goals.completionMode`, `goals.convergeSnapshot`
  - `goalRequirements.verifyMethod`, `goalRequirements.coverage`
  - `goalQuestions.recommended`
  - `verificationRuns.verdict`
  - `failures.resolutionNote`
  - `failureSolutions.verdict`, `failureSolutions.reproduction`

- [ ] **Step 1: Write the failing test** (append to `tests/db.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';

describe('lifecycle-gaps migration', () => {
  it('adds columns and tables', () => {
    const db = createTestDb();
    const cols = (t: string) => (db.$client.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
    expect(cols('goals')).toEqual(expect.arrayContaining(['rules_version', 'completion_mode', 'converge_snapshot']));
    expect(cols('goal_requirements')).toEqual(expect.arrayContaining(['verify_method', 'coverage']));
    expect(cols('goal_questions')).toContain('recommended');
    expect(cols('verification_runs')).toContain('verdict');
    expect(cols('failures')).toContain('resolution_note');
    expect(cols('failure_solutions')).toEqual(expect.arrayContaining(['verdict', 'reproduction']));
    expect(cols('goal_projects')).toEqual(['goal_id', 'project_id']);
    expect(cols('work_unit_requirements')).toEqual(['work_unit_id', 'requirement_id']);
    expect(cols('goal_principle_acks')).toEqual(['goal_id', 'knowledge_id', 'mode', 'note', 'decision_id', 'created_at']);
  });

  it('existing goals default to rules_version 0', () => {
    const db = createTestDb();
    db.$client.prepare(`INSERT INTO goals (id, title, objective, created_at, updated_at) VALUES ('GOAL-X','t','o','2026-01-01','2026-01-01')`).run();
    expect((db.$client.prepare(`SELECT rules_version FROM goals WHERE id='GOAL-X'`).get() as { rules_version: number }).rules_version).toBe(0);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/db.test.ts`. Expected: FAIL (`rules_version` missing).

- [ ] **Step 3: Edit `src/db/schema.ts`**
  - In `goals`, after `completedAt`:
    ```ts
      rulesVersion: integer('rules_version').notNull().default(0),
      completionMode: text('completion_mode'),
      convergeSnapshot: text('converge_snapshot'),
    ```
  - In `goalRequirements`, after `statusReason`:
    ```ts
      verifyMethod: text('verify_method'),
      coverage: text('coverage'),
    ```
  - In `goalQuestions`, after `statusReason`: `recommended: text('recommended'),`
  - In `verificationRuns`, after `passed`: `verdict: text('verdict'),`
  - In `failures`, after `resolvedAt`: `resolutionNote: text('resolution_note'),`
  - In `failureSolutions`, after `successful`:
    ```ts
      verdict: text('verdict'),
      reproduction: text('reproduction'),
    ```
  - Append the new tables:
    ```ts
    export const goalProjects = sqliteTable('goal_projects', {
      goalId: text('goal_id').notNull().references(() => goals.id),
      projectId: text('project_id').notNull().references(() => projects.id),
    }, (t) => [primaryKey({ columns: [t.goalId, t.projectId] })]);

    export const workUnitRequirements = sqliteTable('work_unit_requirements', {
      workUnitId: text('work_unit_id').notNull().references(() => workUnits.id),
      requirementId: integer('requirement_id').notNull().references(() => goalRequirements.id),
    }, (t) => [primaryKey({ columns: [t.workUnitId, t.requirementId] })]);

    export const goalPrincipleAcks = sqliteTable('goal_principle_acks', {
      goalId: text('goal_id').notNull().references(() => goals.id),
      knowledgeId: integer('knowledge_id').notNull().references(() => knowledge.id),
      mode: text('mode').notNull(),
      note: text('note').notNull(),
      decisionId: integer('decision_id'),
      createdAt: text('created_at').notNull(),
    }, (t) => [primaryKey({ columns: [t.goalId, t.knowledgeId] })]);
    ```

- [ ] **Step 4:** Run `npm run db:generate`. Open the generated `drizzle/0005_*.sql` and confirm it contains only `ALTER TABLE … ADD` and `CREATE TABLE` statements (no DROP, no table rebuild). If drizzle-kit emits a `__new_` table rebuild for any table, stop and hand-write the ALTERs instead, keeping the generated journal and snapshot.

- [ ] **Step 5:** Run `npx vitest run tests/db.test.ts`, then `npm test`. Expected: PASS, and the whole suite stays green.

- [ ] **Step 6: Commit**
```bash
git add src/db/schema.ts drizzle tests/db.test.ts
git commit -m "feat: schema for rules versions, verdicts, coverage, principles, work trace

Goal: GOAL-2026-0031

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure rules module

**Files:**
- Create: `src/services/contract-rules.ts`
- Test: `tests/contract-rules.test.ts`

**Interfaces:**
- Produces (all exported from `src/services/contract-rules.ts`):
  - `type Severity = 'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'`
  - `interface Finding { id: string; severity: Severity; kind: string; ref: string; message: string }`
  - `VERIFY_METHODS`, `VERDICTS`, `COVERAGE_CATEGORIES` (readonly tuples), `MAX_SESSION_QUESTIONS = 5`
  - `isAtomic(text: string): boolean`
  - `lockFindings(reqs: ReqRow[]): Finding[]`: non-atomic or missing verify_method on required criteria
  - `uncoveredCategories(reqs: ReqRow[]): string[]`
  - `principleFindings(principles: { id: number; statement: string }[], acks: { knowledgeId: number; mode: string }[], phase: 'lock'|'converge'): Finding[]`
  - `coverageFindings(reqs: ReqRow[], units: UnitRow[], links: { workUnitId: string; requirementId: number }[]): Finding[]`
  - `evidenceFindings(reqs: ReqRow[], runs: RunRow[], units: UnitRow[], openFailures: { id: number; errorMessage: string | null }[]): Finding[]`
  - `sortFindings(f: Finding[]): Finding[]`
  - `isConverged(f: Finding[]): boolean`
  - row types `ReqRow = { id: number; requirementType: string; description: string; priority: string; status: string; verifyMethod: string | null; coverage: string | null }`, `UnitRow = { id: string; title: string; status: string; completedAt: string | null }`, `RunRow = { id: number; requirementId: number | null; verdict: string | null; createdAt: string }`

- [ ] **Step 1: Write the failing tests** (`tests/contract-rules.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import {
  isAtomic, lockFindings, uncoveredCategories, principleFindings, coverageFindings,
  evidenceFindings, sortFindings, isConverged, type ReqRow, type UnitRow, type RunRow,
} from '../src/services/contract-rules.js';

const req = (o: Partial<ReqRow> & { id: number }): ReqRow => ({
  requirementType: 'success_criterion', description: 'x works', priority: 'required',
  status: 'PENDING', verifyMethod: 'test', coverage: null, ...o,
});
const unit = (o: Partial<UnitRow> & { id: string }): UnitRow => ({ title: 'u', status: 'COMPLETED', completedAt: '2026-10-01T00:00:00Z', ...o });
const run = (o: Partial<RunRow> & { id: number }): RunRow => ({ requirementId: 1, verdict: 'verified', createdAt: '2026-10-02T00:00:00Z', ...o });

describe('isAtomic', () => {
  it.each([
    '(1) .env holds creds. (2) User logs in. (3) Data test passes',
    '1. lock refuses blobs 2. complete refuses gaps',
    'a) foo b) bar',
    'login works; logout works; refresh works',
    'Checks:\n- login\n- logout',
  ])('rejects blob: %s', (t) => expect(isAtomic(t)).toBe(false));
  it.each([
    'goal_lock refuses a blob criterion, proven by a passing integration test.',
    'Page loads in under 1.5s on v2.1 of the API (e.g. /health).',
    'User logs in to Dhan via OpenAlgo; auth table shows broker dhan',
  ])('accepts: %s', (t) => expect(isAtomic(t)).toBe(true));
});

describe('lockFindings', () => {
  it('flags non-atomic and missing verify method on required criteria only', () => {
    const f = lockFindings([
      req({ id: 1, description: '(1) a (2) b' }),
      req({ id: 2, verifyMethod: null }),
      req({ id: 3, priority: 'optional', verifyMethod: null }),
      req({ id: 4, requirementType: 'scope', description: '(1) a (2) b', verifyMethod: null }),
    ]);
    expect(f.map(x => x.id).sort()).toEqual(['no_verify_method:req:2', 'non_atomic:req:1']);
    expect(f.every(x => x.severity === 'CRITICAL')).toBe(true);
  });
});

describe('uncoveredCategories', () => {
  it('lists categories with no tagged requirement', () => {
    expect(uncoveredCategories([req({ id: 1, coverage: 'data' }), req({ id: 2, coverage: 'edge_cases' })]))
      .toEqual(['behaviour', 'failure_modes', 'non_functional', 'integration', 'completion']);
  });
});

describe('principleFindings', () => {
  const p = [{ id: 7, statement: 'Sandbox first' }, { id: 8, statement: 'No secrets in DB' }];
  it('lock: unacknowledged principles are CRITICAL', () => {
    const f = principleFindings(p, [{ knowledgeId: 7, mode: 'honoured' }], 'lock');
    expect(f).toEqual([expect.objectContaining({ id: 'unacknowledged_principle:knowledge:8', severity: 'CRITICAL' })]);
  });
  it('converge: exceptions are LOW', () => {
    const f = principleFindings(p, [{ knowledgeId: 7, mode: 'exception' }, { knowledgeId: 8, mode: 'honoured' }], 'converge');
    expect(f).toEqual([expect.objectContaining({ id: 'principle_exception:knowledge:7', severity: 'LOW' })]);
  });
});

describe('coverageFindings', () => {
  it('uncovered required criterion CRITICAL, unlinked unit MEDIUM', () => {
    const f = coverageFindings([req({ id: 1 }), req({ id: 2 }), req({ id: 3, priority: 'optional' })],
      [unit({ id: 'WU-1' }), unit({ id: 'WU-2' })], [{ workUnitId: 'WU-1', requirementId: 1 }]);
    expect(f.map(x => `${x.id}/${x.severity}`).sort()).toEqual(['uncovered:req:2/CRITICAL', 'unrequested:wu:WU-2/MEDIUM']);
  });
});

describe('evidenceFindings', () => {
  it('missing, contradicts, partial, stale, unfinished, open failure, optional, review', () => {
    const reqs = [
      req({ id: 1 }), req({ id: 2 }), req({ id: 3 }), req({ id: 4 }), req({ id: 5 }),
      req({ id: 6, priority: 'optional' }),
      req({ id: 7, requirementType: 'constraint', description: 'no downtime', verifyMethod: null }),
      req({ id: 8, status: 'NOT_APPLICABLE' }),
    ];
    const runs = [
      run({ id: 1, requirementId: 2, verdict: 'failed' }),
      run({ id: 2, requirementId: 3, verdict: 'partial' }),
      run({ id: 3, requirementId: 4, verdict: 'verified', createdAt: '2026-09-01T00:00:00Z' }),
      run({ id: 4, requirementId: 5, verdict: 'verified' }),
      run({ id: 5, requirementId: 5, verdict: null }), // legacy row ignored
    ];
    const units = [unit({ id: 'WU-1', completedAt: '2026-10-01T00:00:00Z' }), unit({ id: 'WU-2', status: 'RUNNING', completedAt: null })];
    const f = evidenceFindings(reqs, runs, units, [{ id: 9, errorMessage: 'boom' }]);
    expect(f.map(x => `${x.id}/${x.severity}`).sort()).toEqual([
      'contradicts:req:2/CRITICAL', 'missing:req:1/CRITICAL', 'missing_optional:req:6/MEDIUM',
      'open_failure:failure:9/CRITICAL', 'partial:req:3/HIGH', 'review:req:7/LOW',
      'stale_evidence:req:4/HIGH', 'unfinished_work:wu:WU-2/HIGH',
    ]);
  });
  it('uses the latest verdict run', () => {
    const f = evidenceFindings([req({ id: 1 })],
      [run({ id: 1, verdict: 'failed', createdAt: '2026-10-01T00:00:00Z' }), run({ id: 2, verdict: 'verified', createdAt: '2026-10-02T00:00:00Z' })], [], []);
    expect(f).toEqual([]);
  });
});

describe('sortFindings / isConverged', () => {
  it('orders by severity then id; converged ignores MEDIUM/LOW', () => {
    const f = [
      { id: 'b', severity: 'LOW', kind: 'k', ref: 'r', message: '' },
      { id: 'a', severity: 'HIGH', kind: 'k', ref: 'r', message: '' },
      { id: 'c', severity: 'MEDIUM', kind: 'k', ref: 'r', message: '' },
    ] as const;
    expect(sortFindings([...f]).map(x => x.id)).toEqual(['a', 'c', 'b']);
    expect(isConverged([f[0], f[2]])).toBe(true);
    expect(isConverged([...f])).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/contract-rules.test.ts`. Expected: FAIL (the module isn't found).

- [ ] **Step 3: Implement `src/services/contract-rules.ts`**

```ts
/**
 * Deterministic contract rules shared by every gate (lock / start / complete) and the
 * converge report. Pure functions over plain rows — no DB access, no LLM (decision #5).
 */
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export interface Finding { id: string; severity: Severity; kind: string; ref: string; message: string }

export const VERIFY_METHODS = ['test', 'command', 'api', 'inspection', 'manual'] as const;
export const VERDICTS = ['verified', 'partial', 'failed'] as const;
export const COVERAGE_CATEGORIES = [
  'behaviour', 'data', 'failure_modes', 'edge_cases', 'non_functional', 'integration', 'completion',
] as const;
export const MAX_SESSION_QUESTIONS = 5;

export interface ReqRow {
  id: number; requirementType: string; description: string; priority: string; status: string;
  verifyMethod: string | null; coverage: string | null;
}
export interface UnitRow { id: string; title: string; status: string; completedAt: string | null }
export interface RunRow { id: number; requirementId: number | null; verdict: string | null; createdAt: string }

const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const f = (severity: Severity, kind: string, ref: string, message: string): Finding =>
  ({ id: `${kind}:${ref}`, severity, kind, ref, message });
const isRequiredCriterion = (r: ReqRow) => r.requirementType === 'success_criterion' && r.priority === 'required';

// Enumeration markers at a word boundary: (1) 1. 1) a) (a). "1.5s" and "v2.1" don't match (digit must be followed by ")" or ". ").
const ENUM_MARKER = /(?:^|\s)\(?(?:\d{1,2}|[a-h])(?:\)|\.(?=\s))/g;
const LIST_LINE = /\n\s*[-*]\s+/;

export function isAtomic(text: string): boolean {
  if ((text.match(ENUM_MARKER) ?? []).length >= 2) return false;
  if ((text.match(/;/g) ?? []).length >= 2) return false;
  if (LIST_LINE.test(text)) return false;
  return true;
}

export function lockFindings(reqs: ReqRow[]): Finding[] {
  const out: Finding[] = [];
  for (const r of reqs.filter(isRequiredCriterion)) {
    if (!isAtomic(r.description)) {
      out.push(f('CRITICAL', 'non_atomic', `req:${r.id}`,
        `Criterion #${r.id} states several claims; split it into one requirement per claim.`));
    }
    if (!r.verifyMethod) {
      out.push(f('CRITICAL', 'no_verify_method', `req:${r.id}`,
        `Criterion #${r.id} has no verify method (${VERIFY_METHODS.join(', ')}).`));
    }
  }
  return out;
}

export function uncoveredCategories(reqs: ReqRow[]): string[] {
  const covered = new Set(reqs.map(r => r.coverage).filter(Boolean));
  return COVERAGE_CATEGORIES.filter(c => !covered.has(c));
}

export function principleFindings(
  principles: { id: number; statement: string }[], acks: { knowledgeId: number; mode: string }[],
  phase: 'lock' | 'converge',
): Finding[] {
  const byId = new Map(acks.map(a => [a.knowledgeId, a.mode]));
  const out: Finding[] = [];
  for (const p of principles) {
    const mode = byId.get(p.id);
    if (!mode && phase === 'lock') {
      out.push(f('CRITICAL', 'unacknowledged_principle', `knowledge:${p.id}`,
        `Principle #${p.id} not acknowledged (honoured | exception): ${p.statement}`));
    }
    if (mode === 'exception' && phase === 'converge') {
      out.push(f('LOW', 'principle_exception', `knowledge:${p.id}`, `Justified exception to: ${p.statement}`));
    }
  }
  return out;
}

export function coverageFindings(
  reqs: ReqRow[], units: UnitRow[], links: { workUnitId: string; requirementId: number }[],
): Finding[] {
  const out: Finding[] = [];
  const served = new Set(links.map(l => l.requirementId));
  const linkedUnits = new Set(links.map(l => l.workUnitId));
  for (const r of reqs.filter(isRequiredCriterion)) {
    if (r.status !== 'NOT_APPLICABLE' && !served.has(r.id)) {
      out.push(f('CRITICAL', 'uncovered', `req:${r.id}`, `No work unit serves criterion #${r.id}: ${r.description}`));
    }
  }
  for (const u of units) {
    if (!linkedUnits.has(u.id)) {
      out.push(f('MEDIUM', 'unrequested', `wu:${u.id}`, `Work unit ${u.id} serves no criterion: ${u.title}`));
    }
  }
  return out;
}

export function evidenceFindings(
  reqs: ReqRow[], runs: RunRow[], units: UnitRow[], openFailures: { id: number; errorMessage: string | null }[],
): Finding[] {
  const out: Finding[] = [];
  const lastWorkDone = units.map(u => u.completedAt).filter((x): x is string => !!x).sort().at(-1);
  const latest = (reqId: number) => runs
    .filter(r => r.requirementId === reqId && r.verdict)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).at(-1);
  for (const r of reqs) {
    if (r.status === 'NOT_APPLICABLE') continue;
    if (r.requirementType === 'constraint' || r.requirementType === 'exclusion') {
      out.push(f('LOW', 'review', `req:${r.id}`, `Confirm still honoured: ${r.description}`));
      continue;
    }
    if (r.requirementType !== 'success_criterion') continue;
    const run = latest(r.id);
    if (r.priority !== 'required') {
      if (run?.verdict !== 'verified') out.push(f('MEDIUM', 'missing_optional', `req:${r.id}`, `Optional criterion #${r.id} unverified`));
      continue;
    }
    if (!run) out.push(f('CRITICAL', 'missing', `req:${r.id}`, `No evidence for criterion #${r.id}: ${r.description}`));
    else if (run.verdict === 'failed') out.push(f('CRITICAL', 'contradicts', `req:${r.id}`, `Latest evidence for #${r.id} failed`));
    else if (run.verdict === 'partial') out.push(f('HIGH', 'partial', `req:${r.id}`, `Evidence for #${r.id} is partial`));
    else if (lastWorkDone && run.createdAt < lastWorkDone) {
      out.push(f('HIGH', 'stale_evidence', `req:${r.id}`, `#${r.id} verified before the last work unit completed; re-verify`));
    }
  }
  for (const u of units) {
    if (!['COMPLETED', 'SKIPPED'].includes(u.status)) {
      out.push(f('HIGH', 'unfinished_work', `wu:${u.id}`, `Work unit ${u.id} is ${u.status}: ${u.title}`));
    }
  }
  for (const x of openFailures) {
    out.push(f('CRITICAL', 'open_failure', `failure:${x.id}`, `Unresolved failure #${x.id}: ${x.errorMessage ?? ''}`));
  }
  return out;
}

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
}

export function isConverged(list: Finding[]): boolean {
  return !list.some(x => x.severity === 'CRITICAL' || x.severity === 'HIGH');
}
```

- [ ] **Step 4:** Run `npx vitest run tests/contract-rules.test.ts`. Expected: PASS. If an `isAtomic` fixture fails, adjust only `ENUM_MARKER` and re-run all fixtures; the fixtures are the spec.

- [ ] **Step 5: Commit** (`feat: deterministic contract rules module`, with the trailers).

---

### Task 3: Activity, staleness, cancel

**Files:**
- Create: `src/services/activity.ts`
- Modify: `src/services/goals.ts` (`currentGoal`, new `cancelGoal`, `staleGoals`), `src/services/decisions.ts` (`addDecision`, `addObservation`), `src/services/failures.ts` (`addFailure`), `src/services/work.ts` (`createWorkUnit`, `updateWorkUnit`), `src/services/verification.ts` (`recordVerification`), `src/services/questions.ts` (`addQuestion`, `answerQuestion`, `dismissQuestion`), `src/services/resume.ts` (`resumeGoal`)
- Test: `tests/activity.test.ts`

**Interfaces:**
- Produces:
  - `touchGoal(db: BrainDb, goalId: string | null | undefined, at?: Date): void` (no-op for null; ignores unknown ids)
  - `staleDays(): number` (reads `BRAIN_STALE_DAYS`, default 7, invalid → 7)
  - `isStale(goal: { status: string; updatedAt: string }, now?: Date): boolean`
  - in `goals.ts`: `currentGoal(db, opts?: { now?: Date })`, `staleGoals(db, now?: Date): Goal[]`, `cancelGoal(db, id: string, reason: string): Goal`

- [ ] **Step 1: Write the failing tests** (`tests/activity.test.ts`)

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal, currentGoal, staleGoals, cancelGoal, getGoal, lockGoal } from '../src/services/goals.js';
import { touchGoal, isStale, staleDays } from '../src/services/activity.js';
import { addDecision, listDecisions } from '../src/services/decisions.js';
import { resumeGoal } from '../src/services/resume.js';
import { makeLockable } from './helpers.js';

const setUpdated = (db: ReturnType<typeof createTestDb>, id: string, iso: string) =>
  db.$client.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(iso, id);

afterEach(() => { delete process.env.BRAIN_STALE_DAYS; });

describe('activity and staleness', () => {
  it('staleDays defaults to 7 and honours env', () => {
    expect(staleDays()).toBe(7);
    process.env.BRAIN_STALE_DAYS = '3'; expect(staleDays()).toBe(3);
    process.env.BRAIN_STALE_DAYS = 'x'; expect(staleDays()).toBe(7);
  });

  it('isStale only for open statuses past the threshold', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(isStale({ status: 'EXECUTING', updatedAt: '2026-10-02T00:00:00Z' }, now)).toBe(true);
    expect(isStale({ status: 'EXECUTING', updatedAt: '2026-10-04T00:00:00Z' }, now)).toBe(false);
    expect(isStale({ status: 'COMPLETED', updatedAt: '2026-01-01T00:00:00Z' }, now)).toBe(false);
  });

  it('currentGoal skips stale goals; staleGoals lists them', () => {
    const db = createTestDb();
    const old = createGoal(db, { title: 'old', objective: 'o' }); makeLockable(db, old.id); lockGoal(db, old.id);
    const fresh = createGoal(db, { title: 'fresh', objective: 'o' }); makeLockable(db, fresh.id); lockGoal(db, fresh.id);
    setUpdated(db, old.id, '2026-09-01T00:00:00Z');
    setUpdated(db, fresh.id, '2026-10-08T00:00:00Z');
    const now = new Date('2026-10-10T00:00:00Z');
    expect(currentGoal(db, { now })?.id).toBe(fresh.id);
    expect(staleGoals(db, now).map(g => g.id)).toEqual([old.id]);
    setUpdated(db, fresh.id, '2026-09-01T00:00:00Z');
    expect(currentGoal(db, { now })).toBeUndefined();
  });

  it('goal-scoped writes touch the goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    setUpdated(db, g.id, '2026-01-01T00:00:00Z');
    addDecision(db, { goalId: g.id, decision: 'd' });
    expect(getGoal(db, g.id).updatedAt > '2026-01-01T00:00:00Z').toBe(true);
  });

  it('resume un-stales; get by id still works on stale goals', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    setUpdated(db, g.id, '2020-01-01T00:00:00Z');
    expect(getGoal(db, g.id).id).toBe(g.id);
    resumeGoal(db, g.id);
    expect(isStale(getGoal(db, g.id))).toBe(false);
  });

  it('cancelGoal needs a reason, is terminal, records an observation', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => cancelGoal(db, g.id, ' ')).toThrow(/reason/);
    expect(cancelGoal(db, g.id, 'superseded').status).toBe('CANCELLED');
    expect(() => cancelGoal(db, g.id, 'again')).toThrow(/CANCELLED/);
    const obs = db.$client.prepare('SELECT observation FROM observations WHERE goal_id = ?').all(g.id) as { observation: string }[];
    expect(obs.map(o => o.observation)).toContain('Goal cancelled: superseded');
  });

  it('touchGoal ignores null and unknown ids', () => {
    const db = createTestDb();
    expect(() => { touchGoal(db, null); touchGoal(db, 'GOAL-NOPE'); }).not.toThrow();
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/activity.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/services/activity.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goals } from '../db/schema.js';

const OPEN = ['DRAFT', 'LOCKED', 'PLANNING', 'EXECUTING', 'VERIFYING', 'BLOCKED'];
const DAY_MS = 86_400_000;

/** Any goal-scoped write bumps updated_at so live goals never look abandoned. */
export function touchGoal(db: BrainDb, goalId: string | null | undefined, at: Date = new Date()): void {
  if (!goalId) return;
  db.update(goals).set({ updatedAt: at.toISOString() }).where(eq(goals.id, goalId)).run();
}

export function staleDays(): number {
  const n = Number(process.env.BRAIN_STALE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export function isStale(goal: { status: string; updatedAt: string }, now: Date = new Date()): boolean {
  return OPEN.includes(goal.status) && now.getTime() - Date.parse(goal.updatedAt) > staleDays() * DAY_MS;
}
```

- [ ] **Step 4: Wire `touchGoal`** by adding one line after each insert/update, importing from `./activity.js`:
  - `decisions.ts`: `addDecision` → `touchGoal(db, input.goalId);`, and the same in `addObservation`.
  - `failures.ts`: `addFailure` → `touchGoal(db, input.goalId);`. In `addSolution`, after the insert: `touchGoal(db, getFailure(db, failureId).goalId);`
  - `work.ts`:
    - `createWorkUnit` → `touchGoal(db, input.goalId);`
    - `updateWorkUnit` → `touchGoal(db, wu.goalId);`
  - `verification.ts`: `recordVerification` → `touchGoal(db, input.goalId);`
  - `questions.ts`: in `addQuestion`, `answerQuestion` and `dismissQuestion`, call `touchGoal(db, <goalId>)` before `refreshClarificationStatus`.
  - `resume.ts`: first line of `resumeGoal` → `touchGoal(db, id);`

  `goals.ts` already sets `updatedAt` in `setStatus` and `setGoalFields`. Don't import `activity.ts` from `decisions.ts` via `goals.ts`; `activity.ts` imports only schema, so there is no cycle.

- [ ] **Step 5: Edit `src/services/goals.ts`**

```ts
import { isStale } from './activity.js';

export function currentGoal(db: BrainDb, opts: { now?: Date } = {}): Goal | undefined {
  return db.select().from(goals)
    .where(inArray(goals.status, ACTIVE_STATUSES))
    .orderBy(desc(goals.updatedAt))
    .all()
    .find(g => !isStale(g, opts.now));
}

export function staleGoals(db: BrainDb, now: Date = new Date()): Goal[] {
  return listGoals(db).filter(g => isStale(g, now));
}

export function cancelGoal(db: BrainDb, id: string, reason: string): Goal {
  const g = getGoal(db, id);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot cancel.`);
  if (!reason?.trim()) throw new Error('Cancelling a goal requires a reason.');
  db.insert(observations).values({
    goalId: id, scopeType: 'GOAL', scopeId: `goal:${id}`,
    observation: `Goal cancelled: ${reason.trim()}`, createdAt: now(),
  }).run();
  return setStatus(db, id, 'CANCELLED');
}
```

`currentGoal` today only considers `ACTIVE_STATUSES` (no DRAFT); keep that. `staleGoals` includes DRAFT via `isStale`'s `OPEN` list.

- [ ] **Step 6:** Run `npx vitest run tests/activity.test.ts`, then `npm test`. Expected: PASS. If an existing test asserted `updatedAt` equality after a decision or observation, update it to `>=`.

- [ ] **Step 7: Commit** (`feat: goal activity touch, staleness, cancel`).

---

### Task 4: v1 lock gate (atomic, verify method, principles, project links)

**Files:**
- Modify: `src/services/goals.ts` (`addRequirement`, `lockGoal`)
- Create: `src/services/principles.ts`
- Modify: `tests/helpers.ts` (`makeLockable`)
- Test: `tests/lock-gate.test.ts`

**Interfaces:**
- Consumes: `lockFindings`, `principleFindings`, `VERIFY_METHODS`, `COVERAGE_CATEGORIES`, `ReqRow` (Task 2); `touchGoal` (Task 3)
- Produces:
  - `addRequirement(db, goalId, { type, description, priority?, verifyMethod?, coverage? })`, which validates `verifyMethod ∈ VERIFY_METHODS` and `coverage ∈ COVERAGE_CATEGORIES`
  - in `principles.ts`:
    - `linkGoalProject(db, goalId: string, projectIdOrName: string): { goalId: string; projectId: string }`
    - `goalProjectIds(db, goalId): string[]`
    - `applicablePrinciples(db, goalId): { id: number; statement: string; scopeId: string | null }[]`
    - `ackPrinciple(db, input: { goalId: string; knowledgeId: number; mode: 'honoured' | 'exception'; note: string }): GoalPrincipleAck`
    - `listPrincipleAcks(db, goalId)`
  - `lockGoal` sets `rulesVersion: 1`
  - `toReqRow(r: Requirement): ReqRow` exported from `goals.ts`

- [ ] **Step 1: Write the failing tests** (`tests/lock-gate.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable } from './helpers.js';
import { createGoal, addRequirement, lockGoal, getGoal, setGoalFields, ContractIncompleteError } from '../src/services/goals.js';
import { addKnowledge } from '../src/services/knowledge.js';
import { addProject } from '../src/services/projects.js';
import { linkGoalProject, applicablePrinciples, ackPrinciple } from '../src/services/principles.js';
import { listDecisions } from '../src/services/decisions.js';

function draft(db: ReturnType<typeof createTestDb>, criterion: string, verifyMethod?: string) {
  const g = createGoal(db, { title: 't', objective: 'o' });
  setGoalFields(db, g.id, { riskLevel: 'LOW' });
  addRequirement(db, g.id, { type: 'scope', description: 's' });
  addRequirement(db, g.id, { type: 'success_criterion', description: criterion, verifyMethod });
  return g;
}

describe('v1 lock gate', () => {
  it('refuses a blob criterion (GOAL-2026-0031 criterion #97)', () => {
    const db = createTestDb();
    const g = draft(db, '(1) env set (2) login works (3) data flows', 'manual');
    expect(() => lockGoal(db, g.id)).toThrow(ContractIncompleteError);
    expect(() => lockGoal(db, g.id)).toThrow(/several claims/);
  });

  it('refuses a criterion without verify method', () => {
    const db = createTestDb();
    expect(() => lockGoal(db, draft(db, 'login works').id)).toThrow(/verify method/);
  });

  it('locks an atomic, method-tagged criterion and sets rules_version 1', () => {
    const db = createTestDb();
    const g = lockGoal(db, draft(db, 'login works', 'test').id);
    expect(g.rulesVersion).toBe(1);
  });

  it('validates verifyMethod and coverage values', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => addRequirement(db, g.id, { type: 'success_criterion', description: 'x', verifyMethod: 'vibes' })).toThrow(/verify method/);
    expect(() => addRequirement(db, g.id, { type: 'constraint', description: 'x', coverage: 'misc' })).toThrow(/coverage/);
  });

  it('principles: GLOBAL + linked project apply; lock refuses until acknowledged', () => {
    const db = createTestDb();
    const p = addProject(db, { name: 'market' });
    const glob = addKnowledge(db, { statement: 'No secrets in Brain', category: 'principle', scopeType: 'GLOBAL' });
    const proj = addKnowledge(db, { statement: 'Sandbox first', category: 'principle', scopeType: 'PROJECT', scopeId: `project:${p.id}` });
    addKnowledge(db, { statement: 'Other project rule', category: 'principle', scopeType: 'PROJECT', scopeId: 'project:elsewhere' });
    const g = draft(db, 'strategy runs in analyzer', 'inspection');
    linkGoalProject(db, g.id, 'market');
    expect(applicablePrinciples(db, g.id).map(x => x.id).sort()).toEqual([glob.id, proj.id].sort());
    expect(() => lockGoal(db, g.id)).toThrow(/Sandbox first/);
    ackPrinciple(db, { goalId: g.id, knowledgeId: glob.id, mode: 'honoured', note: 'no secrets stored' });
    ackPrinciple(db, { goalId: g.id, knowledgeId: proj.id, mode: 'exception', note: 'read-only quote call only' });
    expect(listDecisions(db, { goalId: g.id }).some(d => d.decision.includes('Principle exception'))).toBe(true);
    expect(lockGoal(db, g.id).status).toBe('LOCKED');
  });

  it('ack exception requires a note; ack rejects non-applicable principle', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { statement: 'x', category: 'principle', scopeType: 'PROJECT', scopeId: 'project:elsewhere' });
    const g = draft(db, 'y', 'test');
    expect(() => ackPrinciple(db, { goalId: g.id, knowledgeId: k.id, mode: 'honoured', note: 'n' })).toThrow(/not applicable/);
  });

  it('force-lock with reason still bypasses and records a decision', () => {
    const db = createTestDb();
    const g = draft(db, '(1) a (2) b', 'test');
    expect(lockGoal(db, g.id, { force: true, reason: 'spike' }).rulesVersion).toBe(1);
    expect(listDecisions(db, { goalId: g.id })[0]!.reason).toContain('several claims');
  });

  it('makeLockable still yields a lockable goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    expect(lockGoal(db, g.id).status).toBe('LOCKED');
    expect(getGoal(db, g.id).rulesVersion).toBe(1);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/lock-gate.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/services/principles.ts`**

```ts
import { and, eq, inArray, or } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goalPrincipleAcks, goalProjects, knowledge } from '../db/schema.js';
import { touchGoal } from './activity.js';
import { addDecision } from './decisions.js';
import { getGoal, GoalLockedError } from './goals.js';
import { getProject } from './projects.js';

export type GoalPrincipleAck = typeof goalPrincipleAcks.$inferSelect;

export function linkGoalProject(db: BrainDb, goalId: string, projectIdOrName: string) {
  getGoal(db, goalId);
  const projectId = getProject(db, projectIdOrName).id;
  db.insert(goalProjects).values({ goalId, projectId }).onConflictDoNothing().run();
  touchGoal(db, goalId);
  return { goalId, projectId };
}

export function goalProjectIds(db: BrainDb, goalId: string): string[] {
  return db.select().from(goalProjects).where(eq(goalProjects.goalId, goalId)).all().map(r => r.projectId);
}

/** Active `principle` knowledge: GLOBAL + PROJECT rows for every project linked to the goal. */
export function applicablePrinciples(db: BrainDb, goalId: string) {
  const scopes = goalProjectIds(db, goalId).map(p => `project:${p}`);
  const scopeCond = scopes.length
    ? or(eq(knowledge.scopeType, 'GLOBAL'), and(eq(knowledge.scopeType, 'PROJECT'), inArray(knowledge.scopeId, scopes)))
    : eq(knowledge.scopeType, 'GLOBAL');
  return db.select().from(knowledge)
    .where(and(eq(knowledge.category, 'principle'), eq(knowledge.status, 'active'), scopeCond))
    .all().map(k => ({ id: k.id, statement: k.statement, scopeId: k.scopeId }));
}

export function listPrincipleAcks(db: BrainDb, goalId: string): GoalPrincipleAck[] {
  return db.select().from(goalPrincipleAcks).where(eq(goalPrincipleAcks.goalId, goalId)).all();
}

export function ackPrinciple(db: BrainDb, input: {
  goalId: string; knowledgeId: number; mode: 'honoured' | 'exception'; note: string;
}): GoalPrincipleAck {
  const g = getGoal(db, input.goalId);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${input.goalId} is locked; principle acks are frozen.`);
  if (!['honoured', 'exception'].includes(input.mode)) throw new Error(`Invalid ack mode: ${input.mode}`);
  if (!input.note?.trim()) throw new Error('A principle acknowledgement needs a note.');
  const p = applicablePrinciples(db, input.goalId).find(x => x.id === input.knowledgeId);
  if (!p) throw new Error(`Principle #${input.knowledgeId} is not applicable to ${input.goalId}.`);
  let decisionId: number | null = null;
  if (input.mode === 'exception') {
    decisionId = addDecision(db, {
      goalId: input.goalId, decision: `Principle exception: ${p.statement}`,
      reason: input.note.trim(), riskLevel: 'MEDIUM', reversible: true,
    }).id;
  }
  db.insert(goalPrincipleAcks).values({
    goalId: input.goalId, knowledgeId: input.knowledgeId, mode: input.mode,
    note: input.note.trim(), decisionId, createdAt: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: [goalPrincipleAcks.goalId, goalPrincipleAcks.knowledgeId],
    set: { mode: input.mode, note: input.note.trim(), decisionId },
  }).run();
  touchGoal(db, input.goalId);
  return listPrincipleAcks(db, input.goalId).find(a => a.knowledgeId === input.knowledgeId)!;
}
```

`principles.ts` imports `goals.ts`, and `goals.ts` must **not** import `principles.ts` (that would be a cycle). So `lockGoal` reads principles through a small query duplicated in `goals.ts`; see Step 4.

- [ ] **Step 4: Edit `src/services/goals.ts`**
  - Imports:
    ```ts
    import { goalPrincipleAcks, goalProjects, knowledge } from '../db/schema.js';
    import { COVERAGE_CATEGORIES, lockFindings, principleFindings, VERIFY_METHODS, type ReqRow } from './contract-rules.js';
    ```
  - `toReqRow`:
    ```ts
    export const toReqRow = (r: Requirement): ReqRow => ({
      id: r.id, requirementType: r.requirementType, description: r.description, priority: r.priority,
      status: r.status, verifyMethod: r.verifyMethod, coverage: r.coverage,
    });
    ```
  - `addRequirement` input gains `verifyMethod?: string; coverage?: string`. Validate before the insert, then insert `verifyMethod: input.verifyMethod ?? null, coverage: input.coverage ?? null`:
    ```ts
    if (input.verifyMethod !== undefined && !(VERIFY_METHODS as readonly string[]).includes(input.verifyMethod)) {
      throw new Error(`Invalid verify method: ${input.verifyMethod} (expected ${VERIFY_METHODS.join(', ')})`);
    }
    if (input.coverage !== undefined && !(COVERAGE_CATEGORIES as readonly string[]).includes(input.coverage)) {
      throw new Error(`Invalid coverage category: ${input.coverage} (expected ${COVERAGE_CATEGORIES.join(', ')})`);
    }
    ```
  - Principle findings for lock, kept local to avoid an import cycle with `principles.ts`. `applicablePrinciples` in `principles.ts` must use the identical predicate:
    ```ts
    function lockPrincipleFindings(db: BrainDb, goalId: string) {
      const scopes = db.select().from(goalProjects).where(eq(goalProjects.goalId, goalId)).all().map(r => `project:${r.projectId}`);
      const principles = db.select().from(knowledge)
        .where(and(eq(knowledge.category, 'principle'), eq(knowledge.status, 'active'))).all()
        .filter(k => k.scopeType === 'GLOBAL' || (k.scopeType === 'PROJECT' && scopes.includes(k.scopeId ?? '')))
        .map(k => ({ id: k.id, statement: k.statement }));
      const acks = db.select().from(goalPrincipleAcks).where(eq(goalPrincipleAcks.goalId, goalId)).all();
      return principleFindings(principles, acks, 'lock');
    }
    ```
  - In `lockGoal`, replace the `unresolved` computation:
    ```ts
    const check = checkContract(db, id);
    const v1 = [...lockFindings(listRequirements(db, id).map(toReqRow)), ...lockPrincipleFindings(db, id)];
    const unresolved = [
      ...check.gaps.map(x => x.message),
      ...check.openQuestions.map(q => `open question #${q.id}: ${q.question}`),
      ...v1.map(x => x.message),
    ];
    const ready = check.ready && v1.length === 0;
    if (!ready && !opts.force) {
      throw new ContractIncompleteError(`Cannot lock ${id}; contract incomplete (§9): ${unresolved.join('; ')}`);
    }
    ```
    Inside the transaction, use `if (!ready)` for the force decision. In the final `tx.update(goals).set({...})`, add `rulesVersion: 1`.

- [ ] **Step 5: Edit `tests/helpers.ts` `makeLockable`.** Add `verifyMethod: 'test'` to its `success_criterion` insert:

```ts
    addRequirement(db, goalId, { type: 'success_criterion', description: 'test criterion', verifyMethod: 'test' });
```

Other existing tests that lock goals with their own criteria (`contract.test.ts`, `goals.test.ts`, `resume.test.ts`, `intake.test.ts`, `questions.test.ts`, `mcp.test.ts`, `cli.test.ts`) need `verifyMethod: 'test'` (CLI: `--verify test`, MCP: `verifyMethod: 'test'`) added to those criterion inserts. Change nothing else in them.

- [ ] **Step 6:** Run `npx vitest run tests/lock-gate.test.ts`, then `npm test`. Fix each failing older test by adding `verifyMethod` only. Expected: all PASS.

- [ ] **Step 7: Commit** (`feat: v1 lock gate — atomic criteria, verify methods, principles`).

---

### Task 5: Intake: coverage question, question cap, recommended answers

**Files:**
- Modify: `src/services/intake.ts`, `src/services/questions.ts`
- Test: `tests/intake-coverage.test.ts`

**Interfaces:**
- Consumes: `uncoveredCategories`, `MAX_SESSION_QUESTIONS` (Task 2); `goalProjectIds`, `applicablePrinciples`, `listPrincipleAcks` (Task 4)
- Produces:
  - `addQuestion(db, goalId, { question, materiality?, source?, checkKey?, recommended? })`, which throws on the 6th material session question
  - `IntakeReport` gains `principles: { id: number; statement: string; ack: string | null }[]` and `uncoveredCategories: string[]`
  - `reviewItems.kind` gains `'no_project_link'`
  - Brain question `review:coverage`

- [ ] **Step 1: Write the failing tests** (`tests/intake-coverage.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal, addRequirement } from '../src/services/goals.js';
import { buildIntakeReport } from '../src/services/intake.js';
import { addQuestion, listQuestions, answerQuestion } from '../src/services/questions.js';
import type { Embedder } from '../src/services/embedder.js';

const failingEmbedder: Embedder = { model: 'none', dim: 0, embed: async () => { throw new Error('offline'); } } as unknown as Embedder;

describe('intake coverage + question cap', () => {
  it('upserts one review:coverage question listing uncovered categories, idempotently', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addRequirement(db, g.id, { type: 'constraint', description: 'c', coverage: 'data' });
    const r1 = await buildIntakeReport(db, failingEmbedder, g.id);
    await buildIntakeReport(db, failingEmbedder, g.id);
    const cov = listQuestions(db, g.id).filter(q => q.checkKey === 'review:coverage');
    expect(cov).toHaveLength(1);
    expect(cov[0]!.question).toContain('failure_modes');
    expect(cov[0]!.question).not.toContain(' data,');
    expect(r1.uncoveredCategories).not.toContain('data');
    answerQuestion(db, cov[0]!.id, 'n/a: integration — standalone; rest covered');
    const r3 = await buildIntakeReport(db, failingEmbedder, g.id);
    expect(r3.openQuestions.some(q => q.checkKey === 'review:coverage')).toBe(false);
    expect(listQuestions(db, g.id).filter(q => q.checkKey === 'review:coverage')).toHaveLength(1);
  });

  it('flags no project link as a review item', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = await buildIntakeReport(db, failingEmbedder, g.id);
    expect(r.reviewItems.some(i => i.kind === 'no_project_link')).toBe(true);
  });

  it('caps material session questions at 5; detail and brain questions do not count', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    for (let i = 0; i < 5; i++) addQuestion(db, g.id, { question: `q${i}?`, recommended: `A${i}` });
    addQuestion(db, g.id, { question: 'detail?', materiality: 'detail' });
    addQuestion(db, g.id, { question: 'brain?', source: 'brain', checkKey: 'review:x' });
    expect(() => addQuestion(db, g.id, { question: 'sixth?' })).toThrow(/at most 5/);
    expect(listQuestions(db, g.id).find(q => q.question === 'q0?')!.recommended).toBe('A0');
  });
});
```

Note: the embedder stub shape must match the `Embedder` interface in `src/services/embedder.ts`. Copy the failing-embedder stub from `tests/intake.test.ts` if one exists there, and use it instead of the literal above.

- [ ] **Step 2:** Run `npx vitest run tests/intake-coverage.test.ts`. Expected: FAIL.

- [ ] **Step 3: Edit `src/services/questions.ts` `addQuestion`.** Add `recommended?: string` to the input, then before the insert:

```ts
  const materiality = input.materiality ?? 'material';
  const source = input.source ?? 'session';
  if (materiality === 'material' && source === 'session') {
    const existing = db.select().from(goalQuestions).where(and(
      eq(goalQuestions.goalId, goalId), eq(goalQuestions.materiality, 'material'), eq(goalQuestions.source, 'session'),
    )).all().length;
    if (existing >= MAX_SESSION_QUESTIONS) {
      throw new Error(`A goal may ask at most ${MAX_SESSION_QUESTIONS} material questions; prioritise by impact × uncertainty and record the rest as assumptions.`);
    }
  }
```

Insert `recommended: input.recommended?.trim() || null`. Import `MAX_SESSION_QUESTIONS` from `./contract-rules.js`, and `and` from drizzle if it isn't already imported.

- [ ] **Step 4: Edit `src/services/intake.ts`**
  - Add the constant:
    ```ts
    const COVERAGE_CHECK_KEY = 'review:coverage';
    const coverageQuestion = (cats: string[]) =>
      `Which of these areas does the contract still need to address: ${cats.join(', ')}? ` +
      'Add a contract line tagged with the category (requirement add --coverage <cat>) or answer ' +
      '"n/a: <category> — <reason>" for each.';
    ```
  - In the `if (editable)` block, after the behaviour upsert:
    ```ts
    const uncovered = uncoveredCategories(listRequirements(db, goalId).map(toReqRow));
    if (uncovered.length > 0) upsertBrainQuestion(db, goalId, COVERAGE_CHECK_KEY, coverageQuestion(uncovered));
    ```
    `upsertBrainQuestion` returns the existing row unchanged, so the question text is fixed at first creation. That's intended, since the answer covers the list as first shown.
  - After the review-items loop:
    ```ts
    if (goalProjectIds(db, goalId).length === 0) {
      reviewItems.push({ kind: 'no_project_link', ref: `goal:${goalId}`, text: 'No project linked — only GLOBAL principles are checked (goal link-project)', score: 0 });
    }
    const acks = new Map(listPrincipleAcks(db, goalId).map(a => [a.knowledgeId, a.mode]));
    const principles = applicablePrinciples(db, goalId).map(p => ({ id: p.id, statement: p.statement, ack: acks.get(p.id) ?? null }));
    ```
  - Add `principles`, `uncoveredCategories: uncoveredCategories(listRequirements(db, goalId).map(toReqRow))` to the returned object and the `IntakeReport` interface. Extend the `reviewItems` kind union with `'no_project_link'`.
  - `nextAction`: before `'ready to lock'`, if any principle has `ack === null`, set `nextAction = 'acknowledge N principle(s) (principle ack)'`. Keep the existing precedence for open questions and gaps first.
  - Imports: `toReqRow` from `./goals.js`; `uncoveredCategories` from `./contract-rules.js`; `goalProjectIds, applicablePrinciples, listPrincipleAcks` from `./principles.js`.

- [ ] **Step 5:** Run `npx vitest run tests/intake-coverage.test.ts`, then `npm test`. Existing intake tests that assert an exact question count or a "ready to lock" `nextAction` will now see `review:coverage`. Update those assertions to include it, or answer it in the test setup. Expected: all PASS.

- [ ] **Step 6: Commit** (`feat: intake coverage taxonomy, question cap, recommended answers`).

---

### Task 6: Work trace and start gate

**Files:**
- Modify: `src/services/work.ts` (`createWorkUnit`), `src/services/goals.ts` (`startGoal`)
- Modify: `tests/helpers.ts` (add `makeStartable`)
- Test: `tests/start-gate.test.ts`

**Interfaces:**
- Consumes: `coverageFindings` (Task 2), `toReqRow` (Task 4)
- Produces:
  - `createWorkUnit(db, { …, serves?: number[] })`, which validates that each id is a requirement of the same goal
  - `workUnitLinks(db, goalId): { workUnitId: string; requirementId: number }[]` exported from `work.ts`
  - `makeStartable(db, goalId): WorkUnit` test helper

- [ ] **Step 1: Write the failing tests** (`tests/start-gate.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable, makeStartable } from './helpers.js';
import { createGoal, addRequirement, lockGoal, startGoal, listRequirements } from '../src/services/goals.js';
import { createWorkUnit, workUnitLinks } from '../src/services/work.js';

describe('start gate (criterion #99)', () => {
  it('refuses while a required criterion has no serving work unit', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    addRequirement(db, g.id, { type: 'success_criterion', description: 'second', verifyMethod: 'test' });
    lockGoal(db, g.id);
    const [c1] = listRequirements(db, g.id).filter(r => r.requirementType === 'success_criterion');
    createWorkUnit(db, { goalId: g.id, title: 'do one', serves: [c1!.id] });
    expect(() => startGoal(db, g.id)).toThrow(/No work unit serves criterion #\d+: second/);
    makeStartable(db, g.id);
    expect(startGoal(db, g.id).status).toBe('EXECUTING');
  });

  it('serves must reference requirements of the same goal', () => {
    const db = createTestDb();
    const a = createGoal(db, { title: 'a', objective: 'o' }); makeLockable(db, a.id);
    const b = createGoal(db, { title: 'b', objective: 'o' });
    const reqA = listRequirements(db, a.id)[0]!;
    expect(() => createWorkUnit(db, { goalId: b.id, title: 'x', serves: [reqA.id] })).toThrow(/not a requirement of/);
    expect(() => createWorkUnit(db, { goalId: b.id, title: 'x', serves: [99999] })).toThrow(/not a requirement of/);
  });

  it('v0 goals start without coverage', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id); lockGoal(db, g.id);
    db.$client.prepare('UPDATE goals SET rules_version = 0 WHERE id = ?').run(g.id);
    expect(startGoal(db, g.id).status).toBe('EXECUTING');
  });

  it('workUnitLinks lists links', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' }); makeLockable(db, g.id);
    const wu = makeStartable(db, g.id);
    expect(workUnitLinks(db, g.id).every(l => l.workUnitId === wu.id)).toBe(true);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/start-gate.test.ts`. Expected: FAIL.

- [ ] **Step 3: Edit `src/services/work.ts`**

```ts
import { goalRequirements, workUnitRequirements } from '../db/schema.js';

// in createWorkUnit, input gains `serves?: number[]`; before the insert:
  for (const reqId of input.serves ?? []) {
    const r = db.select().from(goalRequirements).where(eq(goalRequirements.id, reqId)).get();
    if (!r || r.goalId !== input.goalId) throw new Error(`Requirement #${reqId} is not a requirement of ${input.goalId}.`);
  }
// after the dependencies loop:
  for (const reqId of new Set(input.serves ?? [])) {
    db.insert(workUnitRequirements).values({ workUnitId: id, requirementId: reqId }).run();
  }

export function workUnitLinks(db: BrainDb, goalId: string): { workUnitId: string; requirementId: number }[] {
  const ids = listWorkUnits(db, goalId).map(w => w.id);
  if (ids.length === 0) return [];
  return db.select().from(workUnitRequirements).where(inArray(workUnitRequirements.workUnitId, ids)).all();
}
```

- [ ] **Step 4: Edit `startGoal` in `src/services/goals.ts`.** `goals.ts` must not import `work.ts`, because `work.ts` imports `goals.ts`. Query the tables directly:

```ts
import { workUnits, workUnitRequirements } from '../db/schema.js';
import { coverageFindings } from './contract-rules.js';

export function startGoal(db: BrainDb, id: string): Goal {
  const g = getGoal(db, id);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot start.`);
  if (!g.lockedAt) throw new Error(`Goal ${id} must be locked before starting (§10).`);
  if (g.rulesVersion >= 1) {
    const units = db.select().from(workUnits).where(eq(workUnits.goalId, id)).all();
    const links = units.length
      ? db.select().from(workUnitRequirements).where(inArray(workUnitRequirements.workUnitId, units.map(u => u.id))).all()
      : [];
    const uncovered = coverageFindings(listRequirements(db, id).map(toReqRow), units, links)
      .filter(f => f.kind === 'uncovered');
    if (uncovered.length > 0) {
      throw new ContractIncompleteError(`Cannot start ${id}; plan does not cover the contract: ${uncovered.map(f => f.message).join('; ')}`);
    }
  }
  return setStatus(db, id, 'EXECUTING', { startedAt: g.startedAt ?? now() });
}
```

- [ ] **Step 5: Add to `tests/helpers.ts`**

```ts
import { createWorkUnit } from '../src/services/work.js';

/** One work unit serving every required success criterion, so a v1 goal can start. */
export function makeStartable(db: BrainDb, goalId: string) {
  const serves = listRequirements(db, goalId)
    .filter(r => r.requirementType === 'success_criterion' && r.priority === 'required').map(r => r.id);
  return createWorkUnit(db, { goalId, title: 'implement', serves });
}
```

- [ ] **Step 6:** Run `npx vitest run tests/start-gate.test.ts`, then `npm test`. Every existing test that calls `startGoal` on a goal locked in-test gets a `makeStartable(db, g.id)` call before `startGoal` (`goals.test.ts`, `resume.test.ts`, `context.test.ts`, `model.test.ts`, `mcp.test.ts`, `cli.test.ts` as applicable). Tests that assert exact work-unit lists or "Work on WU-…" recommendations should create their own work units with `serves` instead. Expected: all PASS.

- [ ] **Step 7: Commit** (`feat: work units serve criteria; start gate requires coverage`).

---

### Task 7: Verdicts, converge report, complete gate

**Files:**
- Modify: `src/services/verification.ts` (`recordVerification`)
- Create: `src/services/converge.ts`
- Modify: `src/services/goals.ts` (`completeGoal`)
- Modify: `tests/helpers.ts` (add `satisfyCriteria`)
- Test: `tests/converge.test.ts`

**Interfaces:**
- Consumes: Task 2 rules; `toReqRow` (Task 4); principle tables (Task 4)
- Produces:
  - `recordVerification(db, { passed?: boolean; verdict?: 'verified'|'partial'|'failed'; …existing })`, where at least one of `passed`/`verdict` is required
  - `convergeGoal(db, goalId): ConvergeReport`, where `ConvergeReport = { goalId: string; rulesVersion: number; converged: boolean; findings: Finding[]; criteria: { id: number; description: string; verifyMethod: string | null; verdict: string | null; evidenceAt: string | null }[]; nextAction: string }`
  - `completeGoal(db, id, { force?: boolean; reason?: string })`
  - `satisfyCriteria(db, goalId)` test helper

- [ ] **Step 1: Write the failing tests** (`tests/converge.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable, makeStartable, satisfyCriteria } from './helpers.js';
import {
  createGoal, lockGoal, startGoal, completeGoal, getGoal, listRequirements, IncompleteCriteriaError,
  setRequirementStatus,
} from '../src/services/goals.js';
import { recordVerification } from '../src/services/verification.js';
import { convergeGoal } from '../src/services/converge.js';
import { updateWorkUnit } from '../src/services/work.js';
import { addFailure } from '../src/services/failures.js';
import { listDecisions } from '../src/services/decisions.js';

function started(db: ReturnType<typeof createTestDb>) {
  const g = createGoal(db, { title: 't', objective: 'o' });
  makeLockable(db, g.id); lockGoal(db, g.id);
  const wu = makeStartable(db, g.id); startGoal(db, g.id);
  const crit = listRequirements(db, g.id).find(r => r.requirementType === 'success_criterion')!;
  return { g, wu, crit };
}

describe('verdicts', () => {
  it('v1: verified needs actualResult and matching verificationType', () => {
    const db = createTestDb();
    const { g, crit } = started(db);
    expect(() => recordVerification(db, { goalId: g.id, requirementId: crit.id, passed: true }))
      .toThrow(/actualResult/);
    expect(() => recordVerification(db, { goalId: g.id, requirementId: crit.id, verdict: 'verified', actualResult: 'ok', verificationType: 'manual' }))
      .toThrow(/verify method "test"/);
    recordVerification(db, { goalId: g.id, requirementId: crit.id, verdict: 'partial', actualResult: 'half', verificationType: 'test' });
    expect(listRequirements(db, g.id).find(r => r.id === crit.id)!.status).toBe('PENDING');
  });

  it('v0 goals keep passed:true without evidence (review focus #5)', () => {
    const db = createTestDb();
    const { g, crit } = started(db);
    db.$client.prepare('UPDATE goals SET rules_version = 0 WHERE id = ?').run(g.id);
    const run = recordVerification(db, { goalId: g.id, requirementId: crit.id, passed: true });
    expect(run.verdict).toBe('verified');
    expect(completeGoal(db, g.id).status).toBe('COMPLETED');   // criterion #100
  });
});

describe('converge + complete gate (criterion #98)', () => {
  it('refuses on CRITICAL/HIGH, completes once converged, stores snapshot', () => {
    const db = createTestDb();
    const { g, wu, crit } = started(db);
    expect(convergeGoal(db, g.id).findings.map(f => f.id)).toEqual(
      expect.arrayContaining([`missing:req:${crit.id}`, `unfinished_work:wu:${wu.id}`]));
    expect(() => completeGoal(db, g.id)).toThrow(IncompleteCriteriaError);
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    satisfyCriteria(db, g.id);
    const rep = convergeGoal(db, g.id);
    expect(rep.converged).toBe(true);
    const done = completeGoal(db, g.id);
    expect(done.completionMode).toBe('normal');
    expect(JSON.parse(done.convergeSnapshot!).converged).toBe(true);
  });

  it('stale evidence after later work is HIGH', () => {
    const db = createTestDb();
    const { g, wu } = started(db);
    satisfyCriteria(db, g.id);
    db.$client.prepare(`UPDATE verification_runs SET created_at = '2020-01-01T00:00:00Z'`).run();
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    expect(convergeGoal(db, g.id).findings.some(f => f.kind === 'stale_evidence')).toBe(true);
  });

  it('open failure blocks completion', () => {
    const db = createTestDb();
    const { g, wu } = started(db);
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' }); satisfyCriteria(db, g.id);
    addFailure(db, { goalId: g.id, errorMessage: 'flaky' });
    expect(() => completeGoal(db, g.id)).toThrow(/Unresolved failure/);
  });

  it('force requires reason (v0 and v1); forced completion marked and decided', () => {
    const db = createTestDb();
    const { g } = started(db);
    expect(() => completeGoal(db, g.id, { force: true })).toThrow(/reason/);
    const done = completeGoal(db, g.id, { force: true, reason: 'superseded by GOAL-X' });
    expect(done.completionMode).toBe('forced');
    expect(done.convergeSnapshot).toBeTruthy();
    expect(listDecisions(db, { goalId: g.id }).some(d => d.riskLevel === 'MEDIUM' && d.reason?.includes('superseded'))).toBe(true);
  });

  it('NOT_APPLICABLE criterion produces no finding', () => {
    const db = createTestDb();
    const { g, wu, crit } = started(db);
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    setRequirementStatus(db, crit.id, 'NOT_APPLICABLE', 'dropped by user');
    expect(convergeGoal(db, g.id).converged).toBe(true);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/converge.test.ts`. Expected: FAIL.

- [ ] **Step 3: Edit `recordVerification` in `src/services/verification.ts`**

```ts
import { goals } from '../db/schema.js';
import { VERDICTS } from './contract-rules.js';

export function recordVerification(db: BrainDb, input: {
  passed?: boolean; verdict?: 'verified' | 'partial' | 'failed'; goalId?: string; workUnitId?: string; requirementId?: number;
  verificationType?: string; command?: string; expectedResult?: string; actualResult?: string;
}): VerificationRun {
  if (input.verdict === undefined && input.passed === undefined) throw new Error('Provide verdict (verified|partial|failed) or passed.');
  if (input.verdict !== undefined && !(VERDICTS as readonly string[]).includes(input.verdict)) {
    throw new Error(`Invalid verdict: ${input.verdict}`);
  }
  const verdict = input.verdict ?? (input.passed ? 'verified' : 'failed');
  let req: typeof goalRequirements.$inferSelect | undefined;
  if (input.requirementId !== undefined) {
    req = db.select().from(goalRequirements).where(eq(goalRequirements.id, input.requirementId)).get();
    if (!req) throw new Error(`Requirement not found: ${input.requirementId}`);
    if (input.goalId !== undefined && req.goalId !== input.goalId) {
      throw new Error(`Requirement ${input.requirementId} belongs to ${req.goalId}, not ${input.goalId}`);
    }
    const goal = db.select().from(goals).where(eq(goals.id, req.goalId)).get()!;
    if (goal.rulesVersion >= 1 && verdict === 'verified') {
      if (!input.actualResult?.trim()) {
        throw new Error(`A verified verdict needs actualResult (what was observed) — completion claims are not evidence.`);
      }
      if (req.verifyMethod && input.verificationType !== req.verifyMethod) {
        throw new Error(`Criterion #${req.id} is verified by verify method "${req.verifyMethod}"; got verificationType "${input.verificationType ?? ''}".`);
      }
    }
  }
  const res = db.insert(verificationRuns).values({
    passed: verdict === 'verified' ? 1 : 0, verdict, goalId: input.goalId ?? req?.goalId ?? null,
    workUnitId: input.workUnitId ?? null, requirementId: input.requirementId ?? null,
    verificationType: input.verificationType ?? null, command: input.command ?? null,
    expectedResult: input.expectedResult ?? null, actualResult: input.actualResult ?? null,
    createdAt: new Date().toISOString(),
  }).run();
  if (input.requirementId !== undefined) {
    setRequirementStatus(db, input.requirementId, verdict === 'verified' ? 'PASSED' : verdict === 'failed' ? 'FAILED' : 'PENDING');
  }
  touchGoal(db, input.goalId ?? req?.goalId);
  return db.select().from(verificationRuns).where(eq(verificationRuns.id, Number(res.lastInsertRowid))).get()!;
}
```

This replaces the Task 3 `touchGoal` line in this function.

- [ ] **Step 4: Create `src/services/converge.ts`.** It imports only schema plus `contract-rules`, and is imported by `goals.ts`, `resume.ts`, CLI and MCP.

```ts
import { and, eq, inArray } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import {
  failures, goalPrincipleAcks, goalProjects, goalRequirements, goals, knowledge,
  verificationRuns, workUnitRequirements, workUnits,
} from '../db/schema.js';
import {
  coverageFindings, evidenceFindings, isConverged, principleFindings, sortFindings, type Finding, type ReqRow,
} from './contract-rules.js';

export interface ConvergeReport {
  goalId: string; rulesVersion: number; converged: boolean; findings: Finding[];
  criteria: { id: number; description: string; verifyMethod: string | null; verdict: string | null; evidenceAt: string | null }[];
  nextAction: string;
}

/** Read-only: inventory the contract and judge the present evidence (spec-kit /converge). */
export function convergeGoal(db: BrainDb, goalId: string): ConvergeReport {
  const goal = db.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  const reqs: ReqRow[] = db.select().from(goalRequirements).where(eq(goalRequirements.goalId, goalId)).all()
    .map(r => ({ id: r.id, requirementType: r.requirementType, description: r.description, priority: r.priority,
      status: r.status, verifyMethod: r.verifyMethod, coverage: r.coverage }));
  const units = db.select().from(workUnits).where(eq(workUnits.goalId, goalId)).all();
  const links = units.length
    ? db.select().from(workUnitRequirements).where(inArray(workUnitRequirements.workUnitId, units.map(u => u.id))).all() : [];
  const runs = db.select().from(verificationRuns).where(eq(verificationRuns.goalId, goalId)).all();
  const open = db.select().from(failures).where(and(eq(failures.goalId, goalId), eq(failures.resolved, 0))).all();
  const scopes = db.select().from(goalProjects).where(eq(goalProjects.goalId, goalId)).all().map(r => `project:${r.projectId}`);
  const principles = db.select().from(knowledge)
    .where(and(eq(knowledge.category, 'principle'), eq(knowledge.status, 'active'))).all()
    .filter(k => k.scopeType === 'GLOBAL' || (k.scopeType === 'PROJECT' && scopes.includes(k.scopeId ?? '')));
  const acks = db.select().from(goalPrincipleAcks).where(eq(goalPrincipleAcks.goalId, goalId)).all();

  const findings = sortFindings([
    ...evidenceFindings(reqs, runs, units, open),
    ...coverageFindings(reqs, units, links).filter(f => f.kind === 'unrequested'),
    ...principleFindings(principles, acks, 'converge'),
  ]);
  const criteria = reqs.filter(r => r.requirementType === 'success_criterion').map(r => {
    const last = runs.filter(x => x.requirementId === r.id && x.verdict)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).at(-1);
    return { id: r.id, description: r.description, verifyMethod: r.verifyMethod, verdict: last?.verdict ?? null, evidenceAt: last?.createdAt ?? null };
  });
  const converged = isConverged(findings);
  const top = findings[0];
  const nextAction = converged
    ? 'Converged — complete the goal'
    : `fix ${top!.severity} ${top!.id} — ${top!.message}`;
  return { goalId, rulesVersion: goal.rulesVersion, converged, findings, criteria, nextAction };
}
```

- [ ] **Step 5: Edit `completeGoal` in `src/services/goals.ts`**

```ts
import { convergeGoal } from './converge.js';

export function completeGoal(db: BrainDb, id: string, opts: { force?: boolean; reason?: string } = {}): Goal {
  const g = getGoal(db, id);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot complete.`);
  if (opts.force && !opts.reason?.trim()) throw new Error('Force-completing requires a reason (recorded as a decision).');
  const report = convergeGoal(db, id);
  const snapshot = JSON.stringify(report);
  if (opts.force) {
    addDecision(db, {
      goalId: id, decision: `Force-completed ${id}`, riskLevel: 'MEDIUM', reversible: true,
      reason: `${opts.reason!.trim()} | open findings: ${report.findings.map(f => f.id).join(', ') || 'none'}`,
    });
    return setStatus(db, id, 'COMPLETED', { completedAt: now(), completionMode: 'forced', convergeSnapshot: snapshot });
  }
  if (g.rulesVersion >= 1) {
    const blocking = report.findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH');
    if (blocking.length > 0) {
      throw new IncompleteCriteriaError(`Cannot complete ${id}; not converged (§64): ` +
        blocking.map(f => `[${f.severity}] ${f.message}`).join('; '));
    }
  } else {
    const unmet = listRequirements(db, id).filter(r =>
      r.requirementType === 'success_criterion' && r.priority === 'required' &&
      !['PASSED', 'NOT_APPLICABLE'].includes(r.status));
    if (unmet.length > 0) {
      throw new IncompleteCriteriaError(
        `Cannot complete ${id}; unmet required success criteria (§64): ` +
        unmet.map(r => `#${r.id} ${r.description} [${r.status}]`).join('; '));
    }
  }
  return setStatus(db, id, 'COMPLETED', { completedAt: now(), completionMode: 'normal', convergeSnapshot: snapshot });
}
```

There's no cycle: `converge.ts` imports schema only.

- [ ] **Step 6: Add to `tests/helpers.ts`**

```ts
import { recordVerification } from '../src/services/verification.js';

/** Record a verified, method-matched run for every required criterion. */
export function satisfyCriteria(db: BrainDb, goalId: string): void {
  for (const r of listRequirements(db, goalId)) {
    if (r.requirementType !== 'success_criterion' || r.priority !== 'required') continue;
    recordVerification(db, { goalId, requirementId: r.id, verdict: 'verified',
      verificationType: r.verifyMethod ?? undefined, actualResult: 'observed in test' });
  }
}
```

- [ ] **Step 7:** Run `npx vitest run tests/converge.test.ts`, then `npm test`. Fix older tests as follows:
  - Where a test sets `PASSED` via `setRequirementStatus` and then calls `completeGoal` on a v1 goal, use `satisfyCriteria` plus `updateWorkUnit(…COMPLETED)` instead.
  - Where a test uses `completeGoal(…, { force: true })`, add `reason: 'test'`.
  - Where a test records `passed: true` on a v1 goal, add `actualResult` and a `verificationType` matching the criterion.

  Expected: all PASS.

- [ ] **Step 8: Commit** (`feat: evidence verdicts, converge report, converge-gated completion`).

---

### Task 8: Failure verdicts and resolve reason

**Files:**
- Modify: `src/services/failures.ts` (`addSolution`, `resolveFailure`)
- Test: `tests/failure-verdict.test.ts`

**Interfaces:**
- Produces:
  - `addSolution(db, failureId, { solution: string; successful?: boolean; verdict?: 'verified'|'partial'|'failed'; reproduction?: string }): FailureSolution & { resolved: boolean; note?: string }`
  - `resolveFailure(db, id: number, reason: string): Failure`

- [ ] **Step 1: Write the failing tests** (`tests/failure-verdict.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { addFailure, addSolution, getFailure, resolveFailure } from '../src/services/failures.js';

describe('failure resolution (criterion #101)', () => {
  it('verified + reproduction resolves', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    const s = addSolution(db, f.id, { solution: 'raise timeout', verdict: 'verified', reproduction: 're-ran the original call; 200 in 3s' });
    expect(s.resolved).toBe(true);
    expect(getFailure(db, f.id).resolved).toBe(1);
  });
  it('verified without reproduction does not resolve', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    expect(addSolution(db, f.id, { solution: 'x', verdict: 'verified' }).resolved).toBe(false);
    expect(getFailure(db, f.id).resolved).toBe(0);
  });
  it('legacy successful:true without reproduction is stored partial, not resolved', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    const s = addSolution(db, f.id, { solution: 'x', successful: true });
    expect(s.verdict).toBe('partial');
    expect(s.resolved).toBe(false);
    expect(s.note).toMatch(/reproduction/);
  });
  it('legacy successful:true with reproduction resolves', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    expect(addSolution(db, f.id, { solution: 'x', successful: true, reproduction: 'symptom gone' }).resolved).toBe(true);
  });
  it('resolveFailure requires a reason and stores it', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'timeout' });
    expect(() => resolveFailure(db, f.id, '')).toThrow(/reason/);
    expect(resolveFailure(db, f.id, 'environment gone').resolutionNote).toBe('environment gone');
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/failure-verdict.test.ts`. Expected: FAIL.

- [ ] **Step 3: Edit `src/services/failures.ts`**

```ts
import { observations } from '../db/schema.js';
import { touchGoal } from './activity.js';
import { VERDICTS } from './contract-rules.js';

export function resolveFailure(db: BrainDb, id: number, reason: string): Failure {
  const f = getFailure(db, id);
  if (!reason?.trim()) throw new Error('Resolving a failure directly requires a reason.');
  db.update(failures).set({ resolved: 1, resolvedAt: now(), resolutionNote: reason.trim() }).where(eq(failures.id, id)).run();
  db.insert(observations).values({
    goalId: f.goalId, scopeType: f.goalId ? 'GOAL' : 'GLOBAL', scopeId: f.goalId ? `goal:${f.goalId}` : null,
    observation: `Failure #${id} resolved: ${reason.trim()}`, createdAt: now(),
  }).run();
  touchGoal(db, f.goalId);
  return db.select().from(failures).where(eq(failures.id, id)).get()!;
}

export function addSolution(db: BrainDb, failureId: number, input: {
  solution: string; successful?: boolean; verdict?: 'verified' | 'partial' | 'failed'; reproduction?: string;
}): FailureSolution & { resolved: boolean; note?: string } {
  const f = getFailure(db, failureId);
  if (input.verdict !== undefined && !(VERDICTS as readonly string[]).includes(input.verdict)) {
    throw new Error(`Invalid verdict: ${input.verdict}`);
  }
  const reproduction = input.reproduction?.trim() || null;
  let verdict = input.verdict ?? (input.successful === undefined ? null : input.successful ? 'verified' : 'failed');
  let note: string | undefined;
  if (verdict === 'verified' && !reproduction) {
    if (input.verdict === undefined) verdict = 'partial';   // legacy successful:true
    note = 'Not resolved: re-run the original reproduction and pass `reproduction` (tests alone are partial).';
  }
  const resolved = verdict === 'verified' && !!reproduction;
  const res = db.insert(failureSolutions).values({
    failureId, solution: input.solution, successful: resolved ? 1 : 0, verdict, reproduction, createdAt: now(),
  }).run();
  if (resolved) db.update(failures).set({ resolved: 1, resolvedAt: now() }).where(eq(failures.id, failureId)).run();
  touchGoal(db, f.goalId);
  const row = db.select().from(failureSolutions).where(eq(failureSolutions.id, Number(res.lastInsertRowid))).get()!;
  return { ...row, resolved, ...(note ? { note } : {}) };
}
```

Remove the Task 3 `touchGoal` line in `addSolution` if it was placed differently; there should be exactly one call.

- [ ] **Step 4:** Run `npx vitest run tests/failure-verdict.test.ts`, then `npm test`. Update `tests/failures.test.ts` and `tests/cli.test.ts` (`failure solution … --successful`) to pass a reproduction where they expect resolution, and update any `resolveFailure(db, id)` call to pass a reason. Expected: all PASS.

- [ ] **Step 5: Commit** (`feat: reproduction-backed failure resolution`).

---

### Task 9: Resume and context integration

**Files:**
- Modify: `src/services/resume.ts`, `src/services/context.ts`
- Test: `tests/resume-converge.test.ts`

**Interfaces:**
- Consumes: `convergeGoal` (Task 7), `staleGoals` (Task 3)
- Produces:
  - `ResumeState.converge: ConvergeReport | null`, non-null for EXECUTING/VERIFYING/BLOCKED
  - `BrainContext.staleGoals: { id: string; title: string; updatedAt: string }[]`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable, makeStartable } from './helpers.js';
import { createGoal, lockGoal, startGoal } from '../src/services/goals.js';
import { resumeGoal } from '../src/services/resume.js';
import { getContext } from '../src/services/context.js';

describe('resume + context integration', () => {
  it('resume embeds converge and recommends the top finding', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id); lockGoal(db, g.id); makeStartable(db, g.id); startGoal(db, g.id);
    const r = resumeGoal(db, g.id);
    expect(r.converge?.converged).toBe(false);
    expect(r.nextRecommendedAction).toMatch(/^fix (CRITICAL|HIGH) /);
  });
  it('context lists stale goals', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'old', objective: 'o' });
    db.$client.prepare(`UPDATE goals SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?`).run(g.id);
    expect(getContext(db).staleGoals.map(s => s.id)).toEqual([g.id]);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/resume-converge.test.ts`. Expected: FAIL.

- [ ] **Step 3: Edit `src/services/resume.ts`**
  - Import `convergeGoal` and `ConvergeReport` from `./converge.js`.
  - Add `converge: ConvergeReport | null` to `ResumeState`.
  - In `resumeGoal`:
    ```ts
    const converge = ['EXECUTING', 'VERIFYING', 'BLOCKED'].includes(goal.status) ? convergeGoal(db, id) : null;
    ```
    Return it.
  - In `recommend`, for the default (executing) branch: if `converge && !converge.converged && ready.length === 0`, return `converge.nextAction`. If `converge?.converged`, return `'Converged — complete the goal (brain goal complete ' + goal.id + ')'`. Otherwise keep "Work on …" when ready work exists.
  - Pass `converge` into `recommend`, extending its parameters.

- [ ] **Step 4: Edit `src/services/context.ts`**
  - Import `staleGoals` from `./goals.js`.
  - Add to `BrainContext` and to the returned object:
    ```ts
    staleGoals: staleGoals(db).map(g => ({ id: g.id, title: g.title, updatedAt: g.updatedAt })),
    ```
  - Wrap this in the same pending-migration tolerance used for `openMaterialQuestions`: on error, if `pendingMigrations(db) > 0` use `[]`, else rethrow.
  - Find where the CLI renders `context get` (`src/cli/index.ts`). If it prints JSON, nothing more is needed. If it prints text, add the line `${n} stale goals: ${ids} — complete, cancel or resume` when n > 0.

- [ ] **Step 5:** Run `npx vitest run tests/resume-converge.test.ts`, then `npm test`. Update `tests/resume.test.ts` recommendations that changed. Expected: all PASS.

- [ ] **Step 6: Commit** (`feat: resume shows converge, context lists stale goals`).

---

### Task 10: CLI and MCP surface

**Files:**
- Modify: `src/cli/index.ts`, `src/mcp/server.ts`
- Test: `tests/cli.test.ts`, `tests/mcp.test.ts` (append)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - MCP tools `brain_goal_converge`, `brain_goal_cancel`, `brain_goal_link_project`, `brain_principle_ack`
  - CLI `goal converge <id>`, `goal cancel <id> <reason>`, `goal link-project <goalId> <project>`, `principle ack <goalId> <knowledgeId> <mode> <note>`
  - Extended params as listed below

- [ ] **Step 1: Write the failing tests** (append to `tests/mcp.test.ts`, reusing its client setup)

```ts
it('lifecycle-gap tools', async () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { err: !!r.isError, body: r.isError ? r.content[0]!.text : JSON.parse(r.content[0]!.text) };
  };
  const g = (await call('brain_goal_create', { title: 't', objective: 'o', riskLevel: 'LOW' })).body;
  await call('brain_requirement_add', { goalId: g.id, type: 'scope', description: 's' });
  const c = (await call('brain_requirement_add', { goalId: g.id, type: 'success_criterion', description: 'x works', verifyMethod: 'test', coverage: 'completion' })).body;
  expect((await call('brain_goal_lock', { id: g.id })).err).toBe(false);
  expect((await call('brain_goal_start', { id: g.id })).body).toMatch(/plan does not cover/);
  const wu = (await call('brain_work_create', { goalId: g.id, title: 'impl', serves: [c.id] })).body;
  expect((await call('brain_goal_start', { id: g.id })).err).toBe(false);
  expect((await call('brain_goal_converge', { id: g.id })).body.converged).toBe(false);
  await call('brain_work_update', { id: wu.id, status: 'COMPLETED' });
  await call('brain_verification_record', { goalId: g.id, requirementId: c.id, verdict: 'verified', verificationType: 'test', actualResult: 'green' });
  expect((await call('brain_goal_complete', { id: g.id })).body.completionMode).toBe('normal');
  const g2 = (await call('brain_goal_create', { title: 'u', objective: 'o' })).body;
  expect((await call('brain_goal_cancel', { id: g2.id, reason: 'dup' })).body.status).toBe('CANCELLED');
  const f = (await call('brain_failure_record', { errorMessage: 'boom' })).body;
  expect((await call('brain_failure_resolve', { id: f.id })).err).toBe(true);
  expect((await call('brain_failure_solution_add', { failureId: f.id, solution: 's', verdict: 'verified', reproduction: 'gone' })).body.resolved).toBe(true);
});
```

Check the exact names of the existing MCP tools for goal create, work update and failure record against `src/mcp/server.ts`, and fix them in this test before running it if they differ.

- [ ] **Step 2:** Run `npx vitest run tests/mcp.test.ts`. Expected: FAIL.

- [ ] **Step 3: Edit `src/mcp/server.ts`**
  - Imports: `import { convergeGoal } from '../services/converge.js'; import * as principles from '../services/principles.js';`
  - `brain_requirement_add`: add `verifyMethod: z.enum(['test','command','api','inspection','manual']).optional(), coverage: z.enum(['behaviour','data','failure_modes','edge_cases','non_functional','integration','completion']).optional()`, passed through to `addRequirement`. New description: `'Add a requirement to an unlocked goal. Success criteria must be ONE claim each and carry verifyMethod; tag contract lines with coverage'`.
  - `brain_question_add`: add `recommended: z.string().optional()`. New description: `'Add a clarification question (max 5 material session questions per goal; give a recommended answer)'`.
  - `brain_verification_record`: `passed: z.boolean().optional(), verdict: z.enum(['verified','partial','failed']).optional()`. New description: `'Record evidence for a criterion. verdict verified needs actualResult and verificationType = the criterion verifyMethod; partial never counts as pass'`.
  - `brain_work_create`: add `serves: z.array(z.number()).optional()`. New description: `'Create a work unit; serves = requirement ids it delivers (every required criterion must be served before goal start)'`.
  - `brain_goal_complete`: add `reason: z.string().optional()`, pass `{ force: a.force, reason: a.reason }`. New description: `'Complete a goal; v1 goals must converge (no CRITICAL/HIGH findings). force needs reason'`.
  - `brain_failure_solution_add`: add `verdict` (same enum), `reproduction: z.string().optional()`. New description: `'Attach a solution; resolves only with verdict verified + reproduction (how the original symptom was re-checked)'`.
  - `brain_failure_resolve`: `{ id: z.number(), reason: z.string() }` → `fail.resolveFailure(db, a.id, a.reason)`.
  - New tools:
    ```ts
      tool('brain_goal_converge', 'Converge report: typed findings (missing/partial/contradicts/stale/unfinished/open failure) for a goal; read-only', {
        id: z.string(),
      }, (a) => convergeGoal(db, a.id));
      tool('brain_goal_cancel', 'Cancel an open goal (reason required)', { id: z.string(), reason: z.string() },
        (a) => goals.cancelGoal(db, a.id, a.reason));
      tool('brain_goal_link_project', 'Link a goal to a project (its principles then apply)', {
        goalId: z.string(), project: z.string(),
      }, (a) => principles.linkGoalProject(db, a.goalId, a.project));
      tool('brain_principle_ack', 'Acknowledge an applicable principle before lock: honoured (how) or exception (why; records a decision)', {
        goalId: z.string(), knowledgeId: z.number(), mode: z.enum(['honoured', 'exception']), note: z.string(),
      }, (a) => principles.ackPrinciple(db, a));
    ```

- [ ] **Step 4: Edit `src/cli/index.ts`**, mirroring the MCP changes and following the existing `run(() => out(...))` style:
  - `requirement add`: `.option('--verify <method>').option('--coverage <category>')`, passed as `verifyMethod: o.verify, coverage: o.coverage`.
  - `question add`: `.option('--recommended <answer>')`.
  - `verify` / `verification record` (whatever the existing command is): `.option('--verdict <verdict>')`.
  - `work create`: `.option('--serves <ids>', 'comma-separated requirement ids')`, parsed with `o.serves?.split(',').map(Number)`.
  - `goal complete`: `.option('--reason <text>')`.
  - `failure solution`: `.option('--verdict <v>').option('--reproduction <text>')`.
  - `failure resolve <id> <reason>`.
  - New commands:
    ```ts
    goal.command('converge <id>').description('Converge report: findings blocking completion')
      .action((id) => run(() => out(convergeGoal(db(), id))));
    goal.command('cancel <id> <reason>').action((id, reason) => run(() => out(goals.cancelGoal(db(), id, reason))));
    goal.command('link-project <goalId> <project>')
      .action((goalId, project) => run(() => out(principles.linkGoalProject(db(), goalId, project))));
    const principle = program.command('principle');
    principle.command('ack <goalId> <knowledgeId> <mode> <note>')
      .action((goalId, k, mode, note) => run(() => out(principles.ackPrinciple(db(), { goalId, knowledgeId: Number(k), mode, note }))));
    ```

- [ ] **Step 5:** Run `npm test`. Append one CLI test to `tests/cli.test.ts` that runs `goal converge` and `goal cancel` via its existing `brain(...)` helper and checks the JSON output (`converged` key; `status: 'CANCELLED'`). Expected: all PASS.

- [ ] **Step 6: Commit** (`feat: CLI and MCP surface for converge, cancel, principles, verdicts`).

---

### Task 11: Docs, live-DB migration check, final verification

**Files:**
- Modify: `ARCHITECTURE.md` (§19, §35, §63, §64, §72, plus a new "Rules versions" subsection after §64), `README.md` (command surface), repo `CLAUDE.md` §18 (verification: verdicts and converge) and §19 (completion: converge gate)
- Create: `scripts/check-migration-on-copy.ts`

- [ ] **Step 1: Write `scripts/check-migration-on-copy.ts`**

```ts
// Usage: npx tsx scripts/check-migration-on-copy.ts [path-to-brain.db]
// Copies the DB to a temp dir, migrates the COPY, and asserts goals are unchanged and grandfathered.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, migrateDb } from '../src/db/connection.js';

const src = process.argv[2] ?? path.join(os.homedir(), '.central-brain', 'brain.db');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-copy-'));
const copy = path.join(dir, 'brain.db');
new Database(src, { readonly: true }).backup(copy).then(() => {
  const before = new Database(copy).prepare('SELECT id, status FROM goals ORDER BY id').all() as { id: string; status: string }[];
  const db = openDb(copy); migrateDb(db);
  const after = db.$client.prepare('SELECT id, status, rules_version FROM goals ORDER BY id').all() as { id: string; status: string; rules_version: number }[];
  const ok = after.length === before.length
    && after.every((g, i) => g.id === before[i]!.id && g.status === before[i]!.status && g.rules_version === 0);
  console.log(JSON.stringify({ copy, goals: after.length, unchanged: ok }));
  process.exit(ok ? 0 : 1);
});
```

`backup()` is better-sqlite3's online-backup API, so it's safe against the live WAL DB and never writes to `src`.

- [ ] **Step 2:** Run `npx tsx scripts/check-migration-on-copy.ts`. Expected: `{"copy":"…","goals":N,"unchanged":true}`, exit 0. Then run `sqlite3 ~/.central-brain/brain.db "PRAGMA table_info(goals)" | grep -c rules_version`. Expected: `0`, which proves the live DB was not touched.

- [ ] **Step 3:** Update the docs. Keep each amendment short and factual, matching the style of the surrounding sections:
  - **§19:** `verify_method`, `coverage`
  - **§35:** verdicts
  - **§63 and §64:** converge findings and gates, force + reason, `completion_mode`
  - **§72:** resume shows converge
  - **Rules versions:** v0 grandfathered at migration, v1 set at lock
  - **README:** new and changed commands

- [ ] **Step 4:** Run `npm test && npx tsc --noEmit && npm run build`. Expected: all green, 0 type errors, and `dist/` built.

- [ ] **Step 5: Commit** (`docs: lifecycle gap gates, rules versions, migration copy check`).

- [ ] **Step 6: Brain bookkeeping.**
  - For each GOAL-2026-0031 success criterion, run `brain_verification_record` with `verdict` and the real command output:
    - #97–#102 → the named test file passing
    - #103 → the Step 2 JSON
    - #104 → the Step 4 output
  - Record the learning: "Brain rules v1: criteria must be atomic + verifyMethod; complete needs converge; failures need reproduction."
  - Tell the user two things:
    - **Run `brain migrate` to apply the migration to the live DB.** It's their step.
    - **Proposed wording for `~/.claude/CLAUDE.md`,** which is outside this repo: "`successful:true` also resolves" becomes "resolve with `verdict: verified` + `reproduction`; tests alone are partial". Add the converge step to "Finish".
  - Merging to `main` and pushing need the user's explicit OK.

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Task(s) |
  |---|---|
  | §3 schema | 1 |
  | §4.1 | 2, 4 |
  | §4.2 | 2, 5 |
  | §4.3 | 5 |
  | §4.4 | 2, 4 |
  | §4.5 | 2, 6 |
  | §4.6 | 2, 7 |
  | §5 lock | 4 |
  | §5 start | 6 |
  | §5 complete and force | 7 |
  | §5 failure_resolve | 8 |
  | §5 verification | 7 |
  | §5 failure solutions | 8 |
  | §6 hygiene | 3, 9 |
  | §7 converge | 7, 9, 10 |
  | §8 surface | 10 |
  | §9 docs | 11 |
  | §11 migration safety | 0, 1, 11 |
  | §12 testing | each task + 11 |

- **Cycle check:**
  - `activity.ts` and `converge.ts` import schema only, plus `contract-rules.ts`, which is pure.
  - `goals.ts` imports `activity`, `converge`, `contract-rules` and `decisions`. `decisions` imports `activity`, not `goals`.
  - `principles.ts`, `work.ts`, `verification.ts`, `failures.ts`, `intake.ts` and `resume.ts` may import `goals.ts`. `goals.ts` imports none of them.
- **Names used across tasks:** `toReqRow`, `makeStartable`, `satisfyCriteria`, `workUnitLinks`, `convergeGoal`, `ConvergeReport`, `cancelGoal`, `staleGoals`, `touchGoal`, `ackPrinciple`, `linkGoalProject`, `applicablePrinciples`, `listPrincipleAcks`, `goalProjectIds`.

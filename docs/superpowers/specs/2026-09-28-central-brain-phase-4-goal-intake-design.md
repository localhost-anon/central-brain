# Central Brain Phase 4 — Autonomous Goal Intake (Design)

**Goal:** GOAL-2026-0004 · **Spec authority:** `ARCHITECTURE.md` v0.2 §8 (Goal Intake), §9 (Goal Contract), §12 (risk levels), §20 (goal_questions), §80 (Phase 4) · **Date:** 2026-09-28

## 1. Outcome

A calling Claude session can take a user request to a locked, complete Goal Contract entirely through Brain operations:
context is resolved before questions are asked, ambiguity is recorded and batched, and `goal lock` refuses an incomplete contract.

Success means:
- An intake report surfaces related memory, contract gaps, review items and duplicate requirements for any goal.
- Material questions are stored, answered (optionally becoming contract lines) or dismissed, and block locking while open.
- `goal lock` enforces the §9 minimum contract; `--force` overrides only with a recorded reason.
- Starting a Claude session never migrates the live DB.

## 2. Decisions taken during design

| Decision | Choice |
|---|---|
| Who detects ambiguity | Brain runs deterministic checks (no LLM in Brain); the calling session adds judgment questions. Brain stores, batches, gates. |
| Lock gate strictness | Block with the gap list; `--force --reason` overrides and records a MEDIUM decision. |
| Shape | Approach A: re-runnable intake **report** + discrete commands. No intake state machine; the existing DRAFT → LOCKED lifecycle is the state. |

## 3. Data model

**`goal_questions`** (exists, §20, unused). One additive migration adds:

| Column | Type | Meaning |
|---|---|---|
| `materiality` | text not null default `'material'` | `material` blocks lock; `detail` is logged only, never asked |
| `source` | text not null default `'session'` | `brain` (deterministic check) or `session` (calling Claude) |
| `check_key` | text null | Brain questions only, e.g. `missing:scope`; unique per goal among non-null values → idempotent upsert |
| `requirement_id` | integer null | requirement created from the answer (`--as`) |
| `status_reason` | text null | reason for dismissal |

`status`: `pending` | `answered` | `dismissed`.

**`goal_requirements.requirement_type`** whitelist gains `scope` and `permission` (existing: objective, constraint, success_criterion, exclusion, assumption). No schema change.

**`goals.risk_level`** (exists) becomes a contract field. Allowed values: `LOW`, `MEDIUM`, `HIGH`, `IRREVERSIBLE` (§12).

**Lock-required contract:** non-empty objective; ≥1 `success_criterion` with priority `required`; ≥1 `scope`; `risk_level` set; zero `pending` questions with `materiality='material'`.
Optional: constraint, exclusion, assumption, permission.

**`clarification_status`** is maintained: `pending` while any material question is pending, `complete` when none. Updated on question add/answer/dismiss and on intake; no longer forced at lock.

**`contract_snapshot`** additionally freezes `riskLevel`, `autonomyLevel`, and answered questions (`question`, `answer`).

## 4. Checker

Two units so the lock path stays synchronous and model-free.

### 4.1 `checkContract(db, goalId)` — sync, deterministic
Returns `{ ready: boolean; gaps: Gap[]; openQuestions: GoalQuestion[] }` where `Gap = { field: 'objective' | 'success_criterion' | 'scope' | 'risk_level'; message: string }`.
`ready` = no gaps and no open material questions. Shared by `goal lock` and the intake report.

### 4.2 `buildIntakeReport(db, embedder, goalId)` — async
1. **Gap questions.** For each gap, upsert a material, `source='brain'` question keyed `missing:<field>` with a fixed template:
   - objective → "What outcome must be true when this goal is done?"
   - success_criterion → "How will we verify the goal is complete (required success criteria)?"
   - scope → "What is in scope, and which systems may change?"
   - risk_level → "What is the risk level (LOW, MEDIUM, HIGH, IRREVERSIBLE)?"
   A pending `missing:<field>` question whose gap no longer exists is auto-answered with `answer = 'filled via contract'`.
2. **Related context.** `hybridSearch(title + ': ' + objective)` grouped by type (decision, failure, learning, knowledge, goal, observation), top 5 per type, excluding the goal itself.
3. **Review items** (surfaced, never auto-asked):
   - `overlapping_goal`: other goals with status not in COMPLETED/CANCELLED/FAILED whose semantic score passes the embedder's similarity floor.
   - `related_decision`: decisions in related context.
   - `user_preference`: knowledge in related context whose category is `preference` (or statement starts with `User preference`).
   Shape `{ kind, ref, text, score }`.
4. **Duplicate requirements.** Pairs within the goal's requirements that are equal after normalisation (lowercase, collapse whitespace, strip trailing punctuation) → reason `exact`; or cosine ≥ 0.90 under the embedder → reason `semantic`.
5. **`nextAction`** — one line, first applicable: "answer N material question(s) — ask them in one batch" / "fill: <fields>" / "resolve N duplicate requirement pair(s)" / "ready to lock".

Report:
```ts
interface IntakeReport {
  goal: Goal; ready: boolean; gaps: Gap[]; openQuestions: GoalQuestion[];
  context: Record<'decision'|'failure'|'learning'|'knowledge'|'goal'|'observation', SearchResult[]>;
  reviewItems: { kind: 'overlapping_goal'|'related_decision'|'user_preference'; ref: string; text: string; score: number }[];
  duplicates: { a: number; b: number; reason: 'exact'|'semantic' }[];
  semanticUnavailable: boolean; nextAction: string;
}
```

**Error handling.**
- Locked or terminal goal: report computed read-only; no question upserts.
- Embedder failure: FTS-only context, exact duplicates only, no overlapping-goal items, `semanticUnavailable: true`. Never throws for that reason.
- Unknown goal id: throws (existing `getGoal` behaviour).

## 5. Commands

| CLI | MCP | Behaviour |
|---|---|---|
| `goal intake <id>` | `brain_goal_intake {id}` | intake report (async, may init the embedder) |
| `goal set <id> [--risk L] [--autonomy A]` | `brain_goal_set {id, risk?, autonomy?}` | set contract fields on an unlocked goal; validates risk values |
| `goal question add <goalId> <text> [--detail]` | `brain_question_add {goalId, question, detail?}` | `source='session'` |
| `goal question answer <qid> <answer> [--as T]` | `brain_question_answer {id, answer, as?}` | `--as` ∈ constraint, exclusion, assumption, scope, permission, success_criterion → also adds requirement (priority required) and links it |
| `goal question dismiss <qid> <reason>` | `brain_question_dismiss {id, reason}` | status `dismissed` |
| `goal question list <goalId> [--open]` | `brain_question_list {goalId, open?}` | |
| `goal lock <id> [--force --reason R]` | `brain_goal_lock {id, force?, reason?}` | refuses with gaps + open questions unless ready; `--force` requires `--reason`; records decision (riskLevel MEDIUM, goalId) |
| `migrate` | — | snapshot, then apply pending migrations; prints applied count |

`requirement add` accepts `scope` and `permission`. Question commands reject unlocked-only operations on locked/terminal goals (no add/answer/dismiss after lock). MCP tool count: 42 → 48.

**Integrations.**
- `goal resume` recommendation: DRAFT with open material questions → "answer N question(s) in one batch"; DRAFT and `checkContract` ready → "lock the goal"; DRAFT otherwise → "run goal intake".
- `context get`: adds `openMaterialQuestions: number` for the resolved goal (DB count only; no checker, no embedder).

## 6. Migration guard

Today `openDb` + `migrateDb` run on every CLI command and at MCP server start, so a migration committed on a branch reaches the live DB at the next session start (Phase 3 learning #5).

- **Passive paths do not migrate:** `context get` (the SessionStart hook) and MCP server startup. They check pending migrations (journal count vs `__drizzle_migrations` count). If pending, `context get` includes `schemaPending: true` and a one-line notice "Brain schema update pending — run `brain migrate`"; the MCP server starts, and tools that fail on missing schema return that notice as the error.
- **`brain migrate`** is the explicit upgrade (snapshot + migrate).
- Other CLI commands keep auto-migrate-with-snapshot (deliberate use of the live DB).
- Tests use temp DBs and are unaffected.

## 7. Out of scope

- LLM calls from Brain; automatic contradiction judgment (review items stay with the session).
- Parsing a free-text request into a goal (§8 "Parse Intent" stays with the session, then `goal create`).
- Work-unit planning (Phase 5).
- Backfilling or re-gating already locked/completed goals.

## 8. Testing & verification

- **Unit:** `checkContract` (each gap, ready); question lifecycle (add → answer `--as` creates linked requirement → dismiss; `clarification_status` tracking; post-lock rejection); lock gate (refuse listing gaps, `--force` without reason rejected, `--force --reason` locks + records decision; snapshot contains risk/autonomy/answers); `buildIntakeReport` with `fakeEmbedder` (gap-question upsert idempotent across runs, filled gap auto-answers its question, exact + semantic duplicates, overlapping-goal item, `semanticUnavailable` fallback with a throwing embedder, read-only on locked goals); `goal set` risk validation; resume recommendations.
- **Guard:** file DB with a pending migration opened via the passive `context get` path stays unmigrated and reports `schemaPending`; `brain migrate` applies it with a snapshot.
- **E2E:** CLI create → intake → question answer `--as` → set risk → intake ready → lock on a temp DB; MCP tool surface lists 48 tools including the six new ones.
- **Live dogfood (final task):** run `brain migrate` on the live DB, then the full intake flow on GOAL-2026-0004 itself before locking it; its outputs are verification evidence. Suite green, tsc clean, build clean.

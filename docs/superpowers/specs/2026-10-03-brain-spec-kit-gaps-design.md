# Central Brain — Closing Lifecycle Gaps Found via spec-kit (Design)

**Goal:** GOAL-2026-0031 · **Spec authority:** `ARCHITECTURE.md` v0.2 §8–§9 (intake/contract), §19 (requirements), §22–§23 (work units), §31–§32 (failures), §35 (verification runs), §63–§64 (verification/completion), §72 (resume) · **Date:** 2026-10-03

## 1. Outcome

GitHub's spec-kit (spec-driven development) was used as a mirror, not adopted. Its lifecycle (constitution → specify → clarify → plan → tasks → analyze → implement → converge, plus bug verdicts) was compared with Brain and with Brain's real usage (29 goals in `~/.central-brain/brain.db`). Gaps found:

| Observed in Brain data | Gap | spec-kit idea borrowed |
|---|---|---|
| Every recent goal has exactly 1 success criterion holding "(1)… (2)… (3)…" | Per-criterion verification impossible; verifications logged as `partial (criteria 1-3)` | Atomic, measurable SC-### |
| `verification_type` free text, 30+ spellings; `passed` boolean only | Evidence not comparable; "partial" silently counts or doesn't | Bug-test verdict `verified/partial/failed`; "completion claims are not evidence" |
| Completion checks only requirement status flags | No check of evidence freshness, unfinished work, open failures | `/converge` typed gaps + severity, loop until converged |
| 0 work units in the last ~10 goals | Plan phase unused; no trace from work to criteria | `/tasks` traceability + `/analyze` coverage gaps |
| Intake asks 4 gap questions + behaviour | Edge cases, failure modes, non-functional never examined | `/clarify` coverage taxonomy, ≤5 questions with recommended answers |
| No project rules | Each session re-derives "sandbox first", "no secrets" etc. | Constitution + plan "Constitution Check" gate |
| 7 EXECUTING / 2 DRAFT goals idle up to 5 days; `goal_current` returns them | No close-out hygiene; current-goal pointer drifts | (Brain-specific) |
| `failure_solution_add successful:true` resolves on a claim | Fixes "verified" by tests alone | Bug-test rule: verified only if the reproduction no longer reproduces |

After this goal, Brain **enforces in code**:
- atomic criteria with a verify method at lock
- typed evidence and a converge gate at completion
- criterion coverage by work units at start
- per-project principles acknowledged at lock
- stale-goal hygiene
- reproduction-backed failure resolution

Goals locked before the upgrade are grandfathered.

## 2. Decisions taken during design

| Decision | Choice |
|---|---|
| Strictness | Hard gates in code (lock / start / complete / failure resolve), not nudges |
| Shape | Approach 1: extend services in place; one shared pure module `contract-rules.ts` used by every gate and by the converge report (same single-definition pattern as `openMaterialQuestions`). Rejected: spec-kit-mirrored FR/SC schema (2× surface, poor fit for non-coding goals); hook enforcement (bypassable) |
| Migration of in-flight goals | Grandfather: `goals.rules_version` 0 for every goal locked before the upgrade; set to 1 at lock afterwards. Unlocked DRAFT goals get v1 when they lock |
| Override | `--force` everywhere requires `reason`; recorded as a MEDIUM decision; forced completion permanently marked `completion_mode = 'forced'` |
| Failure rule | **Not** grandfathered: from the upgrade, resolving any failure needs a `verified` solution with a reproduction note |
| Staleness | 7 days without activity (`BRAIN_STALE_DAYS` overrides) |
| Brain stays deterministic | No LLM judgement inside Brain (decision #5). The calling session tags and judges; Brain stores, checks structure, gates |
| Deferred | spec-kit "assess" (go / needs-clarification / kill) — separate goal |

## 3. Data model — one additive migration

| Table | Column / table | Type | Meaning |
|---|---|---|---|
| `goals` | `rules_version` | integer not null default 0 | 0 = legacy rules; `lockGoal` sets 1 |
| `goals` | `completion_mode` | text null | `normal` \| `forced` (set by `completeGoal`) |
| `goals` | `converge_snapshot` | text null | JSON converge report stored at completion |
| `goal_requirements` | `verify_method` | text null | `test` \| `command` \| `api` \| `inspection` \| `manual` |
| `goal_requirements` | `coverage` | text null | taxonomy category (§4.2) the line addresses |
| `goal_questions` | `recommended` | text null | session's recommended answer, shown in the batch |
| `verification_runs` | `verdict` | text null | `verified` \| `partial` \| `failed` (null on legacy rows) |
| `failures` | `resolution_note` | text null | reason when closed via `failure_resolve` |
| `failure_solutions` | `verdict` | text null | `verified` \| `partial` \| `failed` |
| `failure_solutions` | `reproduction` | text null | how the original symptom was re-checked |
| **new** `goal_projects` | `goal_id`, `project_id` (PK both) | text | multi-project goal ↔ project link |
| **new** `work_unit_requirements` | `work_unit_id`, `requirement_id` (PK both) | text, integer | work unit serves criterion |
| **new** `goal_principle_acks` | `goal_id`, `knowledge_id` (PK both), `mode`, `note`, `decision_id`, `created_at` | | principle acknowledged as `honoured` or `exception` |

Principles are `knowledge` rows with `category = 'principle'`, scope GLOBAL or PROJECT (`project:<id>`), status `active`. No new principle table. "Versioning" uses knowledge supersede.

The migration only adds columns and tables. Existing rows keep `rules_version = 0`, and `verdict` stays null on historical verification runs. Nothing is deleted or rewritten.

## 4. Rules module — `src/services/contract-rules.ts`

These are pure, synchronous functions over rows already loaded; none of them touch the DB. Each returns `Finding[]`:
`{ id, severity: 'CRITICAL'|'HIGH'|'MEDIUM'|'LOW', kind, ref, message }`.
Each `id` is built deterministically from the rule key plus the subject ref (e.g. `missing:req:97`), so it stays the same across reruns.

### 4.1 Atomic criterion — `checkAtomic(req)`
A required `success_criterion` is **non-atomic** if any of the following hold:
- it has ≥2 enumeration markers (`(1)`, `1.`, `1)`, `a)`, `(a)`, `- ` / `* ` at line start)
- it has ≥2 `;`
- it contains a newline followed by a list marker

Rejected at lock (v1) with a message suggesting a split. "And"-conjunction heuristics are deliberately excluded because they produce too many false positives. Also at lock (v1), each required criterion must have a `verify_method`.

### 4.2 Coverage taxonomy — `coverageGaps(reqs, answeredCoverageQuestion)`
Categories (adapted from `/clarify`, minus UX/terminology which rarely apply to non-coding goals):
- `behaviour`
- `data`
- `failure_modes`
- `edge_cases`
- `non_functional`
- `integration`
- `completion`

A category is **covered** when a requirement carries that `coverage` tag. Intake upserts **one** material Brain question, `review:coverage`, which lists the uncovered categories. The session answers it by adding tagged contract lines or by replying `n/a: <category> — <reason>` for each. The answer is stored verbatim, and the question then stops blocking like any other answered question.

### 4.3 Question cap
`questionAdd` refuses a 6th **material session** question on a goal: "prioritise by impact × uncertainty; record the rest as assumptions". Brain questions (`missing:*`, `review:behaviour`, `review:coverage`) don't count toward the cap. Session questions may carry `recommended`, and the intake report shows it beside the question so the batch can say "reply *yes* to accept the recommendations".

### 4.4 Principles — `principleFindings(principles, acks)`
Applicable principles are the active GLOBAL ones plus those scoped to any project in `goal_projects`.
- An unacknowledged principle is a lock blocker (v1).
- `brain_principle_ack(goalId, knowledgeId, mode, note)`:
  - `honoured`: the note says how the contract honours it.
  - `exception`: the note is mandatory and also creates a MEDIUM decision ("principle exception", spec-kit's complexity tracking). Its id is stored in `decision_id`.
- At converge, an `exception` ack is a LOW finding: it stays visible but doesn't block.

If the goal has no project link, the intake report adds a review item, "no project linked — only GLOBAL principles checked". It doesn't block, because some goals are infrastructure-only.

### 4.5 Coverage by work — `coverageFindings(reqs, units, links)`
- A required criterion served by no work unit is **CRITICAL** `uncovered`.
- A work unit with no link is **MEDIUM** `unrequested`.
- Links must reference requirements of the same goal (validated on insert).

### 4.6 Evidence — `evidenceFindings(reqs, runs, units)`
Each required criterion is judged by its latest run that has a non-null verdict.

| Condition | Severity | kind |
|---|---|---|
| no run with a verdict | CRITICAL | `missing` |
| latest verdict `failed` | CRITICAL | `contradicts` |
| latest verdict `partial` | HIGH | `partial` |
| latest `verified` run is older than the most recent work unit `completed_at` on the goal | HIGH | `stale_evidence` |
| work unit not COMPLETED / SKIPPED | HIGH | `unfinished_work` |
| unresolved failure linked to the goal | CRITICAL | `open_failure` |
| optional criterion without a verified run | MEDIUM | `missing_optional` |
| constraint / exclusion line | LOW | `review` (listed for the session; not machine-checkable) |

`NOT_APPLICABLE` criteria (reason required, as today) produce no finding.

## 5. Gates

| Gate | v0 goal (grandfathered) | v1 goal |
|---|---|---|
| `goal_lock` | unchanged §9 check | §9 check + atomic criteria + `verify_method` present + principles acknowledged (+ `review:coverage` answered via the open-question rule); sets `rules_version = 1` |
| `goal_start` | unchanged | refuses while any `uncovered` finding exists |
| `goal_complete` | unchanged criteria check, **but** `force` now needs `reason` | runs converge; refuses on any CRITICAL/HIGH; stores `converge_snapshot`; `completion_mode = 'normal'` |
| `goal_complete --force --reason` | allowed, MEDIUM decision, `completion_mode = 'forced'` | same; snapshot still stored |
| `failure_resolve` (not goal-scoped; applies to every failure) | needs `reason` → `resolution_note` + observation | same |

**Verification recording.** `recordVerification` accepts `verdict`. When `verdict` is absent, `passed` maps to `verified` or `failed` so old callers keep working. On v1 goals, `verified` is rejected unless:
- `actualResult` is non-empty, and
- `verificationType` equals the criterion's `verify_method`.

Requirement status follows the verdict: `verified` → PASSED, `failed` → FAILED, `partial` → PENDING.

**Failure solutions.** `addSolution` accepts `verdict` and `reproduction`. The failure is marked resolved only when `verdict = verified` and `reproduction` is non-empty. A legacy `successful: true` without `reproduction` is stored as `partial` and does **not** resolve; the response explains why.

## 6. Hygiene

- **Activity touches the goal.** `touchGoal(db, goalId)` bumps `goals.updated_at`. It is called from decision, observation, verification, failure, work-unit create/update, question and principle-ack writes that carry a `goalId`.
- **Staleness is computed, never stored.** A goal is stale when its status is DRAFT/LOCKED/EXECUTING/BLOCKED and `now − updated_at > BRAIN_STALE_DAYS` (default 7). The clock is injectable for tests.
- `currentGoal` skips stale goals. `context get` (the SessionStart hook) prints one line: `N stale goals: <ids> — complete, cancel or resume`.
- `goal_resume` touches the goal, which un-stales it.
- **New `brain_goal_cancel(id, reason)`** sets status CANCELLED (already terminal in code) and writes an observation. It is refused on terminal goals.

## 7. Converge report — `brain_goal_converge(id)`

It is read-only and available on both CLI and MCP. It returns:
- the findings, sorted by severity then id
- a `converged` flag (true when there are no CRITICAL/HIGH findings)
- per-criterion rows (criterion, verify method, latest verdict, evidence age)
- a next action, e.g. `fix CRITICAL missing:req:97 — record a verified run (test)`

`goal_resume` embeds the converge summary for goals in EXECUTING/VERIFYING. On v0 goals the report runs informationally and is never used as a gate.

## 8. Command surface changes

| Surface | Change |
|---|---|
| `brain_requirement_add` / `requirement add` | `verifyMethod`, `coverage` |
| `brain_question_add` / `question add` | `recommended`; 6th material session question refused |
| `brain_verification_record` | `verdict` |
| `brain_work_create` | `serves: number[]` |
| `brain_goal_complete` | `reason` (required with `force`) |
| `brain_failure_solution_add` | `verdict`, `reproduction` |
| `brain_failure_resolve` | `reason` required |
| **new** `brain_goal_converge`, `brain_goal_cancel`, `brain_goal_link_project`, `brain_principle_ack` | CLI + MCP |

Tool descriptions carry the new rules, so calling sessions learn them from the tool list. `context get` and `goal_intake` output show the principles, the coverage question and stale goals.

## 9. Docs

- `ARCHITECTURE.md`: amend §19, §35, §63, §64 and §72, and add a short "Rules versions" section.
- Repo `README.md` / `CLAUDE.md`: the command surface.

**Out of scope:** the user's global `~/.claude/CLAUDE.md` mentions `successful:true also resolves`. That wording will be proposed to the user separately, because it is outside this repo.

## 10. Out of scope

- spec-kit assess mode
- Markdown spec artifacts as Brain memory
- LLM judgement inside Brain (whether a criterion is "measurable", whether a constraint was honoured)
- Auto-splitting legacy blob criteria
- Changing any existing goal's status
- GOAL-2026-0011 (enforced review + functional test suites): related and complementary, since its results can later feed verification verdicts. Not merged into this goal.

## 11. Migration safety

- Development happens on a branch in a worktree. Passive paths (SessionStart, MCP startup) no longer auto-migrate (Phase 4), so a branch migration can't reach the live DB until the user runs `brain migrate`. The existing pre-migration snapshot is still taken.
- Before merge, the migration is applied to a **copy** of `~/.central-brain/brain.db`. The check: goal count and every goal's status are unchanged, and every goal has `rules_version = 0`.

## 12. Testing & verification

- **Unit tests** (vitest) for every rule in `contract-rules.ts`:
  - atomic positives/negatives, including the real blob criteria from GOAL-0018..0029 as fixtures
  - coverage
  - principles
  - evidence severity table rows
  - stable finding ids
- **Integration tests** on a migrated temp DB, one per success criterion of GOAL-2026-0031:
  - lock refuses a blob criterion (v1)
  - complete refuses on CRITICAL/HIGH and succeeds once converged
  - start refuses an uncovered criterion
  - a v0 goal completes under the old rule
  - a failure resolves only with verified + reproduction
  - `currentGoal` skips a stale goal (fake clock)
  - force without a reason is refused; force with a reason sets `completion_mode = 'forced'` and records a decision
- **Migration check** on a copy of the live DB (§11).
- `npm test`, typecheck and build all pass on the final commit.

# Central AI Brain

## Autonomous Goal-Oriented Personal Engineering Operating System

**Status:** Architecture Specification (amended)
**Version:** 0.2
**Primary Runtime:** Claude / Claude Code
**Persistent Memory:** SQLite (single-file, FTS5 full-text search built in)
**Primary Interaction Model:** Goal-driven autonomous execution
**Core Principle:** The user defines outcomes. The Brain owns decomposition, implementation, recovery, verification, and learning.

**v0.2 amendments (2026-08-30):**

* Unified type-prefixed ID addressing so relationships and scopes resolve unambiguously (§16.1)
* Goal Contract snapshot at lock time — locked goals are actually immutable (§18)
* Success criteria get first-class status; verification runs link to the criterion they verify (§19, §35)
* FTS5 full-text search from day one, behind a swappable search interface (§17.3)
* Knowledge lifecycle: active / superseded / invalid, with supersession links (§28)
* Concurrency policy for multiple simultaneous Claude Code sessions (§17.2)
* Approvals table so IRREVERSIBLE actions have a structural gate (§21.1)
* brain.db lives in `~/.central-brain/`, not the repo (§17.1); backup strategy (§17.4)
* Context retrieval gets an explicit budget (§37.1)
* Enforcement via Claude Code hooks — session-start context injection is mechanical, not voluntary (§52.1)
* **Central Brain is the sole memory system** — it replaces claude-mem and any parallel memory layers (§2.4)
* MCP server pulled forward into Milestone 1 alongside the CLI (§76, §79)
* Model routing: complexity-based Claude Code model selection per goal/work unit (§12.1)

---

# 1. Vision

Central AI Brain is a persistent autonomous intelligence layer that operates above all projects, repositories, machines, services, databases, infrastructure, accounts, and tools.

The Brain should not behave like a coding assistant waiting for individual instructions.

Instead, the user provides a **goal**.

Example:

> Add Google and Microsoft SSO to my application while keeping existing users working.

The Brain is responsible for determining:

* which projects are involved
* which repositories are involved
* which services are affected
* which files need modification
* which databases need changes
* which infrastructure needs changes
* which environments need updates
* which tests must be created or executed
* how the feature should be deployed
* how the result should be verified
* what knowledge should be retained afterwards

The Brain should minimize user interaction.

Questions should be asked primarily during the **Goal Clarification Phase**, before implementation begins.

Once the goal is sufficiently understood, the Brain should autonomously complete the goal end-to-end unless it encounters:

* missing permissions
* missing credentials
* contradictory requirements
* irreversible operations requiring approval
* actions outside configured safety boundaries

---

# 2. Core Philosophy

The system is built around several principles.

## 2.1 Goals, not tasks

Users express outcomes.

Bad interaction:

> Change `auth.controller.ts`.

Preferred interaction:

> Add Microsoft authentication support.

The Brain determines the implementation details.

---

## 2.2 Persistent knowledge belongs in SQLite

The Brain must not create growing collections of persistent Markdown files such as:

```text
MEMORY.md
TASKS.md
PROJECT_NOTES.md
DECISIONS.md
LEARNINGS.md
ARCHITECTURE.md
STATUS.md
```

Instead:

```text
brain.db
```

is the authoritative persistent knowledge store.

Markdown may exist as normal project documentation when appropriate, but it must not be used as the Brain's memory mechanism.

---

## 2.3 Claude is replaceable compute

Claude should not itself be the Brain.

Architecture:

```text
Claude / LLM
     │
     ▼
Brain API / CLI / MCP
     │
     ▼
SQLite
```

Claude provides:

* reasoning
* planning
* code generation
* debugging
* research
* execution

The Brain provides:

* persistent state
* knowledge
* project topology
* task history
* decisions
* relationships
* execution history
* failures
* learnings

This allows the underlying LLM to eventually be replaced without losing system intelligence.

---

## 2.4 One memory system, not three

This machine must not run parallel competing memory layers.

Central Brain **replaces** claude-mem (and any similar passive observation layer) rather than coexisting with it. Divergent parallel memories mean none can be trusted.

Policy:

* Central Brain (SQLite + FTS5) is the **only** authoritative persistent memory.
* claude-mem is retired for this workflow once Milestone 1 ships; its passive-recall role is absorbed by `brain context` + hooks (§52.1).
* CLAUDE.md files remain human-facing routing/behavior documentation only — never memory.
* graphify output is a derived artifact, never a source of truth.

Migration of any valuable claude-mem observations into `brain.db` is an optional one-time import, not an ongoing sync.

---

# 3. Primary User Experience

The ideal interaction is:

```text
USER

"Add subscription billing to Project X."
```

The Brain then:

```text
UNDERSTAND
     ↓
DISCOVER CONTEXT
     ↓
IDENTIFY AMBIGUITIES
     ↓
ASK CLARIFICATION QUESTIONS
     ↓
LOCK GOAL CONTRACT
     ↓
PLAN
     ↓
EXECUTE
     ↓
OBSERVE
     ↓
RECOVER FROM FAILURES
     ↓
VERIFY
     ↓
DEPLOY IF REQUIRED
     ↓
VERIFY FINAL RESULT
     ↓
STORE LEARNINGS
     ↓
COMPLETE
```

After the Goal Contract is locked, implementation problems should normally be solved autonomously rather than escalated to the user.

---

# 4. System Architecture

```text
                         ┌─────────────────────┐
                         │        USER         │
                         │                     │
                         │   Outcome / Goal    │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │    GOAL INTAKE      │
                         │                     │
                         │ Understand          │
                         │ Discover            │
                         │ Clarify             │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │    GOAL CONTRACT    │
                         │                     │
                         │ Objective           │
                         │ Constraints         │
                         │ Success Criteria    │
                         │ Permissions         │
                         └──────────┬──────────┘
                                    │
                                    ▼
               ┌──────────────────────────────────────┐
               │             CENTRAL BRAIN            │
               │                                      │
               │ Planner                              │
               │ Context Engine                       │
               │ Project Resolver                     │
               │ Decision Engine                      │
               │ Execution Controller                 │
               │ Verification Engine                  │
               │ Learning Engine                      │
               └────────────────┬─────────────────────┘
                                │
                                ▼
                       ┌───────────────────┐
                       │     BRAIN API     │
                       │ CLI / MCP / SDK   │
                       └─────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │      SQLite      │
                        │     brain.db     │
                        └──────────────────┘

                                 │
                ┌────────────────┼─────────────────┐
                ▼                ▼                 ▼
             Coding           Systems          External
              Tools            Tools            Tools

             git              ssh              browser
             npm              docker           APIs
             tests            kubectl          email
             IDE              shell            cloud
```

---

# 5. Brain Responsibilities

The Brain owns the following responsibilities.

## 5.1 Goal Management

The Brain must:

* create goals
* clarify goals
* lock goals
* track execution
* track blockers
* track success criteria
* determine completion

---

## 5.2 Context Resolution

Before execution, the Brain should determine relevant context from SQLite.

It should retrieve only information relevant to the current goal.

Examples:

* related projects
* repositories
* architecture
* dependencies
* previous decisions
* previous failures
* known environment configuration
* known user preferences
* historical solutions
* recent modifications

---

# 6. Goal Model

A Goal represents the outcome requested by the user.

Example:

```text
Goal ID:
GOAL-2026-0042

Title:
Add Microsoft SSO

Objective:
Allow users to authenticate using Microsoft accounts.

Scope:
- frontend
- backend
- authentication service
- production environment

Constraints:
- existing users must continue working
- username/password login must remain available
- no production downtime

Success Criteria:
- Microsoft login works
- existing login works
- automated tests pass
- staging deployment passes
- production smoke test passes

Autonomy:
FULL

Clarification:
COMPLETE
```

---

# 7. Goal States

Recommended lifecycle:

```text
DRAFT
    ↓
DISCOVERING
    ↓
NEEDS_CLARIFICATION
    ↓
READY
    ↓
LOCKED
    ↓
PLANNING
    ↓
EXECUTING
    ↓
VERIFYING
    ↓
COMPLETED
```

Additional states:

```text
BLOCKED
FAILED
CANCELLED
PAUSED
```

---

# 8. Goal Intake Process

Every new goal should follow this sequence.

## Phase 1 — Parse Intent

Extract:

* desired outcome
* obvious scope
* likely systems
* constraints
* expected result

---

## Phase 2 — Discover Existing Context

Search Brain knowledge before asking questions.

Example:

```text
brain context resolve --goal GOAL-42
```

The Brain should inspect:

* previous related goals
* projects
* repositories
* services
* environments
* architecture
* known policies
* user preferences
* existing implementations

---

## Phase 3 — Find Ambiguity

Questions should only be asked when answers materially affect implementation.

Good question:

> Should existing password authentication remain available?

Bad question:

> Should I use a service class?

Implementation choices normally belong to the Brain.

---

## Phase 4 — Clarification Batch

Questions should be collected and asked together whenever possible.

Example:

```text
Before implementation I need three decisions:

1. Should existing password authentication remain enabled?
2. Should Microsoft login support personal accounts or only company accounts?
3. Should new SSO users be automatically provisioned?
```

Avoid repeated interruptions.

---

# 9. Goal Contract

After clarification, create a Goal Contract.

The Goal Contract freezes the interpretation of the goal.

Schema:

```text
objective
scope
constraints
success criteria
known exclusions
risk policy
permissions
assumptions
```

Once the Goal Contract is locked, the system enters autonomous execution mode.

---

# 10. Autonomous Execution Rule

After:

```text
goal.status = LOCKED
```

the Brain should avoid user questions.

Implementation failures are not clarification questions.

Examples:

```text
npm test fails
```

Brain action:

```text
investigate
diagnose
repair
retry
```

Not:

> Tests failed. What should I do?

---

# 11. When the Brain May Interrupt

User interruption should occur only when one of these conditions exists.

## Missing Authorization

Example:

```text
AWS authentication expired.
```

---

## Missing Credential

Example:

```text
Stripe API key is unavailable.
```

---

## Requirement Conflict

Example:

```text
Requirement A requires anonymous access.
Requirement B prohibits anonymous access.
```

---

## Irreversible Action

Example:

```text
Production database deletion.
```

---

## Financial Commitment

Example:

```text
Provisioning infrastructure costing $1,000/month.
```

---

# 12. Decision Authority

Every action should be classified by risk.

## LOW

Brain acts automatically.

Examples:

* modify code
* rename symbols
* install development package
* refactor implementation
* update unit tests
* modify configuration

---

## MEDIUM

Brain decides automatically but records the decision.

Examples:

* add database migration
* modify API design
* introduce new dependency
* modify application architecture
* create infrastructure resource

---

## HIGH

Brain chooses the safest reversible option and records the decision.

Examples:

* significant infrastructure change
* authentication architecture migration
* production deployment
* networking changes

---

## IRREVERSIBLE

Explicit approval required.

Examples:

* deleting production database
* destructive migration without recovery
* deleting cloud account
* permanent data removal
* significant financial expenditure

---

## 12.1 Model Routing

The Brain selects which Claude model should work on a goal, based on task complexity. Compute should match the task: trivial lookups must not burn frontier-model tokens; critical migrations must not run on a small model.

**Complexity** is a first-class field on goals and work units:

```text
trivial | low | medium | high | critical
```

**Mapping** (user-editable in `~/.central-brain/config.json` under `modelMap`; defaults):

```text
trivial   → haiku
low       → sonnet
medium    → sonnet
high      → opus
critical  → fable
```

A goal with `risk_level` HIGH or IRREVERSIBLE is bumped to at least `high` complexity for routing purposes.

**Interfaces:** `brain model recommend [--goal GOAL-X | --complexity <level>]` and MCP tool `brain_model_recommend`; `brain context get` embeds `recommendedModel`.

**Consumption points** (a running session cannot switch its own model, so routing applies where model choice actually happens):

1. **Subagent dispatch** — the Agent tool accepts a per-subagent model override; context tells the orchestrator which model each work unit warrants. Fully automatic.
2. **Session launch** — `brain-claude` wrapper: `claude --model $(brain model recommend)`.
3. **In-session advisory** — the SessionStart hook output includes `recommendedModel`; the agent tells the user when the active goal warrants a `/model` switch.

**Caveat:** LLM self-assessed complexity inflates. Complexity is recorded per goal (auditable), and the mapping is user-tunable config — adjust when routing skews expensive.

---

# 13. Work Units

Goals decompose into Work Units.

Example:

```text
GOAL-42
Add Microsoft SSO

├── WU-42.1 Inspect existing authentication
├── WU-42.2 Identify affected systems
├── WU-42.3 Design integration
├── WU-42.4 Modify backend
├── WU-42.5 Modify frontend
├── WU-42.6 Add database changes
├── WU-42.7 Add tests
├── WU-42.8 Update configuration
├── WU-42.9 Deploy staging
├── WU-42.10 Verify staging
├── WU-42.11 Deploy production
└── WU-42.12 Verify goal
```

Users do not normally interact directly with Work Units.

---

# 14. Dynamic Planning

Plans must be mutable.

The Brain should be allowed to discover additional work during implementation.

Initial:

```text
WU-1 Backend modification
WU-2 Frontend modification
WU-3 Tests
```

During implementation:

```text
Database schema change discovered.
```

Brain automatically creates:

```text
WU-2.5 Database migration
```

No user approval required unless risk policy requires it.

---

# 15. World Model

The Brain should not organize everything solely around projects.

The top-level knowledge model should contain entities.

Entity examples:

```text
PROJECT
REPOSITORY
SERVICE
DATABASE
MACHINE
SERVER
CONTAINER
ENVIRONMENT
NETWORK
DOMAIN
API
ACCOUNT
PERSON
LIBRARY
FILE
MODULE
APPLICATION
DEVICE
```

---

# 16. Relationships

Entities can have relationships.

Examples:

```text
project CONTAINS repository

repository IMPLEMENTS service

service USES database

service DEPLOYED_TO server

frontend CALLS backend

domain POINTS_TO service

container RUNS_ON machine

project DEPENDS_ON project

repository DEPLOYED_AS service

service AUTHENTICATED_BY auth-provider
```

This creates a lightweight knowledge graph.

---

## 16.1 Unified ID Addressing

Projects, repositories, goals, and generic entities live in different tables, yet relationships, knowledge scopes, and artifacts must reference any of them unambiguously.

Therefore every reference field (`relationships.source_id`, `relationships.target_id`, `knowledge.scope_id`, `learnings.scope_id`, `observations.scope_id`, `artifacts.entity_id`) uses **type-prefixed IDs**:

```text
project:prospera
repo:prospera-api
goal:GOAL-2026-0042
entity:truenas
entity:supabase.example.com
```

Rules:

* the prefix names the owning table (or `entity:` for the generic table)
* the Brain API resolves prefixed IDs to rows; raw unprefixed IDs are invalid in reference fields
* `scope_type` columns remain for cheap filtering, but the prefixed `scope_id` is authoritative

Without this, `repo-api IMPLEMENTS service-api` cannot be resolved reliably and the knowledge graph is broken from day one.

---

# 17. Why SQLite

SQLite provides:

* zero infrastructure
* strong transactional integrity
* excellent local performance
* easy backups
* mature tooling
* JSON support
* full-text search
* simple portability
* straightforward migrations

The Brain can later move to PostgreSQL if necessary, but SQLite is preferred initially.

---

## 17.1 Database Location

The Brain is global across all projects, while the CLI runs from arbitrary working directories.

Therefore `brain.db` does **not** live in the central-brain repository.

```text
default:   ~/.central-brain/brain.db
override:  BRAIN_DB environment variable
```

`brain init` creates the directory, applies migrations, and prints the resolved path.

---

## 17.2 Concurrency

Multiple Claude Code sessions will read and write `brain.db` simultaneously.

Required from day one:

```text
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

Mutating operations record an `executor` / `session_id` where the schema provides one (executions, decisions, observations).

Later (execution phases): goal claiming, so two sessions cannot actively work the same goal. Not required for Milestone 1.

---

## 17.3 Full-Text Search (FTS5)

Search quality is the core value proposition. `LIKE '%term%'` search is not acceptable, even in Milestone 1.

From day one, maintain FTS5 virtual tables kept in sync via triggers:

```text
knowledge_fts   (statement, category)
learnings_fts   (learning, trigger)
decisions_fts   (decision, reason)
failures_fts    (error_message, context)
goals_fts       (title, objective)
```

All search commands (`brain knowledge search`, `brain context search`, `brain failure search`, ...) query FTS5 with BM25 ranking.

The search layer is a **swappable interface**:

```text
search(query, { scopes?, types?, limit? }) → ranked results
```

Backend v1: SQLite FTS5.
Backend v2 (later phase): hybrid FTS5 + semantic retrieval via the existing self-hosted embeddings endpoint and Qdrant. The interface must not change when the backend does.

---

## 17.4 Backups

The entire accumulated operational intelligence lives in one file. It must be protected:

* `brain backup` — writes a timestamped copy to `~/.central-brain/backups/` using SQLite's online backup API (`VACUUM INTO`)
* automatic snapshot before every schema migration
* retention: keep the last 10 snapshots
* later phase: replicate backups to truenas (off-machine copy)

---

# 18. Recommended SQLite Schema

## goals

```sql
CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,

    status TEXT NOT NULL,

    autonomy_level TEXT DEFAULT 'full',

    clarification_status TEXT DEFAULT 'pending',

    risk_level TEXT,

    complexity TEXT,

    contract_snapshot TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    locked_at TEXT,
    started_at TEXT,
    completed_at TEXT
);
```

**Lock immutability:** "locked" must be real, not just a status value. At lock time the Brain serializes the full contract (objective + requirements + assumptions + exclusions) into `contract_snapshot` as JSON and sets `locked_at`. After locking, objective and requirements are read-only through the API; scope changes require a new goal or an explicit unlock decision recorded in `decisions`.

---

# 19. Goal Requirements

```sql
CREATE TABLE goal_requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    goal_id TEXT NOT NULL,

    requirement_type TEXT NOT NULL,

    description TEXT NOT NULL,

    priority TEXT DEFAULT 'required',

    status TEXT NOT NULL DEFAULT 'PENDING',

    status_reason TEXT,

    FOREIGN KEY(goal_id)
        REFERENCES goals(id)
);
```

Requirement `status` values (replaces the earlier boolean `verified` flag, aligning with §63):

```text
PENDING
PASSED
FAILED
NOT_APPLICABLE
```

`NOT_APPLICABLE` requires a `status_reason`.

Requirement types:

```text
objective
constraint
success_criterion
exclusion
assumption
```

---

# 20. Goal Questions

```sql
CREATE TABLE goal_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    goal_id TEXT NOT NULL,

    question TEXT NOT NULL,

    answer TEXT,

    status TEXT DEFAULT 'pending',

    created_at TEXT NOT NULL,
    answered_at TEXT,

    FOREIGN KEY(goal_id)
        REFERENCES goals(id)
);
```

---

# 21. Goal Decisions

```sql
CREATE TABLE decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    goal_id TEXT,

    scope_type TEXT,
    scope_id TEXT,

    decision TEXT NOT NULL,

    reason TEXT,

    alternatives TEXT,

    risk_level TEXT,

    reversible INTEGER DEFAULT 1,

    executor TEXT,

    created_at TEXT NOT NULL
);
```

---

## 21.1 Approvals

The LOW/MEDIUM/HIGH/IRREVERSIBLE policy (§12) must be structural, not prose. IRREVERSIBLE actions need somewhere to be gated when autonomous execution arrives.

```sql
CREATE TABLE approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    goal_id TEXT,

    decision_id INTEGER,

    action TEXT NOT NULL,

    risk_level TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending',

    requested_at TEXT NOT NULL,
    resolved_at TEXT,

    FOREIGN KEY(goal_id) REFERENCES goals(id),
    FOREIGN KEY(decision_id) REFERENCES decisions(id)
);
```

`status`: `pending` | `approved` | `denied`.

Milestone 1 defines the table and `brain approval` CRUD only; enforcement wiring belongs to the execution-engine phase.

---

# 22. Work Units

```sql
CREATE TABLE work_units (
    id TEXT PRIMARY KEY,

    goal_id TEXT NOT NULL,

    parent_id TEXT,

    title TEXT NOT NULL,

    description TEXT,

    work_type TEXT,

    complexity TEXT,

    status TEXT NOT NULL,

    priority INTEGER DEFAULT 100,

    attempt_count INTEGER DEFAULT 0,

    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,

    FOREIGN KEY(goal_id)
        REFERENCES goals(id)
);
```

Statuses:

```text
PENDING
READY
RUNNING
VERIFYING
COMPLETED
FAILED
BLOCKED
SKIPPED
```

---

# 23. Work Unit Dependencies

```sql
CREATE TABLE work_unit_dependencies (
    work_unit_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,

    PRIMARY KEY(work_unit_id, depends_on)
);
```

---

# 24. Projects

```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY,

    name TEXT NOT NULL,

    description TEXT,

    status TEXT DEFAULT 'active',

    root_path TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

# 25. Repositories

```sql
CREATE TABLE repositories (
    id TEXT PRIMARY KEY,

    project_id TEXT,

    name TEXT NOT NULL,

    path TEXT,

    remote_url TEXT,

    default_branch TEXT,

    language TEXT,

    framework TEXT,

    created_at TEXT NOT NULL,

    FOREIGN KEY(project_id)
        REFERENCES projects(id)
);
```

---

# 26. Entities

Use a generic entity table for everything outside strict project metadata.

```sql
CREATE TABLE entities (
    id TEXT PRIMARY KEY,

    entity_type TEXT NOT NULL,

    name TEXT NOT NULL,

    description TEXT,

    metadata TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

`metadata` contains JSON.

---

# 27. Relationships

```sql
CREATE TABLE relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    source_id TEXT NOT NULL,

    relationship_type TEXT NOT NULL,

    target_id TEXT NOT NULL,

    metadata TEXT,

    created_at TEXT NOT NULL
);
```

Example:

```text
repo-api
IMPLEMENTS
service-api
```

---

# 28. Knowledge

```sql
CREATE TABLE knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    scope_type TEXT NOT NULL,

    scope_id TEXT,

    category TEXT,

    statement TEXT NOT NULL,

    confidence REAL DEFAULT 1.0,

    source_type TEXT,

    source_reference TEXT,

    status TEXT NOT NULL DEFAULT 'active',

    superseded_by INTEGER,

    created_at TEXT NOT NULL,

    last_verified_at TEXT,

    FOREIGN KEY(superseded_by) REFERENCES knowledge(id)
);
```

**Knowledge lifecycle.** Facts change. Without a lifecycle, the knowledge table becomes an append-only pile of contradictions that poisons context retrieval.

`status`: `active` | `superseded` | `invalid`.

Rules:

* context retrieval and search return only `active` knowledge by default
* correcting a fact inserts a new row and marks the old one `superseded` with `superseded_by` pointing at the replacement — history is preserved, not overwritten
* `brain knowledge invalidate <id>` marks knowledge discovered to be wrong
* `brain knowledge verify <id>` bumps `last_verified_at` on still-true facts

Scopes:

```text
GLOBAL
PROJECT
REPOSITORY
SERVICE
ENVIRONMENT
MACHINE
FILE
MODULE
GOAL
```

---

# 29. Learnings

Learnings are reusable knowledge produced by experience.

```sql
CREATE TABLE learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    scope_type TEXT,

    scope_id TEXT,

    trigger TEXT,

    learning TEXT NOT NULL,

    usefulness_score REAL DEFAULT 1,

    times_used INTEGER DEFAULT 0,

    created_at TEXT NOT NULL,

    last_used_at TEXT
);
```

Example:

```text
Trigger:
Prospera deployment fails on timezone-sensitive code.

Learning:
Production runs in UTC while some user workflows assume US local timezone.
Always verify conversion at API boundaries.
```

---

# 30. Observations

Observations represent facts discovered during execution.

```sql
CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    goal_id TEXT,

    work_unit_id TEXT,

    scope_type TEXT,

    scope_id TEXT,

    observation TEXT NOT NULL,

    confidence REAL DEFAULT 1,

    created_at TEXT NOT NULL
);
```

---

# 31. Failures

```sql
CREATE TABLE failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    goal_id TEXT,

    work_unit_id TEXT,

    failure_type TEXT,

    error_message TEXT,

    context TEXT,

    resolved INTEGER DEFAULT 0,

    created_at TEXT NOT NULL,
    resolved_at TEXT
);
```

---

# 32. Failure Solutions

```sql
CREATE TABLE failure_solutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    failure_id INTEGER NOT NULL,

    solution TEXT NOT NULL,

    successful INTEGER,

    created_at TEXT NOT NULL,

    FOREIGN KEY(failure_id)
        REFERENCES failures(id)
);
```

This becomes especially valuable over time.

The Brain can later query:

```text
Have I encountered this error before?
```

---

# 33. Executions

Every significant Brain action should be auditable.

```sql
CREATE TABLE executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    goal_id TEXT,

    work_unit_id TEXT,

    executor TEXT,

    action_type TEXT,

    command TEXT,

    result TEXT,

    exit_code INTEGER,

    started_at TEXT,

    completed_at TEXT
);
```

---

# 34. Artifacts

```sql
CREATE TABLE artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    goal_id TEXT,

    work_unit_id TEXT,

    artifact_type TEXT,

    path TEXT,

    entity_id TEXT,

    change_type TEXT,

    created_at TEXT NOT NULL
);
```

Examples:

```text
source_file
migration
configuration
docker_image
deployment
documentation
```

---

# 35. Verification Runs

```sql
CREATE TABLE verification_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    goal_id TEXT,

    work_unit_id TEXT,

    requirement_id INTEGER,

    verification_type TEXT,

    command TEXT,

    expected_result TEXT,

    actual_result TEXT,

    passed INTEGER,

    created_at TEXT NOT NULL,

    FOREIGN KEY(requirement_id) REFERENCES goal_requirements(id)
);
```

`requirement_id` links a verification run to the success criterion it verifies. This is what makes the Completion Rule (§64) computable: a criterion moves to `PASSED` only when a linked verification run passes.

---

# 36. Context Retrieval

Claude should never load the entire Brain database.

Context must be retrieved dynamically.

Example:

```bash
brain context get \
  --goal GOAL-42
```

Possible output:

```json
{
  "goal": {},
  "projects": [],
  "repositories": [],
  "relatedKnowledge": [],
  "previousGoals": [],
  "knownFailures": [],
  "decisions": []
}
```

---

# 37. Context Ranking

Retrieved information should be ranked using:

```text
goal relevance
+
scope proximity
+
recency
+
confidence
+
historical usefulness
```

Example hierarchy:

```text
current goal
current repository
current project
related service
global knowledge
```

---

## 37.1 Context Budget

"Retrieve only relevant information" needs a mechanism, or `context get` bloats prompts.

`brain context get` accepts an explicit budget:

```bash
brain context get --goal GOAL-42 --budget 30
```

* `--budget N` caps total returned items (default 30), allocated across categories (knowledge, learnings, decisions, failures, related goals)
* within each category, items are ranked by scope proximity → recency (`last_verified_at` / `created_at`) → confidence → historical usefulness
* only `active` knowledge is eligible (§28)
* output is compact JSON intended for direct prompt injection

---

# 38. Brain CLI

The first implementation should expose a CLI.

Suggested executable:

```text
brain
```

---

# 39. Goal CLI

```bash
brain goal create

brain goal show GOAL-42

brain goal current

brain goal list

brain goal clarify GOAL-42

brain goal lock GOAL-42

brain goal start GOAL-42

brain goal complete GOAL-42

brain goal block GOAL-42
```

---

# 40. Context CLI

```bash
brain context get --goal GOAL-42

brain context search "authentication"

brain context project prospera

brain context repository prospera-api
```

---

# 41. Knowledge CLI

```bash
brain knowledge add

brain knowledge search "timezone"

brain knowledge show 127

brain knowledge verify 127
```

---

# 42. Learning CLI

```bash
brain learning add

brain learning search "postgres migration"

brain learning useful 17

brain learning list --project prospera
```

---

# 43. Project CLI

```bash
brain project add

brain project list

brain project show prospera

brain project scan /projects/prospera

brain project refresh prospera
```

---

# 44. Repository CLI

```bash
brain repo add

brain repo scan

brain repo show

brain repo refresh
```

---

# 45. Entity CLI

```bash
brain entity add

brain entity search

brain relationship add

brain relationship show
```

---

# 46. Work CLI

```bash
brain work create

brain work list --goal GOAL-42

brain work start WU-42.4

brain work complete WU-42.4

brain work fail WU-42.4
```

---

# 47. Decision CLI

```bash
brain decision add

brain decision list --goal GOAL-42

brain decision search "authentication"
```

---

# 48. Failure CLI

```bash
brain failure add

brain failure search "ECONNRESET"

brain failure resolve
```

---

# 49. Verification CLI

```bash
brain verify add

brain verify run

brain verify goal GOAL-42
```

---

# 50. Architecture Recommendation

Recommended technology stack:

```text
Node.js
TypeScript
SQLite
better-sqlite3
Drizzle ORM
Zod
Commander.js
MCP SDK
```

Possible structure:

```text
central-brain/
│
├── CLAUDE.md
│
├── package.json
│
├── tsconfig.json
│
│   (brain.db lives in ~/.central-brain/ — see §17.1, never in the repo)
│
├── src/
│   ├── cli/
│   │   ├── goal.ts
│   │   ├── work.ts
│   │   ├── context.ts
│   │   ├── project.ts
│   │   ├── knowledge.ts
│   │   └── decision.ts
│   │
│   ├── brain/
│   │   ├── goal-manager.ts
│   │   ├── context-engine.ts
│   │   ├── planner.ts
│   │   ├── decision-engine.ts
│   │   ├── execution-engine.ts
│   │   ├── verification-engine.ts
│   │   └── learning-engine.ts
│   │
│   ├── database/
│   │   ├── schema.ts
│   │   ├── migrations/
│   │   └── database.ts
│   │
│   ├── repositories/
│   │   ├── goal.repository.ts
│   │   ├── project.repository.ts
│   │   ├── knowledge.repository.ts
│   │   └── work.repository.ts
│   │
│   ├── scanners/
│   │   ├── repository-scanner.ts
│   │   ├── project-scanner.ts
│   │   └── dependency-scanner.ts
│   │
│   ├── tools/
│   │   ├── shell.ts
│   │   ├── git.ts
│   │   ├── filesystem.ts
│   │   └── docker.ts
│   │
│   └── mcp/
│       └── server.ts
│
└── tests/
```

---

# 51. CLAUDE.md

This should remain intentionally small.

```md
# Central Brain Agent

You are an autonomous reasoning and execution agent operating under Central Brain.

Central Brain is the authoritative source for persistent information including:

- goals
- projects
- repositories
- systems
- services
- machines
- environments
- decisions
- task history
- execution history
- failures
- learnings
- relationships
- user preferences

Persistent knowledge must be stored through Central Brain.

Do not maintain Brain memory using additional Markdown files.

## Session Initialization

At the beginning of every meaningful session:

1. Query Central Brain.
2. Determine whether an active goal exists.
3. Retrieve relevant goal context.
4. Retrieve relevant projects, systems, decisions, failures, and learnings.
5. Use this context before reasoning about implementation.

## Goal Handling

For every new goal:

1. Understand the requested outcome.
2. Search Central Brain for existing relevant context.
3. Discover affected projects, systems, repositories, services, and environments.
4. Identify ambiguities that materially affect the goal.
5. Ask clarification questions together before implementation.
6. Create a Goal Contract.
7. Lock the Goal Contract once sufficient clarity exists.
8. Create an implementation plan.
9. Execute autonomously.
10. Resolve implementation failures independently.
11. Continuously validate progress.
12. Verify all success criteria.
13. Record decisions, observations, failures, solutions, and learnings.
14. Complete the goal only when the complete outcome is verified.

## Autonomy

After a Goal Contract is locked, avoid asking the user implementation questions.

Prefer:

investigate
reason
experiment
repair
retry
verify

instead of escalating implementation problems.

User interruption is appropriate only when:

- required credentials or authorization are unavailable
- requirements fundamentally conflict
- an irreversible action requires approval
- an operation violates configured risk policy
- a significant financial commitment requires approval

## Decision Policy

LOW RISK:
Decide and execute automatically.

MEDIUM RISK:
Decide automatically and record the decision.

HIGH RISK:
Choose the safest reversible option and record the reasoning.

IRREVERSIBLE:
Require explicit user approval.

## Execution Principles

Do not assume a goal belongs to only one repository.

Ask:

"What systems must change for this goal to become true?"

A goal may require changes across:

- code
- repositories
- databases
- infrastructure
- containers
- servers
- DNS
- cloud resources
- browser interfaces
- APIs
- documentation
- devices
- external systems

Treat plans as dynamic.

Create additional Work Units whenever new necessary work is discovered.

Never mark a goal complete simply because code was written.

A goal is complete only when its success criteria have been verified.

## Learning

After every meaningful goal, determine:

- what new facts were discovered
- what decisions should be preserved
- what failures occurred
- which solutions succeeded
- what knowledge is reusable
- what project topology changed

Persist those findings into Central Brain.
```

---

# 52. Brain MCP Server

After the CLI works, expose the same functionality through MCP.

Possible tools:

```text
brain_goal_create

brain_goal_get

brain_goal_lock

brain_context_get

brain_context_search

brain_project_search

brain_repository_get

brain_work_create

brain_work_update

brain_decision_record

brain_observation_record

brain_failure_record

brain_learning_record

brain_verification_record
```

Claude Code can then interact with the Brain directly.

---

## 52.1 Enforcement via Hooks

The system must not rely on Claude *choosing* to consult the Brain — prose instructions decay. Brain usage is enforced mechanically with Claude Code hooks:

* **SessionStart hook** — runs `brain context get --current --budget 30` and injects the output into the session context. Session initialization becomes automatic, not voluntary.
* **Stop / PreCompact hook** — reminds the agent to persist pending decisions, observations, and learnings before the session ends or compacts.

The hooks are thin shell wrappers around the CLI and are configured in `~/.claude/settings.json`.

This is the difference between a database and a brain. It ships in Milestone 1 alongside the CLI and MCP server.

---

# 53. Tool Design Principle

Do not expose raw SQL to Claude.

Bad:

```text
sqlite_query("DELETE FROM knowledge...")
```

Preferred:

```text
brain_learning_record(...)
brain_context_search(...)
brain_goal_update(...)
```

This provides:

* validation
* authorization
* auditing
* schema independence
* safer migrations
* predictable behavior

---

# 54. Project Discovery

The Brain should support automatic discovery.

Example:

```bash
brain project scan ~/Projects
```

It can detect:

```text
.git
package.json
Dockerfile
docker-compose.yml
package-lock.json
npm-shrinkwrap.json
turbo.json
requirements.txt
pyproject.toml
go.mod
Cargo.toml
README.md
.env.example
```

The Brain should store discovered metadata.

---

# 55. Repository Understanding

Repository scanning should collect:

```text
language
framework
package manager
build command
test command
dev command
deployment strategy
database
major dependencies
directory structure
services
entry points
```

Avoid storing entire source files inside SQLite.

Store metadata and derived knowledge.

---

# 56. Source Code Awareness

For code-level navigation, Brain should eventually understand:

```text
repository
→ module
→ file
→ class
→ function
→ dependency
```

This can be implemented incrementally.

Initially:

```text
repository
→ files
```

Later:

```text
AST indexing
```

---

# 57. File Index

Optional schema:

```sql
CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    repository_id TEXT,

    path TEXT NOT NULL,

    file_type TEXT,

    content_hash TEXT,

    last_indexed_at TEXT,

    UNIQUE(repository_id, path)
);
```

---

# 58. Symbol Index

Future capability:

```sql
CREATE TABLE symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    file_id INTEGER,

    symbol_type TEXT,

    name TEXT,

    signature TEXT,

    start_line INTEGER,

    end_line INTEGER
);
```

This can later support:

```text
Where is authentication implemented?
```

without scanning every file repeatedly.

---

# 59. Context Compression

Do not permanently store verbose LLM-generated descriptions unless useful.

Prefer atomic knowledge.

Bad:

```text
The application seems to potentially be running Node.js...
```

Good:

```text
Project:
Prospera API

Runtime:
Node.js 22

Framework:
NestJS

Database:
PostgreSQL

ORM:
Sequelize
```

Knowledge should be:

* concise
* factual
* searchable
* scoped
* verifiable

---

# 60. Confidence

Knowledge should have confidence.

Example:

```text
Known from package.json
confidence = 1.0

Inferred from source
confidence = 0.9

Assumed from previous task
confidence = 0.6
```

Low-confidence information should be revalidated when important.

---

# 61. Knowledge Freshness

Store:

```text
created_at
last_verified_at
```

Some information becomes stale.

Examples:

```text
dependency versions
server IPs
deployment topology
API behavior
credentials availability
branch names
```

The Context Engine should prefer recently verified information.

---

# 62. Learnings vs Knowledge

These concepts should remain separate.

## Knowledge

Facts.

Example:

```text
Prospera API uses PostgreSQL.
```

## Learning

Experience-derived guidance.

Example:

```text
Prospera production timezone behavior previously caused date bugs.
Always test timezone boundaries before deployment.
```

---

# 63. Goal Verification

Goals require explicit Success Criteria.

Example:

```text
SC-1 User can sign in using Microsoft.
SC-2 Existing password login still works.
SC-3 Existing accounts are matched correctly.
SC-4 Unit tests pass.
SC-5 Integration tests pass.
SC-6 Staging smoke test passes.
```

Each criterion should have:

```text
PENDING
PASSED
FAILED
NOT_APPLICABLE
```

---

# 64. Completion Rule

Never mark:

```text
goal.status = COMPLETED
```

until all required success criteria are:

```text
PASSED
```

or explicitly:

```text
NOT_APPLICABLE
```

with a recorded reason.

---

# 65. Recovery Loop

Execution should use a recovery cycle:

```text
EXECUTE
   ↓
OBSERVE
   ↓
FAILURE?
   │
   ├── NO → CONTINUE
   │
   └── YES
        ↓
     SEARCH MEMORY
        ↓
     DIAGNOSE
        ↓
     GENERATE FIX
        ↓
     EXECUTE FIX
        ↓
     VERIFY
        ↓
     RECORD LEARNING
```

---

# 66. Failure Reuse

Before solving a failure from scratch:

```text
brain failure search "<error>"
```

If a known solution exists, attempt it where appropriate.

This creates compounding intelligence.

---

# 67. Brain Memory Should Improve Over Time

Expected progression:

## Week 1

Brain knows:

```text
projects
repositories
basic architecture
```

## Month 1

Brain knows:

```text
common failures
deployment patterns
personal preferences
service relationships
```

## Month 6

Brain knows:

```text
system architecture history
why important decisions were made
how projects interact
which approaches previously failed
preferred implementation patterns
deployment characteristics
operational constraints
```

The LLM itself has not changed.

The system has become smarter because its persistent Brain has improved.

---

# 68. Global Memory

Some knowledge belongs globally.

Examples:

```text
Prefer npm when project already uses npm.

Never introduce a new framework without strong justification.

Prefer backward-compatible database migrations.

Prefer reversible production changes.

Do not store secrets inside Brain database.

Do not commit .env files.
```

---

# 69. Security

Never store plaintext secrets inside Brain.

Instead store references.

Example:

```text
credential_type:
AWS

credential_reference:
1password://Personal/AWS-Production
```

or:

```text
environment variable:
AWS_PROFILE=production
```

Brain stores **where credentials come from**, not the credentials themselves.

---

# 70. Auditability

Every meaningful autonomous action should be traceable.

You should eventually be able to ask:

```text
Why was this dependency added?
```

Brain returns:

```text
Goal:
GOAL-42

Decision:
DEC-119

Reason:
Existing library did not support Microsoft OAuth PKCE flow.

Alternatives considered:
Library A
Library B

Chosen:
Library C
```

---

# 71. Git Integration

Every coding goal should link commits to Goal IDs.

Example:

```text
feat(auth): add Microsoft SSO

Goal: GOAL-42
```

Optional branch:

```text
brain/GOAL-42-microsoft-sso
```

This creates traceability between:

```text
Goal
→ Work Unit
→ Execution
→ File
→ Commit
```

---

# 72. Goal Resume

Sessions may end.

Brain must support:

```bash
brain goal resume GOAL-42
```

Claude retrieves:

```text
goal contract
completed work units
pending work
decisions
modified files
test state
known failures
next recommended action
```

No Markdown handover file required.

---

# 73. Multi-Project Goals

Goals can span multiple projects.

Example:

> Update my authentication flow everywhere.

Brain discovers:

```text
web-app
admin-app
backend-api
mobile-app
auth-service
```

One Goal.

Multiple repositories.

Multiple Work Units.

---

# 74. Non-Coding Goals

The architecture must not assume all goals involve code.

Example:

> Expose my local transcription service securely.

Possible execution:

```text
inspect machine
inspect Docker
identify STT service
configure reverse proxy
configure DNS
configure TLS
modify firewall
test external access
record architecture
```

No code repository may be involved.

---

# 75. Brain Question

The central planning question should always be:

> What must become true for this goal to be considered complete?

Followed by:

> What systems must change for those conditions to become true?

---

# 76. First Development Milestone

Do not attempt the full autonomous system immediately.

Build the persistent Brain first.

Milestone 1 (amended — MCP and hooks pulled forward, because Claude Code is the primary consumer):

```text
SQLite (WAL, FTS5)
+
schema
+
CLI
+
goal management
+
context storage
+
knowledge storage (with lifecycle)
+
project registry
+
work units
+
MCP server (thin wrapper over the same service layer)
+
session hooks (context injection)
+
brain backup
```

---

# 77. Phase 1 Implementation Scope

Implement:

```text
brain init

brain goal create

brain goal list

brain goal show

brain goal current

brain goal lock

brain goal complete

brain project add

brain project list

brain repo add

brain knowledge add

brain knowledge search

brain learning add

brain context get

brain work create

brain work update

brain decision add

brain knowledge verify

brain knowledge invalidate

brain backup

brain approval add

brain approval resolve

brain model recommend
```

Plus (amended — see §76, §79):

```text
Brain MCP server exposing the same service layer as brain_* tools

SessionStart / Stop hooks wrapping `brain context get` (§52.1)
```

Do not build automated execution yet.

---

# 78. Phase 2

Add:

```text
project scanner
repository scanner
automatic context resolution
failure tracking
verification tracking
goal resume
```

---

# 79. Phase 3

~~Add MCP~~ — **moved into Milestone 1** (§76). The CLI and MCP server wrap the same service layer from the start:

```text
Claude Code
   │            │
   ▼            ▼
Brain MCP    brain CLI
   │            │
   └── services ┘
         │
         ▼
      SQLite
```

Phase 3 instead: retire claude-mem (§2.4), optional one-time import of valuable claude-mem observations, and hybrid semantic search (FTS5 + embeddings/Qdrant behind the §17.3 interface).

---

# 80. Phase 4

Add autonomous Goal Intake.

Flow:

```text
user request
   ↓
brain_goal_create
   ↓
context resolution
   ↓
ambiguity detection
   ↓
clarification
   ↓
goal contract
```

---

# 81. Phase 5

Add autonomous planning.

Claude produces Work Units and stores them.

```text
goal
  ↓
planner
  ↓
work graph
```

---

# 82. Phase 6

Add execution engine.

Capabilities:

```text
filesystem
shell
git
npm
docker
ssh
browser
```

---

# 83. Phase 7

Add verification engine.

Verification types:

```text
unit test
integration test
build
lint
typecheck
health check
HTTP test
browser test
deployment check
database validation
manual assertion
```

---

# 84. Phase 8

Add learning engine.

After Goal completion:

```text
analyze goal
↓
extract reusable facts
↓
extract decisions
↓
extract failures
↓
extract successful fixes
↓
rank usefulness
↓
store knowledge
```

---

# 85. Phase 9

Add World Model.

Entities:

```text
machines
services
servers
databases
domains
networks
cloud resources
accounts
devices
```

---

# 86. Phase 10

Add Advanced Autonomy

Capabilities:

```text
multi-agent execution
parallel work units
cost tracking
policy engine
rollback plans
automatic deployment
automatic verification
scheduled maintenance goals
event-triggered goals
```

---

# 87. Recommended Initial Repository

```text
central-brain
```

Install:

```bash
mkdir central-brain

cd central-brain

npm init -y

npm install \
  better-sqlite3 \
  drizzle-orm \
  zod \
  commander \
  nanoid

npm install -D \
  typescript \
  tsx \
  @types/node \
  @types/better-sqlite3 \
  drizzle-kit \
  vitest
```

---

# 88. Initial package.json Scripts

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "brain": "tsx src/cli/index.ts",
    "test": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/database/migrate.ts"
  }
}
```

---

# 89. Initial Deliverable

The first usable version is complete when the following works:

```bash
brain init
```

then:

```bash
brain project add \
  --name central-brain \
  --path .
```

then:

```bash
brain goal create \
  "Implement project scanning"
```

then:

```bash
brain context get --current
```

then Claude can work on the goal and record:

```bash
brain work create

brain decision add

brain learning add

brain goal complete
```

At this point the Brain has persistent operational memory.

---

# 90. Bootstrap Strategy

There is an important self-referential advantage:

Once the basic Brain CLI exists, use Central Brain to build Central Brain.

Example:

```text
GOAL-001
Build Central Brain MVP
```

After Goal management works:

```text
GOAL-002
Implement automatic project scanning
```

After scanning works:

```text
GOAL-003
Add Claude Code MCP integration
```

Eventually the Brain becomes its own development manager.

---

# 91. First Real Goal

The first meaningful autonomous test should be something moderately complex but reversible.

Example:

> Add a `/health` command to Central Brain that validates SQLite connectivity, migrations, project registry integrity, and MCP configuration.

This tests:

```text
goal interpretation
planning
coding
database access
testing
verification
learning
```

---

# 92. Long-Term Target

The eventual experience should look like:

```text
USER

I want my personal AI service accessible remotely,
but only from my devices.
```

The Brain should independently determine:

```text
which machine runs it
which container hosts it
which port is exposed
what network exists
whether Tailscale is installed
whether Cloudflare is involved
what authentication exists
what firewall configuration exists
```

Then execute the necessary changes.

Another example:

```text
USER

Add a mobile frontend to my trading system.
```

Brain determines:

```text
existing APIs
authentication
frontend architecture
new application location
technology choice
API modifications
deployment
testing
```

The user expresses goals.

The Brain manages implementation.

---

# 93. North Star

The Brain should eventually behave like a combination of:

```text
Technical Architect
+
Engineering Manager
+
Senior Engineer
+
SRE
+
DevOps Engineer
+
System Administrator
+
Persistent Memory
```

while requiring the user primarily for:

```text
intent
preferences
business decisions
irreversible approvals
```

rather than implementation management.

---

# 94. Final Design Principles

1. Goals are the primary unit of interaction.

2. SQLite is the authoritative persistent Brain.

3. Claude is reasoning compute, not long-term memory.

4. Persistent Brain knowledge must not be scattered across Markdown files.

5. Ask clarification questions before implementation whenever possible.

6. Batch clarification questions.

7. Lock the Goal Contract before autonomous execution.

8. Once execution starts, solve implementation problems independently.

9. Plans are dynamic.

10. Goals may span multiple repositories, projects, machines, and services.

11. The Brain models systems using entities and relationships.

12. Decisions must be auditable.

13. Failures and successful solutions should become reusable knowledge.

14. Knowledge should be scoped, concise, confidence-rated, and freshness-aware.

15. Credentials should never be stored directly in Brain memory.

16. Every goal requires measurable Success Criteria.

17. Code completion does not equal Goal completion.

18. Verification is mandatory.

19. Autonomous decisions should follow explicit risk policies.

20. Irreversible operations require approval.

21. The Brain should continuously improve from experience.

22. The system should be able to resume work across sessions without handover Markdown.

23. The Brain must answer:

**What needs to become true?**

before asking:

**What code should change?**

24. The user specifies outcomes.

25. The Brain owns execution.

---

# 95. The Central Brain Principle

> **Do not ask the user to manage the implementation.**

> **Understand the desired outcome, establish sufficient clarity, then own the problem until the outcome is verified.**

That should remain the governing principle of the entire architecture.

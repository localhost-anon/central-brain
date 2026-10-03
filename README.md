# Central Brain

Persistent, goal-oriented memory and work ledger for [Claude Code](https://claude.com/claude-code).

Claude sessions forget everything when they end. Central Brain gives them one durable memory that every session, in every project, reads and writes:

- **Goals, not tasks.** Each piece of work is a goal with a locked contract: objective, scope, constraints and success criteria.
- **Evidence, not claims.** A goal completes only when each criterion has verified evidence and the converge report is clean.
- **Memory that compounds.** Decisions, failures and their fixes, learnings and project knowledge are stored, searched and reused.

It is a local SQLite database (`~/.central-brain/brain.db`) with a CLI, an MCP server for Claude Code, and session hooks that inject context automatically. There are no external services: search is hybrid full-text plus local ONNX embeddings.

The full design is in [ARCHITECTURE.md](ARCHITECTURE.md), and the agent operating rules are in [CLAUDE.md](CLAUDE.md).

## Quickstart

Requirements: Node.js 20+, Claude Code, and `jq` and `sqlite3` on `PATH` (used by the prompt hook).

```bash
git clone https://github.com/localhost-anon/central-brain.git ~/Projects/central-brain
cd ~/Projects/central-brain
npm install
npm run build
npm link            # optional: puts `brain` on your PATH
brain init          # creates ~/.central-brain/brain.db and applies migrations
```

The hook scripts assume the repo lives at `~/Projects/central-brain`. If you clone it somewhere else, edit the paths in `hooks/` and `bin/brain-claude`.

**Register the MCP server** so Claude Code can call the `brain_*` tools in every project:

```bash
claude mcp add --scope user central-brain -- node ~/Projects/central-brain/dist/mcp/server.js
```

**Wire the hooks** in `~/.claude/settings.json`:

| Event | Script | What it does |
|---|---|---|
| `SessionStart` | `hooks/session-start.sh` | Injects `brain context get` (active goal, decisions, knowledge, stale goals) |
| `UserPromptSubmit` | `hooks/user-prompt.sh` | Reminds the session to consult Brain first and names the active goal |
| `Stop`, `PreCompact` | `hooks/stop.sh` | Reminds the session to persist decisions, learnings and verification |

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "~/Projects/central-brain/hooks/session-start.sh" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/Projects/central-brain/hooks/user-prompt.sh" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "~/Projects/central-brain/hooks/stop.sh" }] }],
    "PreCompact":       [{ "hooks": [{ "type": "command", "command": "~/Projects/central-brain/hooks/stop.sh" }] }]
  }
}
```

Optionally, register your projects with `brain project scan ~/Projects`, and run `brain embed reindex` to enable semantic search. The first run downloads a small embedding model to `~/.central-brain/models`.

## How a goal flows

```
create → intake → lock → plan (work units) → start → work → verify → converge → complete
```

1. **Create.** Run `brain goal create "<title>" -o "<objective>"`.
2. **Intake.** Run `brain goal intake <id>`. It surfaces related memory and contract gaps, and asks two standing questions:
   - `review:behaviour`: which user-visible choices does this involve?
   - `review:coverage`: which areas still need contract lines? The areas are behaviour, data, failure modes, edge cases, non-functional, integration and completion.

   Sessions may add at most **5** material questions of their own, each with a recommended answer. Ask them in one batch.
3. **Lock.** Run `brain goal lock <id>`. Lock refuses unless:
   - the contract is complete;
   - every required success criterion states **one claim** and has a **verify method** (`test | command | api | inspection | manual`);
   - every applicable **principle** is acknowledged (see Principles below).
4. **Plan and start.** Create work units with `--serves <criterion ids>`. `brain goal start` refuses while any required criterion has no work unit serving it.
5. **Verify.** For each criterion, run `brain verify add … --verdict verified|partial|failed` with the real observed output. `partial` never counts as passing, and a `verified` verdict needs actual output plus a verification type that matches the criterion's verify method.
6. **Converge.** Run `brain goal converge <id>`. It lists typed findings:
   - missing, partial or contradicting evidence;
   - stale evidence (recorded before later work finished);
   - unfinished work;
   - open failures;
   - uncovered criteria.

   Fix them until it reports **converged**.
7. **Complete.** `brain goal complete <id>` refuses while CRITICAL or HIGH findings remain. `--force` needs `--reason`; the reason is recorded as a decision and the goal is permanently marked as force-completed. A goal that was never locked cannot complete without force.

**Failures** resolve only with a solution that has `--verdict verified` and a `--reproduction` note saying how the original symptom was re-checked. Passing tests alone count as `partial`.

**Principles** are durable rules stored as knowledge with category `principle`, scoped either GLOBAL or to a project (for example "sandbox first"). Link a goal to its project with `brain goal link-project`. Then acknowledge each principle with `brain principle ack`, either as `honoured` or as an `exception` with a reason; an exception is recorded as a decision.

**Rules versions.** Goals locked before these rules shipped stay on `rules_version 0` and keep the original, simpler completion check. Every goal locked afterwards gets `rules_version 1`.

**Staleness.** Open goals with no activity for `BRAIN_STALE_DAYS` (default 7) are skipped by `brain goal current` and listed at session start. Close them with `goal complete`, or retire them with `brain goal cancel <id> <reason>`.

## Command reference

`brain <group> --help` shows every option. Every command prints JSON.

| Group | Commands |
|---|---|
| Setup | `init`, `migrate` (snapshot, then apply pending migrations), `backup` (to `~/.central-brain/backups/`) |
| `goal` | `create`, `list`, `show`, `current`, `intake`, `set --risk/--autonomy`, `lock [--force --reason]`, `start`, `block`, `converge`, `complete [--force --reason]`, `cancel`, `resume`, `link-project` |
| `goal requirement` | `add <goalId> <text> --type <type> [--verify <method>] [--coverage <category>]`, `status` |
| `goal question` | `add [--detail] [--recommended <answer>]`, `answer [--as <type> --verify --coverage]`, `dismiss`, `list [--open]` |
| `principle` | `ack <goalId> <knowledgeId> honoured\|exception <note>` |
| `work` | `create <goalId> <title> [--serves <ids>] [--depends-on …]`, `update --status`, `list`, `ready` |
| `verify` | `add [--verdict verified\|partial\|failed] [--type] [--actual]`, `goal <goalId>` (verification state) |
| `failure` | `add`, `search`, `show`, `solution <id> <fix> --verdict … --reproduction …`, `resolve <id> <reason>` |
| `decision` | `add`, `list` |
| `observe` | `observe <text> [-g <goalId>]` |
| `approval` | `add`, `resolve` (gates for irreversible actions) |
| `knowledge` | `add`, `search`, `verify`, `invalidate`, `supersede` |
| `learning` | `add`, `search`, `useful` |
| `project` / `repo` | `project add\|list\|show\|scan`, `repo add\|list` |
| `context` | `get [--current] [--budget N]`, `search <query>` |
| `embed` | `reindex` (local ONNX embeddings; all searches are hybrid FTS + vector) |
| `import` | `claude-mem` (one-time, idempotent) |
| `model` | `recommend` (model tier for a goal); `bin/brain-claude` launches Claude Code with it |

The MCP server exposes the same operations as `brain_*` tools. Examples include `brain_goal_intake`, `brain_goal_converge`, `brain_principle_ack` and `brain_failure_solution_add`. Their descriptions carry the rules above, so sessions learn them from the tool list.

## Data and safety

- **Location.** The database is at `~/.central-brain/brain.db`. Override it with `BRAIN_DB`. The database never lives in the repo.
- **No secrets.** Do not store secrets in Brain. Reference environment variable or credential names instead.
- **No auto-migration.** Sessions never migrate the live database. After pulling schema changes, run `brain migrate`, which snapshots first. Until then, `context get` returns a "schema update pending" notice.
- **Check migrations on a copy.** `npx tsx scripts/check-migration-on-copy.ts` migrates a copy of your database and confirms all goals are unchanged.

## Development

```bash
npm test            # vitest (in-memory and temp-file databases only)
npx tsc --noEmit    # type check
npm run build       # compile to dist/
npm run db:generate # generate a drizzle migration after editing src/db/schema.ts
```

The code is organised as follows:

- `src/services/`: one module per concern.
- `src/services/contract-rules.ts`: every gate rule, as pure functions.
- `src/cli/` and `src/mcp/`: thin wrappers over the services.
- `drizzle/`: migrations. They must be additive.

## Contributing

`main` is protected. All changes, including the owner's, go through a pull request, and every PR needs the code owner's approval before it merges. Open a branch, keep `npm test` and `npx tsc --noEmit` green, and describe the outcome in the PR.

## License

[MIT](LICENSE)

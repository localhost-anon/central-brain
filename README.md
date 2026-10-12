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
| `ui` | `ui [--host --port --allow-ip]`, `ui install-agent [--dry-run]`, `ui uninstall-agent`, `ui agent-status` |

The MCP server exposes the same operations as `brain_*` tools. Examples include `brain_goal_intake`, `brain_goal_converge`, `brain_principle_ack` and `brain_failure_solution_add`. Their descriptions carry the rules above, so sessions learn them from the tool list.

## Web UI and phone access

`brain ui` starts a web UI. It lists goals, shows each goal's contract and live timeline, lets you answer worker questions and approve actions, and launches a headless Claude worker per goal.

**Projects.** The sidebar groups goals by project. On a phone, the ☰ button opens it as a drawer. A goal's project is set in these ways:

- A goal that you create through MCP or `brain goal create` links to the registered project that contains the current folder. `--project <name>` overrides it.
- You can change the project with the picker on the goal page, or with `brain goal set-project <id> <project|none>`.
- `brain project infer-goals [--dry-run]` links existing goals once. It uses paths in the contract, project-scoped records, the worker's folder, or a project name in the title. It never changes an existing link, and it leaves unclear goals in "Unassigned".

The UI listens on `127.0.0.1:4410`. It also listens on the Mac's **Tailscale IP**, `100.92.71.97` by default, while that address exists on a local interface (Tailscale is up). It never listens on `0.0.0.0`.

**Reach it from a phone.** Turn Tailscale on in the phone and open `http://100.92.71.97:4410`. Use the IP: the Host check accepts IP addresses only, not the MagicDNS name. The phone connects to the Mac directly over the tailnet, with no subnet router in the path, so it works on any network.

**Source-IP allowlist.** Only these addresses can connect:

| Address | Device |
|---|---|
| `127.0.0.1` | localhost |
| `100.92.71.97` | the Mac itself |
| `100.80.228.70` | the phone (`pankajs-s25-ultra`) |

Every other address gets `403`, and `~/.central-brain/logs/ui.log` records it as `refused <ip> …`. To add another device, pass its tailnet IP (`tailscale status`) with `--allow-ip`. `--allow-ip` replaces the default list, so repeat it for every device you want to keep.

Configure it with `--host <ip|none>`, `--port <n>` and `--allow-ip <ip>` (repeatable), or with the env vars `BRAIN_UI_HOST`, `BRAIN_UI_PORT` and `BRAIN_UI_ALLOW_IPS`.

> **No login.** Anything that can connect from an allowed address can launch auto-mode Claude workers on the Mac. The allowlist is the only gate. A Tailscale ACL that lets only the phone reach `100.92.71.97:4410` adds a second gate.

**Keep it running.** `brain ui install-agent` installs a launchd agent that starts `brain ui` at login and restarts it if it stops. The agent runs under `caffeinate -s`, so the Mac does not sleep while on AC power. Check it with `brain ui agent-status`, and remove it with `brain ui uninstall-agent`.

Install the agent from the checkout you run day to day, because the plist stores absolute paths to `node` and `dist/`. Run `install-agent` again after you upgrade Node or change any flag.

A MacBook still sleeps when you close the lid. To keep it awake with the lid closed, run `sudo pmset -a disablesleep 1` yourself, and use `sudo pmset -a disablesleep 0` to undo it. Brain never runs sudo.

**Phone pushes (ntfy).** `brain ui` sends a push to a self-hosted [ntfy](https://ntfy.sh) server when:

| Event | Priority |
|---|---|
| A worker waits for your answers or an approval | high |
| A worker finished | normal |
| A worker failed | high |
| A goal completed (also from terminal sessions) | normal |

A push shows the project, the goal title and the reason. It never shows question text, paths or logs. Tap it to open the goal. State that exists when the UI starts sends nothing, and a stopped worker sends nothing.

The notifier reads `~/.central-brain/ntfy.json` (keep it mode 600; it holds the token):

```json
{ "url": "http://100.95.99.70:2586", "topic": "brain", "token": "tk_…", "uiUrl": "http://100.92.71.97:4410" }
```

Without the file, the notifier is off and `ui.log` says `notifier off`. If ntfy is unreachable, the UI keeps running and logs `push failed`. There are no retries. Restart the agent after you change the file (`brain ui install-agent`).

**Chat with a worker.** Each goal page has a message box under the thread. Type a message and tap Send (Cmd/Ctrl+Enter on a keyboard). Messages are 1 to 4000 characters.

| Worker state | What happens to your message |
|---|---|
| Live, between turns | The worker gets it at once. |
| Mid-turn (working or waiting for an approval) | The worker gets it when the current turn ends. It goes before the automatic "continue" nudge. |
| Stopped, finished or failed | Brain resumes the last worker session with your message as the first input. |
| Never started | Brain starts a worker with the goal brief plus your message. |

The thread shows your messages as "You", the worker's full text replies, and tool calls as one-line events. It covers every run of the goal. A message sends no push. When a message cannot reach the worker (the process is gone, or it is still shutting down), the UI shows the error and Brain stores nothing.

On the phone, install the ntfy app, add the server URL, log in, and subscribe to the topic. The server in this setup is on the tailnet only, so pushes arrive while Tailscale is on.

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

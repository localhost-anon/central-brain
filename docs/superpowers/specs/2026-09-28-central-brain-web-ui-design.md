# Central Brain Web UI — Design

**Goal:** GOAL-2026-0010 · **Date:** 2026-09-28 · **Builds on:** Phase 4 goal intake (`docs/superpowers/specs/2026-09-28-central-brain-phase-4-goal-intake-design.md`), `ARCHITECTURE.md` §8–§12.

## 1. Outcome

A browser UI on this Mac where the user can see every Brain goal with its full details, submit a new goal, answer the goal's clarification questions and approve risky actions, and watch the goal's progress update live — while a Claude worker launched by the UI carries the goal out.

Success means:
- All goals are listable, filterable and searchable; a goal's detail shows its contract, criteria with verification evidence, questions, approvals, decisions, failures and a live timeline.
- Submitting a goal creates it, runs intake and launches a worker that follows the Brain rules.
- The worker's material questions (including `review:behaviour`) appear in the UI as one batch; answering them resumes the worker.
- Actions auto mode does not approve appear as approval cards; Allow/Deny reaches the worker.
- Brain records written by any process, and the worker's own activity, appear in the open UI within ~2 s without reloading.

## 2. Decisions taken during design

| Decision | Choice |
|---|---|
| What carries a goal out | The UI launches a headless Claude Code worker per goal |
| Access | This Mac only — server bound to `127.0.0.1` |
| Worker permissions | `--permission-mode auto`; prompts auto mode won't decide go to the UI as approval cards |
| Shape | Approach A: server inside the central-brain repo (`brain ui`), no-build static UI, SSE for live updates |
| Concurrency | One worker per goal; at most 2 running at once (configurable); extra starts are queued |

## 3. Architecture

```
browser (http://127.0.0.1:4410)
   │  JSON API + SSE (/api/events)
   ▼
brain ui ── src/web/server.ts ──┬── Brain services (goals, questions, intake, resume, search …) ── brain.db
                                ├── src/web/change-feed.ts  (SQLite data_version poll ~1 s)
                                └── src/workers/manager.ts ── spawns `claude -p` workers
                                                               │ worker → Brain MCP tools → brain.db
                                                               └ undecided permission prompts → server → UI
```

**Units:**
- `src/web/server.ts` — `node:http` on `127.0.0.1:4410` (port overridable with `--port`). Serves `web/` statically, the JSON API, and one SSE stream. Security: rejects any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard) and any non-GET whose `Origin` is not the UI's own origin (cross-site request guard).
- `src/web/api.ts` — route handlers calling existing services directly (no second data layer):
  - `GET /api/goals?status=&q=` — list (q uses hybrid search over goals)
  - `GET /api/goals/:id` — detail: goal, requirements, questions, approvals, decisions, failures, verification runs, worker runs, timeline
  - `POST /api/goals` — `{title, objective, projectId?, startWorker}` → create + intake (+ start worker)
  - `POST /api/questions/:id/answer` — `{answer, as?}`; `POST /api/questions/:id/dismiss` — `{reason}`
  - `POST /api/approvals/:id` — `{decision: 'allow'|'deny', note?}`
  - `POST /api/goals/:id/worker` — `{action: 'start'|'stop'|'resume'}`
  - `GET /api/projects` — registered projects for the submit form
  - `GET /api/needs-you` — all open material questions + pending approvals across goals
  - `GET /api/events` — SSE: `goal-changed {goalId}`, `worker-event {runId, goalId, event}`, `needs-you {count}`
- `src/web/change-feed.ts` — every ~1 s reads `PRAGMA data_version`; when it changes, diffs `goals.updated_at` plus max ids of questions/decisions/failures/verification_runs/approvals per goal and emits `goal-changed` for each affected goal. Catches writes from any process (worker MCP, CLI, other sessions).
- `src/workers/manager.ts` — worker lifecycle, stream-json parsing, permission routing, concurrency queue, resume.
- `src/workers/protocol.ts` — the only module that knows the stream-json message shapes (adapter; see §5 risk).
- `web/index.html`, `web/app.js`, `web/styles.css` — framework-free single-page UI.
- CLI: `brain ui [--port N] [--no-open]` starts the server, prints the URL, opens the browser unless `--no-open`.

## 4. Data model (one additive migration)

- `worker_runs`: `id` (text, `RUN-…`), `goal_id`, `session_id` (Claude session id, null until known), `status` (`queued|starting|working|waiting_answers|waiting_approval|completed|stopped|failed`), `cwd`, `pid`, `exit_reason`, `created_at`, `started_at`, `ended_at`.
- `worker_events`: `id`, `run_id`, `ts`, `kind` (`text|tool|result|system|error`), `summary` (≤ 300 chars, condensed — never full tool output), `detail` (nullable, ≤ 4 KB).
- `approvals` gains `run_id` (nullable), `tool_name`, `request_json` (the exact tool input), `decided_at`, `note`.

## 5. Worker lifecycle

**Launch** (on submit with "Start a worker", or Start/Resume):
- cwd = chosen project's `rootPath`, else `$HOME/Projects` (the worker locates the project itself).
- Command: `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode auto --permission-prompts host --append-system-prompt <worker rules>`; resume adds `--resume <session_id>`.
- Worker rules (system prompt): work only on goal `<id>`; follow the Brain rules in the user's global CLAUDE.md; ask every material question and the `review:behaviour` choices through `brain_question_add` and then end the turn — never answer them yourself; record decisions, failures, verifications; complete the goal only through `brain_goal_complete`.
- First user message: the goal id, title, objective and "run brain_goal_intake, then proceed".

**Question loop:** when a turn ends (`result` message) and the goal has open material questions, the run becomes `waiting_answers`. When the user resolves the last open material question in the UI, the server sends the next user message on the worker's stdin — "Your questions for <goal> are answered in Brain; read them with brain_question_list and continue." If the process has exited, the server resumes it by session id first.

**Approvals:** a permission request from the worker becomes an `approvals` row (`status pending`, `run_id`, `tool_name`, `request_json`, risk label derived from the tool: Bash/network/git-push/deploy → HIGH, file write outside cwd → MEDIUM, else MEDIUM). The run becomes `waiting_approval`. The user's Allow/Deny is written to the row and returned to the worker. No timeout.

**End states:** the run is `completed` when a turn ends and the goal is `COMPLETED`; `stopped` when the user stops it (SIGTERM, session id kept, resumable); `failed` on non-zero exit or crash, with `exit_reason`. If a turn ends with no open material questions and the goal not `COMPLETED`, the server sends one nudge ("continue until the goal is verified complete, or ask the user through Brain questions"); if the following turn also ends that way, the run becomes `stopped` with `exit_reason = 'stalled'` and is resumable.

**Concurrency:** one active run per goal; at most `maxWorkers` (default 2, `~/.central-brain/config.json` key `maxWorkers`) running; extra starts are `queued` and start FIFO.

**Server shutdown:** SIGTERM to all workers, runs marked `stopped` with session ids kept.

**Protocol risk:** the flags are confirmed on Claude Code 2.1.283; the exact stream-json shapes for host permission requests/responses are not. The plan's first task is a throwaway probe that records real messages to fixture files; `protocol.ts` is written against those fixtures. If the shapes differ from expectations only `protocol.ts` changes.

## 6. Screens

1. **Home** — "Needs you" strip (all open material questions and approval cards across goals; tab title `(N) Brain`); goals table (id, title, project, status, worker state with *Waiting for you* emphasised, criteria passed x/y, updated); status filter; hybrid search box; "New goal" button → form (title, objective, optional project, "Start a worker" default on).
2. **Goal detail** — header (status, risk, project, Start/Stop/Resume); contract (objective, scope, criteria with status + verification evidence, constraints/exclusions, answered Q&A); questions panel (answer box, "record as" select, Dismiss with reason, one "Send answers"); approvals panel (pending cards with exact tool + input, Allow/Deny; decided history); live timeline merging Brain records and worker events, newest at the bottom, auto-scrolling while at bottom.

**Live & errors:** SSE updates without reload; disconnect → "Disconnected — reconnecting…" banner with automatic reconnect; worker crash → `failed` + reason + Resume. `brain ui` is an explicit command, so it auto-migrates (with snapshot) on start.

## 7. Out of scope

Editing a locked contract; multiple users or login; network access beyond localhost; phone push notifications; charts; running workers on other machines.

## 8. Testing & verification

- **API:** in-process server on a random port against a temp DB — list/detail/create/answer/dismiss/approve/worker actions; Host and Origin guards reject bad requests.
- **Change feed:** a write through a second connection to the same file DB produces `goal-changed` for the right goal within 2 s.
- **Worker manager:** a fake `claude` executable replays probe fixtures — launch, question turn → `waiting_answers`, answers → resume message sent, permission request → approval row → allow/deny response written, exit/crash states, concurrency queue, resume by session id.
- **UI smoke:** Playwright against `brain ui` with the fake worker — create goal, see questions, answer, see timeline update, approve a card.
- **Live:** one real small goal submitted through the UI with a real worker, taken to completion; suite green, tsc clean, build clean.

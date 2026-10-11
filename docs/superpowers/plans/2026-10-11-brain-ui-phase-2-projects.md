# Brain UI Phase 2 — Projects and Mobile Layout

> Executed natively in one session in auto mode (user decision 43), followed by one fresh whole-branch review.

**Goal:** GOAL-2026-0071. Each goal shows its project. The UI filters goals by project. The layout works on a phone.

**Tech stack:** TypeScript strict ESM, `node:http`, commander, vitest, framework-free browser JS.

## Rules

- A goal's project is its first `goal_projects` link (rowid order).
- Setting a project replaces all the goal's links with that one project, or with none.
- A goal created through MCP or the CLI links to the project whose `root_path` is the longest prefix of the creating folder, on a path boundary. An explicit project wins.
- `brain project infer-goals` links existing goals once. It tries contract paths, then project-scoped records, then the worker's folder, then a project name in the title. It never overwrites a link. It leaves ties unassigned.
- No schema change. No ntfy (next phase).

## Backend (commit ba11f60)

- `src/services/goal-project.ts`: `goalProject`, `goalProjectMap`, `setGoalProject`, `projectForPath`, `linkGoalToCwd`, `inferGoalProjects`.
- `src/web/api.ts`:
  - each goal row and the goal detail carry `project`;
  - `GET /api/goals?project=<id>|unassigned`;
  - `POST /api/goals/:id/project {projectId|null}`;
  - a new goal links to its project, and its worker starts in the project folder.
- MCP `brain_goal_create` and CLI `goal create` take an optional project and auto-link.
- New CLI commands: `goal set-project <id> <project|none>` and `project infer-goals [--dry-run]`.

## Frontend

The layout follows ChatGPT:

- A sidebar lists the projects, with goal counts and a dot where something waits on you. Below 860px it becomes a drawer that the ☰ button opens.
- The home view is one column. Filter chips: Active, Needs you, Done, All. Rows show the title, the status, the project, criteria and age.
- The goal detail has a header with a project picker and worker buttons. Below it come the open approvals and questions, the contract (collapsed), and the timeline as a thread. Your answers sit on the right, worker messages on the left, and Brain events in the middle.
- A new goal is written in a composer. The project is preselected from the current project.
- Errors show as toasts.

The page keeps the existing behaviour: answers go in one batch, approvals are Allow/Deny, workers start/stop/resume, live updates protect drafts, and all server data is escaped.

## Verification

- API tests cover the project filter (criterion 256), auto-link (257) and the set-project endpoint (259).
- Playwright at 412x915 on a DB copy (260): no horizontal scroll, and the drawer, the filter, the picker and the composer all work.
- After the merge, the inference runs on the live DB (258) and the agent restarts.
- The user checks the result on the phone (261).

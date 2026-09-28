# Central Brain Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost web UI (`brain ui`) to view and search all Brain goals, submit new goals that launch a headless Claude worker, answer the worker's questions and approve its risky actions in the browser, and watch progress live — tracked as GOAL-2026-0010.

**Architecture:** A `node:http` server inside the central-brain repo calls the existing Brain services directly, serves a framework-free static UI from `web/`, and pushes live updates over one SSE stream fed by (a) a SQLite `data_version` change feed for writes from other processes and (b) a worker manager that spawns `claude -p` workers over the stream-json protocol, persists their activity, and routes permission prompts to UI approval cards.

**Tech Stack:** TypeScript ESM, drizzle-orm + better-sqlite3, node:http, node:child_process, commander, vitest, plain HTML/CSS/JS (no framework, no build). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-central-brain-web-ui-design.md`

## Global Constraints

- ESM only; relative imports carry `.js`. `npx tsc --noEmit` clean and full `npx vitest run` green before every commit (suite is 123/123 at `fbf16c1`).
- No new dependencies (runtime or dev).
- Server binds `127.0.0.1` only; default port `4410` (`--port` overrides). Allowed `Host` values: `127.0.0.1:<port>`, `localhost:<port>`. Non-GET requests must carry `Origin` `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- Worker command (confirmed by probe on Claude Code 2.1.283): `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode auto --permission-prompt-tool stdio --append-system-prompt <rules>` (+ `--resume <sessionId>` when resuming). First stdin line is `{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}`.
- Permission reply: `{"type":"control_response","response":{"subtype":"success","request_id":<id>,"response":{"behavior":"allow","updatedInput":<input>}}}` or `{..."response":{"behavior":"deny","message":<text>}}`.
- Run statuses exactly: `queued|starting|working|waiting_answers|waiting_approval|completed|stopped|failed`. Active = first five.
- `maxWorkers` default 2, from `~/.central-brain/config.json` key `maxWorkers`. One active run per goal.
- `worker_events.summary` ≤ 300 chars, `detail` ≤ 4096 chars (truncate, never reject).
- Risk label for approval cards: tool `Bash`, `WebFetch`, `WebSearch` → `HIGH`; everything else → `MEDIUM`.
- Tests never run the real `claude` binary and never open `~/.central-brain/brain.db`; workers are tested with `tests/fixtures/fake-claude.mjs`.
- Commit by path; message ends with blank line, `Goal: GOAL-2026-0010`, blank line, `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. The user answers the last two open questions in quick succession → the worker must receive exactly one "answers recorded, continue" message, not two. (Task 3 test.)
2. The UI server restarts while runs are `working` in the DB with no live process → those runs become `stopped` (exit reason `server restarted`) and are resumable, not stuck forever as `working`. (Task 3 test.)
3. An approval is decided after its worker process has died → the decision is recorded and nothing throws (no write to a closed stdin). (Task 3 test.)
4. An unknown or malformed goal id in the URL (`/api/goals/nope`) → 404 JSON, not a 500 or a crash. (Task 5 test.)
5. A worker prints a non-JSON line or a tool result of hundreds of KB → the line is ignored / the event truncated; the run keeps going. (Tasks 1–2 tests.)

---

### Task 1: Schema + worker store

**Files:**
- Modify: `src/db/schema.ts` (append two tables; extend `approvals`)
- Create: generated migration under `drizzle/` (via `npx drizzle-kit generate`)
- Create: `src/services/workers.ts`
- Test: `tests/workers-store.test.ts`

**Interfaces:**
- Produces (from `src/db/schema.js`): `workerRuns`, `workerEvents`; `approvals` gains `runId`, `requestId`, `toolName`, `requestJson`, `note`.
- Produces (from `src/services/workers.js`): `type WorkerRun`, `type WorkerEvent`, `type RunStatus`, `ACTIVE_RUN_STATUSES: readonly RunStatus[]`, `createRun(db, {goalId, cwd}): WorkerRun`, `getRun(db, id): WorkerRun`, `updateRun(db, id, patch): WorkerRun`, `listRuns(db, goalId): WorkerRun[]` (newest first), `activeRunForGoal(db, goalId): WorkerRun | undefined`, `queuedRuns(db): WorkerRun[]` (oldest first), `addEvent(db, runId, {kind, summary, detail?}): WorkerEvent`, `listEvents(db, runId, {limit?}): WorkerEvent[]` (oldest first, last `limit`), `riskForTool(toolName): 'HIGH'|'MEDIUM'`, `createPermissionApproval(db, {goalId, runId, requestId, toolName, input, description}): Approval`, `pendingApprovals(db, goalId?): Approval[]`, `decidePermission(db, id, decision: 'allow'|'deny', note?): Approval`.

- [ ] **Step 1: Write the failing tests** — `tests/workers-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal } from '../src/services/goals.js';
import {
  createRun, getRun, updateRun, listRuns, activeRunForGoal, queuedRuns, addEvent, listEvents,
  riskForTool, createPermissionApproval, pendingApprovals, decidePermission,
} from '../src/services/workers.js';

describe('worker store', () => {
  it('creates queued runs, tracks the active run, orders queue oldest first', () => {
    const db = createTestDb();
    const g1 = createGoal(db, { title: 'a', objective: 'a' });
    const g2 = createGoal(db, { title: 'b', objective: 'b' });
    const r1 = createRun(db, { goalId: g1.id, cwd: '/tmp' });
    const r2 = createRun(db, { goalId: g2.id, cwd: '/tmp' });
    expect(r1).toMatchObject({ status: 'queued', goalId: g1.id, cwd: '/tmp', sessionId: null });
    expect(r1.id).toMatch(/^RUN-/);
    expect(queuedRuns(db).map(r => r.id)).toEqual([r1.id, r2.id]);
    updateRun(db, r1.id, { status: 'working', sessionId: 's-1', pid: 42 });
    expect(activeRunForGoal(db, g1.id)?.id).toBe(r1.id);
    updateRun(db, r1.id, { status: 'completed', endedAt: new Date().toISOString() });
    expect(activeRunForGoal(db, g1.id)).toBeUndefined();
    expect(getRun(db, r1.id).sessionId).toBe('s-1');
    expect(listRuns(db, g1.id)).toHaveLength(1);
    expect(() => updateRun(db, r1.id, { status: 'bogus' as never })).toThrow(/status/);
  });

  it('truncates event summary/detail and returns the last N events oldest first (Review Focus 5)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'a', objective: 'a' });
    const r = createRun(db, { goalId: g.id, cwd: '/tmp' });
    const e = addEvent(db, r.id, { kind: 'tool', summary: 'x'.repeat(1000), detail: 'y'.repeat(500_000) });
    expect(e.summary.length).toBe(300);
    expect(e.detail!.length).toBe(4096);
    for (let i = 0; i < 5; i++) addEvent(db, r.id, { kind: 'text', summary: `m${i}` });
    expect(listEvents(db, r.id, { limit: 2 }).map(x => x.summary)).toEqual(['m3', 'm4']);
  });

  it('permission approvals: risk label, pending list, allow/deny once', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'a', objective: 'a' });
    const r = createRun(db, { goalId: g.id, cwd: '/tmp' });
    expect(riskForTool('Bash')).toBe('HIGH');
    expect(riskForTool('WebFetch')).toBe('HIGH');
    expect(riskForTool('Edit')).toBe('MEDIUM');
    const a = createPermissionApproval(db, {
      goalId: g.id, runId: r.id, requestId: 'req-1', toolName: 'Bash',
      input: { command: 'git push' }, description: 'Push branch',
    });
    expect(a).toMatchObject({ status: 'pending', riskLevel: 'HIGH', runId: r.id, requestId: 'req-1', toolName: 'Bash' });
    expect(a.action).toContain('git push');
    expect(JSON.parse(a.requestJson!)).toEqual({ command: 'git push' });
    expect(pendingApprovals(db, g.id)).toHaveLength(1);
    const d = decidePermission(db, a.id, 'deny', 'not now');
    expect(d).toMatchObject({ status: 'denied', note: 'not now' });
    expect(d.resolvedAt).not.toBeNull();
    expect(pendingApprovals(db)).toHaveLength(0);
    expect(() => decidePermission(db, a.id, 'allow')).toThrow(/already/);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/workers-store.test.ts 2>&1 | tail -15` — FAIL (module missing).

- [ ] **Step 3: Schema.** In `src/db/schema.ts`, add to the `approvals` table (after `resolvedAt`):

```ts
  runId: text('run_id'),
  requestId: text('request_id'),
  toolName: text('tool_name'),
  requestJson: text('request_json'),
  note: text('note'),
```

and append:

```ts
export const workerRuns = sqliteTable('worker_runs', {
  id: text('id').primaryKey(),
  goalId: text('goal_id').notNull().references(() => goals.id),
  sessionId: text('session_id'),
  status: text('status').notNull().default('queued'),
  cwd: text('cwd').notNull(),
  pid: integer('pid'),
  exitReason: text('exit_reason'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  endedAt: text('ended_at'),
});

export const workerEvents = sqliteTable('worker_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull().references(() => workerRuns.id),
  ts: text('ts').notNull(),
  kind: text('kind').notNull(),
  summary: text('summary').notNull(),
  detail: text('detail'),
});
```

Then `npx drizzle-kit generate 2>&1 | tail -5`; confirm the new SQL has `CREATE TABLE worker_runs`, `CREATE TABLE worker_events` and five `ALTER TABLE approvals ADD` statements only. (The spec's `decided_at` is served by the existing `resolved_at`; `request_id` is added because the worker reply must echo it.)

- [ ] **Step 4: Implement** `src/services/workers.ts`:

```ts
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { BrainDb } from '../db/connection.js';
import { approvals, workerEvents, workerRuns } from '../db/schema.js';
import type { Approval } from './decisions.js';

export type WorkerRun = typeof workerRuns.$inferSelect;
export type WorkerEvent = typeof workerEvents.$inferSelect;
export const RUN_STATUSES = [
  'queued', 'starting', 'working', 'waiting_answers', 'waiting_approval', 'completed', 'stopped', 'failed',
] as const;
export type RunStatus = typeof RUN_STATUSES[number];
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'starting', 'working', 'waiting_answers', 'waiting_approval'];

const now = () => new Date().toISOString();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function createRun(db: BrainDb, input: { goalId: string; cwd: string }): WorkerRun {
  const id = `RUN-${nanoid(10)}`;
  db.insert(workerRuns).values({ id, goalId: input.goalId, cwd: input.cwd, status: 'queued', createdAt: now() }).run();
  return getRun(db, id);
}

export function getRun(db: BrainDb, id: string): WorkerRun {
  const r = db.select().from(workerRuns).where(eq(workerRuns.id, id)).get();
  if (!r) throw new Error(`Worker run not found: ${id}`);
  return r;
}

export function updateRun(
  db: BrainDb, id: string,
  patch: Partial<Pick<WorkerRun, 'status' | 'sessionId' | 'pid' | 'exitReason' | 'startedAt' | 'endedAt'>>,
): WorkerRun {
  if (patch.status !== undefined && !(RUN_STATUSES as readonly string[]).includes(patch.status)) {
    throw new Error(`Invalid run status: ${patch.status}`);
  }
  db.update(workerRuns).set(patch).where(eq(workerRuns.id, id)).run();
  return getRun(db, id);
}

export function listRuns(db: BrainDb, goalId: string): WorkerRun[] {
  return db.select().from(workerRuns).where(eq(workerRuns.goalId, goalId)).orderBy(desc(workerRuns.createdAt)).all();
}

export function activeRunForGoal(db: BrainDb, goalId: string): WorkerRun | undefined {
  return db.select().from(workerRuns)
    .where(and(eq(workerRuns.goalId, goalId), inArray(workerRuns.status, [...ACTIVE_RUN_STATUSES])))
    .orderBy(desc(workerRuns.createdAt)).get();
}

export function queuedRuns(db: BrainDb): WorkerRun[] {
  return db.select().from(workerRuns).where(eq(workerRuns.status, 'queued')).orderBy(asc(workerRuns.createdAt)).all();
}

export function addEvent(db: BrainDb, runId: string, e: { kind: string; summary: string; detail?: string }): WorkerEvent {
  const res = db.insert(workerEvents).values({
    runId, ts: now(), kind: e.kind, summary: clip(e.summary, 300),
    detail: e.detail === undefined ? null : clip(e.detail, 4096),
  }).run();
  return db.select().from(workerEvents).where(eq(workerEvents.id, Number(res.lastInsertRowid))).get()!;
}

export function listEvents(db: BrainDb, runId: string, opts: { limit?: number } = {}): WorkerEvent[] {
  const rows = db.select().from(workerEvents).where(eq(workerEvents.runId, runId))
    .orderBy(desc(workerEvents.id)).limit(opts.limit ?? 200).all();
  return rows.reverse();
}

export function riskForTool(toolName: string): 'HIGH' | 'MEDIUM' {
  return ['Bash', 'WebFetch', 'WebSearch'].includes(toolName) ? 'HIGH' : 'MEDIUM';
}

export function createPermissionApproval(db: BrainDb, input: {
  goalId: string; runId: string; requestId: string; toolName: string;
  input: Record<string, unknown>; description?: string;
}): Approval {
  const detail = typeof input.input.command === 'string' ? input.input.command
    : typeof input.input.file_path === 'string' ? input.input.file_path : JSON.stringify(input.input);
  const res = db.insert(approvals).values({
    goalId: input.goalId, runId: input.runId, requestId: input.requestId, toolName: input.toolName,
    requestJson: JSON.stringify(input.input), riskLevel: riskForTool(input.toolName),
    action: clip(`${input.toolName}: ${input.description ? `${input.description} — ` : ''}${detail}`, 500),
    requestedAt: now(),
  }).run();
  return db.select().from(approvals).where(eq(approvals.id, Number(res.lastInsertRowid))).get()!;
}

export function pendingApprovals(db: BrainDb, goalId?: string): Approval[] {
  const conds = [eq(approvals.status, 'pending'), isNotNull(approvals.runId)];
  if (goalId) conds.push(eq(approvals.goalId, goalId));
  return db.select().from(approvals).where(and(...conds)).orderBy(asc(approvals.id)).all();
}

export function decidePermission(db: BrainDb, id: number, decision: 'allow' | 'deny', note?: string): Approval {
  const a = db.select().from(approvals).where(eq(approvals.id, id)).get();
  if (!a) throw new Error(`Approval not found: ${id}`);
  if (a.status !== 'pending') throw new Error(`Approval #${id} is already ${a.status}.`);
  db.update(approvals).set({
    status: decision === 'allow' ? 'approved' : 'denied', resolvedAt: now(), note: note ?? null,
  }).where(eq(approvals.id, id)).run();
  return db.select().from(approvals).where(eq(approvals.id, id)).get()!;
}
```

- [ ] **Step 5: Run** `npx vitest run tests/workers-store.test.ts 2>&1 | tail -8` (3 pass), full suite, `npx tsc --noEmit 2>&1 | tail -5`.

- [ ] **Step 6: Commit** `src/db/schema.ts drizzle src/services/workers.ts tests/workers-store.test.ts` — `feat: worker runs, events and permission approvals store`.

---

### Task 2: Worker protocol adapter (pure)

**Files:**
- Create: `src/workers/protocol.ts`
- Test: `tests/worker-protocol.test.ts`

**Interfaces:**
- Produces (from `src/workers/protocol.js`): `workerArgs({systemPrompt, resumeSessionId?}): string[]`; `initializeRequest(): object`; `userMessage(text): object`; `permissionResponse(requestId, decision, input, message?): object`; `type WorkerMessage` (union below); `parseWorkerLine(line): WorkerMessage`; `eventsFor(msg): {kind, summary, detail?}[]`; `workerSystemPrompt(goalId): string`; `firstMessage(goal: {id, title, objective}): string`; `answersMessage(goalId): string`; `nudgeMessage(goalId): string`; `resumeMessage(goalId): string`.

- [ ] **Step 1: Write the failing tests** — `tests/worker-protocol.test.ts` (lines are trimmed copies of real probe output):

```ts
import { describe, it, expect } from 'vitest';
import {
  workerArgs, initializeRequest, userMessage, permissionResponse, parseWorkerLine, eventsFor,
  workerSystemPrompt, firstMessage,
} from '../src/workers/protocol.js';

const INIT = '{"type":"system","subtype":"init","session_id":"0ed7ff10","cwd":"/x","tools":["Bash"]}';
const HOOK = '{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}';
const PERM = '{"type":"control_request","request_id":"50b1","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"touch probe-file.txt","description":"Create empty probe file"},"description":"Create empty probe file","tool_use_id":"toolu_01"}}';
const ASSIST = '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"Running it now."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}},{"type":"tool_use","id":"t2","name":"mcp__central-brain__brain_goal_intake","input":{"id":"GOAL-1"}},{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"/p/js/app.js"}}]}}';
const TOOLRES = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"User denied this in the Brain UI."}]}}';
const RESULT = '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"session_id":"0ed7ff10","result":"Done."}';

describe('worker protocol', () => {
  it('builds the confirmed launch args, with --resume only when resuming', () => {
    const a = workerArgs({ systemPrompt: 'RULES' });
    expect(a).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'auto', '--permission-prompt-tool', 'stdio', '--append-system-prompt', 'RULES']);
    expect(workerArgs({ systemPrompt: 'R', resumeSessionId: 's1' }).slice(-2)).toEqual(['--resume', 's1']);
  });

  it('builds stdin messages', () => {
    expect(initializeRequest()).toEqual({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });
    expect(userMessage('hi')).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(permissionResponse('r1', 'allow', { command: 'x' })).toEqual({ type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'x' } } } });
    expect(permissionResponse('r1', 'deny', {}, 'no')).toEqual({ type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: 'no' } } });
  });

  it('parses the message kinds and ignores noise and non-JSON (Review Focus 5)', () => {
    expect(parseWorkerLine(INIT)).toEqual({ kind: 'init', sessionId: '0ed7ff10' });
    expect(parseWorkerLine(HOOK)).toEqual({ kind: 'ignored' });
    expect(parseWorkerLine('warning: something odd')).toEqual({ kind: 'ignored' });
    expect(parseWorkerLine('')).toEqual({ kind: 'ignored' });
    expect(parseWorkerLine(PERM)).toEqual({ kind: 'permission', requestId: '50b1', toolName: 'Bash',
      input: { command: 'touch probe-file.txt', description: 'Create empty probe file' }, description: 'Create empty probe file' });
    const a = parseWorkerLine(ASSIST);
    expect(a).toEqual({ kind: 'assistant', texts: ['Running it now.'], tools: [
      { name: 'Bash', input: { command: 'npm test' } },
      { name: 'mcp__central-brain__brain_goal_intake', input: { id: 'GOAL-1' } },
      { name: 'Edit', input: { file_path: '/p/js/app.js' } }] });
    expect(parseWorkerLine(TOOLRES)).toEqual({ kind: 'tool_result', isError: true, text: 'User denied this in the Brain UI.' });
    expect(parseWorkerLine(RESULT)).toEqual({ kind: 'result', sessionId: '0ed7ff10', isError: false, text: 'Done.' });
  });

  it('turns messages into readable timeline events', () => {
    expect(eventsFor(parseWorkerLine(ASSIST)).map(e => e.summary)).toEqual([
      'Running it now.', 'Bash: npm test', 'brain_goal_intake', 'Edit: /p/js/app.js']);
    expect(eventsFor(parseWorkerLine(TOOLRES))[0]).toMatchObject({ kind: 'error' });
    expect(eventsFor(parseWorkerLine(RESULT))[0]).toMatchObject({ kind: 'result', summary: 'Turn finished' });
    expect(eventsFor(parseWorkerLine(PERM))[0].summary).toBe('Waiting for approval — Bash: touch probe-file.txt');
    expect(eventsFor({ kind: 'ignored' })).toEqual([]);
  });

  it('worker rules forbid answering material questions itself', () => {
    const p = workerSystemPrompt('GOAL-2026-0099');
    expect(p).toContain('GOAL-2026-0099');
    expect(p).toContain('brain_question_add');
    expect(p).toMatch(/never answer/i);
    expect(firstMessage({ id: 'GOAL-1', title: 'T', objective: 'O' })).toContain('brain_goal_intake');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/worker-protocol.test.ts 2>&1 | tail -15` — FAIL.

- [ ] **Step 3: Implement** `src/workers/protocol.ts`:

```ts
// The only module that knows Claude Code's stream-json shapes (confirmed by probe, Claude Code 2.1.283).

export type WorkerMessage =
  | { kind: 'init'; sessionId: string }
  | { kind: 'permission'; requestId: string; toolName: string; input: Record<string, unknown>; description?: string }
  | { kind: 'assistant'; texts: string[]; tools: { name: string; input: Record<string, unknown> }[] }
  | { kind: 'tool_result'; isError: boolean; text: string }
  | { kind: 'result'; sessionId: string; isError: boolean; text: string }
  | { kind: 'ignored' };

export function workerArgs(opts: { systemPrompt: string; resumeSessionId?: string }): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'auto', '--permission-prompt-tool', 'stdio',
    '--append-system-prompt', opts.systemPrompt,
    ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
  ];
}

export const initializeRequest = () => ({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });
export const userMessage = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

export function permissionResponse(
  requestId: string, decision: 'allow' | 'deny', input: Record<string, unknown>, message?: string,
) {
  const response = decision === 'allow'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: message ?? 'The user denied this in the Brain UI.' };
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

const asText = (c: unknown): string =>
  typeof c === 'string' ? c
    : Array.isArray(c) ? c.map(x => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : '')).join('')
    : '';

export function parseWorkerLine(line: string): WorkerMessage {
  let m: any;
  try { m = JSON.parse(line); } catch { return { kind: 'ignored' }; }
  if (!m || typeof m !== 'object') return { kind: 'ignored' };
  if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
    return { kind: 'init', sessionId: m.session_id };
  }
  if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
    return {
      kind: 'permission', requestId: String(m.request_id), toolName: String(m.request.tool_name),
      input: (m.request.input ?? {}) as Record<string, unknown>,
      ...(m.request.description ? { description: String(m.request.description) } : {}),
    };
  }
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    const texts: string[] = [];
    const tools: { name: string; input: Record<string, unknown> }[] = [];
    for (const c of m.message.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) texts.push(c.text.trim());
      if (c?.type === 'tool_use') tools.push({ name: String(c.name), input: (c.input ?? {}) as Record<string, unknown> });
    }
    return { kind: 'assistant', texts, tools };
  }
  if (m.type === 'user' && Array.isArray(m.message?.content)) {
    const r = m.message.content.find((c: any) => c?.type === 'tool_result');
    if (r) return { kind: 'tool_result', isError: Boolean(r.is_error), text: asText(r.content) };
    return { kind: 'ignored' };
  }
  if (m.type === 'result') {
    return { kind: 'result', sessionId: String(m.session_id ?? ''), isError: Boolean(m.is_error), text: String(m.result ?? '') };
  }
  return { kind: 'ignored' };
}

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name.startsWith('mcp__central-brain__')) return name.replace('mcp__central-brain__', '');
  const target = typeof input.command === 'string' ? input.command
    : typeof input.file_path === 'string' ? input.file_path
    : typeof input.pattern === 'string' ? input.pattern
    : typeof input.url === 'string' ? input.url : '';
  return target ? `${name}: ${target}` : name;
}

export function eventsFor(msg: WorkerMessage): { kind: string; summary: string; detail?: string }[] {
  switch (msg.kind) {
    case 'init': return [{ kind: 'system', summary: 'Worker session started' }];
    case 'permission':
      return [{ kind: 'system', summary: `Waiting for approval — ${describeTool(msg.toolName, msg.input)}`, detail: JSON.stringify(msg.input) }];
    case 'assistant':
      return [
        ...msg.texts.map(t => ({ kind: 'text', summary: t, detail: t })),
        ...msg.tools.map(t => ({ kind: 'tool', summary: describeTool(t.name, t.input), detail: JSON.stringify(t.input) })),
      ];
    case 'tool_result':
      return msg.isError ? [{ kind: 'error', summary: msg.text || 'Tool failed', detail: msg.text }] : [];
    case 'result':
      return [{ kind: 'result', summary: msg.isError ? 'Turn ended with an error' : 'Turn finished', detail: msg.text }];
    default: return [];
  }
}

export function workerSystemPrompt(goalId: string): string {
  return [
    `You are a Central Brain worker launched from the Brain web UI to carry out goal ${goalId}. Work only on this goal.`,
    'Follow the Central Brain rules in the global CLAUDE.md: run brain_goal_intake, fill contract gaps you can discover, and record decisions, failures and verifications as you go.',
    'Never answer material questions or the review:behaviour question yourself. For every behaviour choice a user would notice and every other material question, call brain_question_add (or leave the intake question open), then END YOUR TURN. The user answers in the Brain UI; you will be told when to continue.',
    'Stay inside the locked scope. Pushes, deploys, data deletion and production changes need the user\'s explicit OK — ask through a Brain question.',
    'Finish only through brain_verification_record for each success criterion followed by brain_goal_complete.',
  ].join('\n');
}

export const firstMessage = (g: { id: string; title: string; objective: string }) =>
  `Carry out Brain goal ${g.id}: "${g.title}". Objective: ${g.objective}\nStart with brain_goal_resume and brain_goal_intake for ${g.id}, then proceed.`;
export const answersMessage = (goalId: string) =>
  `Your questions for ${goalId} have been answered in Brain. Read them with brain_question_list (goalId ${goalId}) and continue.`;
export const nudgeMessage = (goalId: string) =>
  `Continue ${goalId} until it is verified complete, or ask the user through Brain questions and end your turn.`;
export const resumeMessage = (goalId: string) =>
  `Resume work on ${goalId}: run brain_goal_resume, check for answered questions, and continue.`;
```

- [ ] **Step 4: Run** `npx vitest run tests/worker-protocol.test.ts 2>&1 | tail -8` (5 pass), full suite, tsc.

- [ ] **Step 5: Commit** `src/workers/protocol.ts tests/worker-protocol.test.ts` — `feat: stream-json worker protocol adapter`.

---

### Task 3: Worker manager

**Files:**
- Create: `src/workers/manager.ts`
- Create: `tests/fixtures/fake-claude.mjs`
- Test: `tests/worker-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 store; Task 2 protocol; `getGoal`, `openMaterialQuestions` from `src/services/goals.js`.
- Produces (from `src/workers/manager.js`): `interface WorkerControl { start(goalId: string, opts?: { cwd?: string }): WorkerRun; stop(runId: string): WorkerRun; resume(goalId: string): WorkerRun; answersUpdated(goalId: string): void; decide(approvalId: number, decision: 'allow'|'deny', note?: string): Approval; stopAll(): void }`; `type ManagerEvent = { type: 'run-changed'; goalId: string; runId: string; status: string } | { type: 'worker-event'; goalId: string; runId: string; event: WorkerEvent } | { type: 'approval'; goalId: string; runId: string; approvalId: number }`; `class WorkerManager implements WorkerControl` with `constructor(db, opts: { command?: string[]; maxWorkers?: number; defaultCwd: string; onEvent?: (e: ManagerEvent) => void })`, `runningCount(): number`; `readMaxWorkers(configPath?): number`.

- [ ] **Step 1: Fake worker** — `tests/fixtures/fake-claude.mjs` (behaviour chosen by env `FAKE_SCENARIO`; logs argv and every stdin line to `FAKE_LOG`):

```js
import fs from 'node:fs';
import readline from 'node:readline';

const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const scenario = process.env.FAKE_SCENARIO ?? 'stall';
log({ argv: process.argv.slice(2) });
let turn = 0;
let pending = null;

const result = () => out({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session-1', result: `turn ${turn}` });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type === 'control_response' && pending) {
    const denied = m.response.response.behavior === 'deny';
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: denied, content: denied ? m.response.response.message : 'ok' }] } });
    pending = null; result(); return;
  }
  if (m.type !== 'user') return;
  turn += 1;
  if (turn === 1) out({ type: 'system', subtype: 'init', session_id: 'fake-session-1' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `working turn ${turn}` }] } });
  out('not json at all');
  if (scenario === 'crash') { process.exit(3); }
  if (scenario === 'permission' && turn === 1) {
    pending = 'r-1';
    out({ type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push' }, description: 'Push' } });
    return;
  }
  result();
});
process.stdin.on('end', () => process.exit(0));
```

Note: `out('not json at all')` writes the JSON string `"not json at all"` — a valid JSON line that is not an object/known type; it exercises the ignore path. The manager must also tolerate truly non-JSON lines (covered in Task 2).

- [ ] **Step 2: Write the failing tests** — `tests/worker-manager.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, makeLockable } from './helpers.js';
import { createGoal, completeGoal, lockGoal, getGoal } from '../src/services/goals.js';
import { addQuestion, answerQuestion, listQuestions } from '../src/services/questions.js';
import { getRun, listRuns, createRun, updateRun, listEvents, pendingApprovals } from '../src/services/workers.js';
import { WorkerManager, readMaxWorkers, type ManagerEvent } from '../src/workers/manager.js';

const FAKE = path.join(process.cwd(), 'tests', 'fixtures', 'fake-claude.mjs');
const managers: WorkerManager[] = [];

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

function setup(scenario: string, maxWorkers = 2) {
  const db = createTestDb();
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fake-')), 'log.jsonl');
  process.env.FAKE_SCENARIO = scenario;
  process.env.FAKE_LOG = logFile;
  const events: ManagerEvent[] = [];
  const m = new WorkerManager(db, {
    command: [process.execPath, FAKE], maxWorkers, defaultCwd: os.tmpdir(), onEvent: e => events.push(e),
  });
  managers.push(m);
  const sent = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  return { db, m, events, sent };
}

afterEach(() => { for (const m of managers.splice(0)) m.stopAll(); });

describe('worker manager', () => {
  it('launches with the protocol args, records session + events, waits for answers, resumes once (Review Focus 1)', async () => {
    const { db, m, sent } = setup('stall');
    const g = createGoal(db, { title: 'SSO', objective: 'login' });
    const q1 = addQuestion(db, g.id, { question: 'Keep passwords?' });
    const q2 = addQuestion(db, g.id, { question: 'Provision users?' });
    const run = m.start(g.id);
    const waiting = await waitFor(() => { const r = getRun(db, run.id); return r.status === 'waiting_answers' && r; });
    expect(waiting.sessionId).toBe('fake-session-1');
    expect(sent()[0].argv).toContain('--permission-prompt-tool');
    expect(sent()[1]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
    expect(sent()[2].message.content).toContain(g.id);
    expect(listEvents(db, run.id).map(e => e.summary)).toContain('working turn 1');
    answerQuestion(db, q1.id, 'yes');
    m.answersUpdated(g.id);                 // still one open → no message
    answerQuestion(db, q2.id, 'no');
    m.answersUpdated(g.id);
    m.answersUpdated(g.id);                 // duplicate call → must not send twice
    await waitFor(() => getRun(db, run.id).status !== 'working' && sent().filter(s => s.type === 'user').length >= 2);
    const userMsgs = sent().filter(s => s.type === 'user').map(s => s.message.content);
    expect(userMsgs.filter(t => t.includes('have been answered'))).toHaveLength(1);
  });

  it('completes when a turn ends with the goal COMPLETED', async () => {
    const { db, m } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id); lockGoal(db, g.id); completeGoal(db, g.id, { force: true });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'completed');
    expect(getRun(db, run.id).endedAt).not.toBeNull();
  });

  it('nudges once, then stops a stalled run as resumable', async () => {
    const { db, m, sent } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'stopped');
    expect(getRun(db, run.id).exitReason).toBe('stalled');
    expect(sent().filter(s => s.type === 'user' && String(s.message.content).includes('until it is verified complete'))).toHaveLength(1);
  });

  it('routes a permission prompt to an approval and returns the decision', async () => {
    const { db, m, sent, events } = setup('permission');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'waiting_approval');
    const [a] = pendingApprovals(db, g.id);
    expect(a).toMatchObject({ toolName: 'Bash', riskLevel: 'HIGH', requestId: 'r-1', runId: run.id });
    expect(events.some(e => e.type === 'approval' && e.approvalId === a.id)).toBe(true);
    m.decide(a.id, 'deny', 'no pushes');
    const reply = await waitFor(() => sent().find(s => s.type === 'control_response'));
    expect(reply.response).toMatchObject({ request_id: 'r-1', response: { behavior: 'deny', message: 'no pushes' } });
    await waitFor(() => listEvents(db, run.id).some(e => e.kind === 'error' && e.summary.includes('no pushes')));
  });

  it('marks a crashed worker failed with the exit reason', async () => {
    const { db, m } = setup('crash');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'failed');
    expect(getRun(db, run.id).exitReason).toMatch(/exit code 3/);
  });

  it('queues beyond maxWorkers and refuses a second run for the same goal', async () => {
    const { db, m } = setup('permission', 1);
    const g1 = createGoal(db, { title: 'a', objective: 'a' });
    const g2 = createGoal(db, { title: 'b', objective: 'b' });
    const r1 = m.start(g1.id);
    const r2 = m.start(g2.id);
    await waitFor(() => getRun(db, r1.id).status === 'waiting_approval');
    expect(getRun(db, r2.id).status).toBe('queued');
    expect(() => m.start(g1.id)).toThrow(/already has an active worker/);
    m.stop(r1.id);
    await waitFor(() => getRun(db, r2.id).status === 'waiting_approval');
  });

  it('resume relaunches with --resume <sessionId>', async () => {
    const { db, m, sent } = setup('stall');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'stopped');
    const again = m.resume(g.id);
    expect(again.id).toBe(run.id);
    await waitFor(() => sent().filter(s => s.argv).length === 2);
    expect(sent().filter(s => s.argv)[1].argv.slice(-2)).toEqual(['--resume', 'fake-session-1']);
  });

  it('on construction, orphaned active runs become stopped/resumable (Review Focus 2)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = createRun(db, { goalId: g.id, cwd: '/tmp' });
    updateRun(db, r.id, { status: 'working', sessionId: 's-9' });
    const m = new WorkerManager(db, { command: [process.execPath, FAKE], defaultCwd: os.tmpdir() });
    managers.push(m);
    expect(getRun(db, r.id)).toMatchObject({ status: 'stopped', exitReason: 'server restarted' });
  });

  it('deciding an approval for a dead worker records it without throwing (Review Focus 3)', async () => {
    const { db, m } = setup('permission');
    const g = createGoal(db, { title: 't', objective: 'o' });
    const run = m.start(g.id);
    await waitFor(() => getRun(db, run.id).status === 'waiting_approval');
    m.stop(run.id);
    const [a] = pendingApprovals(db, g.id);
    expect(m.decide(a.id, 'allow').status).toBe('approved');
  });

  it('reads maxWorkers from config with default 2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cfg-'));
    expect(readMaxWorkers(path.join(dir, 'missing.json'))).toBe(2);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ maxWorkers: 3 }));
    expect(readMaxWorkers(path.join(dir, 'config.json'))).toBe(3);
  });
});
```

- [ ] **Step 3: Run** `npx vitest run tests/worker-manager.test.ts 2>&1 | tail -15` — FAIL (module missing).

- [ ] **Step 4: Implement** `src/workers/manager.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { BrainDb } from '../db/connection.js';
import { getGoal, openMaterialQuestions } from '../services/goals.js';
import type { Approval } from '../services/decisions.js';
import {
  ACTIVE_RUN_STATUSES, activeRunForGoal, addEvent, createPermissionApproval, createRun, decidePermission,
  getRun, listRuns, queuedRuns, updateRun, type WorkerEvent, type WorkerRun,
} from '../services/workers.js';
import {
  answersMessage, eventsFor, firstMessage, initializeRequest, nudgeMessage, parseWorkerLine,
  permissionResponse, resumeMessage, userMessage, workerArgs, workerSystemPrompt,
} from './protocol.js';

export type ManagerEvent =
  | { type: 'run-changed'; goalId: string; runId: string; status: string }
  | { type: 'worker-event'; goalId: string; runId: string; event: WorkerEvent }
  | { type: 'approval'; goalId: string; runId: string; approvalId: number };

export interface WorkerControl {
  start(goalId: string, opts?: { cwd?: string }): WorkerRun;
  stop(runId: string): WorkerRun;
  resume(goalId: string): WorkerRun;
  answersUpdated(goalId: string): void;
  decide(approvalId: number, decision: 'allow' | 'deny', note?: string): Approval;
  stopAll(): void;
}

export function readMaxWorkers(configPath = path.join(os.homedir(), '.central-brain', 'config.json')): number {
  try {
    const n = Number(JSON.parse(fs.readFileSync(configPath, 'utf8')).maxWorkers);
    return Number.isInteger(n) && n > 0 ? n : 2;
  } catch { return 2; }
}

interface Live { child: ChildProcessWithoutNullStreams; goalId: string; nudged: boolean; stderr: string; ended: boolean }
const now = () => new Date().toISOString();
const END_STATES = ['completed', 'stopped', 'failed'];

export class WorkerManager implements WorkerControl {
  private live = new Map<string, Live>();
  private pendingFirst = new Map<string, string>();
  private readonly command: string[];
  private readonly maxWorkers: number;

  constructor(private db: BrainDb, private opts: {
    command?: string[]; maxWorkers?: number; defaultCwd: string; onEvent?: (e: ManagerEvent) => void;
  }) {
    this.command = opts.command ?? ['claude'];
    this.maxWorkers = opts.maxWorkers ?? readMaxWorkers();
    // Runs left active by a previous server have no process any more: make them resumable.
    for (const status of ACTIVE_RUN_STATUSES) {
      for (const r of this.db.$client.prepare('SELECT id FROM worker_runs WHERE status = ?').all(status) as { id: string }[]) {
        this.setStatus(r.id, 'stopped', { exitReason: 'server restarted', endedAt: now() });
      }
    }
  }

  runningCount(): number { return this.live.size; }

  start(goalId: string, o: { cwd?: string } = {}): WorkerRun {
    const goal = getGoal(this.db, goalId);
    if (activeRunForGoal(this.db, goalId)) throw new Error(`Goal ${goalId} already has an active worker.`);
    const run = createRun(this.db, { goalId, cwd: o.cwd ?? this.opts.defaultCwd });
    this.pendingFirst.set(run.id, firstMessage(goal));
    this.emit({ type: 'run-changed', goalId, runId: run.id, status: 'queued' });
    this.pump();
    return getRun(this.db, run.id);
  }

  resume(goalId: string): WorkerRun {
    if (activeRunForGoal(this.db, goalId)) throw new Error(`Goal ${goalId} already has an active worker.`);
    const last = listRuns(this.db, goalId).find(r => r.sessionId);
    if (!last) return this.start(goalId);
    this.pendingFirst.set(last.id, resumeMessage(goalId));
    this.setStatus(last.id, 'queued', { exitReason: null, endedAt: null });
    this.pump();
    return getRun(this.db, last.id);
  }

  stop(runId: string): WorkerRun {
    const l = this.live.get(runId);
    this.setStatus(runId, 'stopped', { endedAt: now(), exitReason: 'stopped by user' });
    if (l) { l.ended = true; l.child.kill('SIGTERM'); }
    return getRun(this.db, runId);
  }

  stopAll(): void {
    for (const id of [...this.live.keys()]) this.stop(id);
  }

  answersUpdated(goalId: string): void {
    const run = activeRunForGoal(this.db, goalId);
    if (!run || run.status !== 'waiting_answers') return;
    if (openMaterialQuestions(this.db, goalId).length > 0) return;
    const l = this.live.get(run.id);
    if (l) {
      this.setStatus(run.id, 'working');   // set first: a duplicate call now returns early
      l.nudged = false;
      this.write(l, userMessage(answersMessage(goalId)));
    } else {
      this.pendingFirst.set(run.id, answersMessage(goalId));
      this.setStatus(run.id, 'queued');
      this.pump();
    }
  }

  decide(approvalId: number, decision: 'allow' | 'deny', note?: string): Approval {
    const a = decidePermission(this.db, approvalId, decision, note);
    const l = a.runId ? this.live.get(a.runId) : undefined;
    if (l && !l.ended && a.requestId) {
      this.write(l, permissionResponse(a.requestId, decision, JSON.parse(a.requestJson ?? '{}'), note));
      this.setStatus(a.runId!, 'working');
    }
    return a;
  }

  private pump(): void {
    for (const run of queuedRuns(this.db)) {
      if (this.live.size >= this.maxWorkers) return;
      this.launch(run);
    }
  }

  private launch(run: WorkerRun): void {
    const [bin, ...pre] = this.command;
    const args = [...pre, ...workerArgs({ systemPrompt: workerSystemPrompt(run.goalId), resumeSessionId: run.sessionId ?? undefined })];
    const child = spawn(bin!, args, { cwd: run.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const l: Live = { child, goalId: run.goalId, nudged: false, stderr: '', ended: false };
    this.live.set(run.id, l);
    this.setStatus(run.id, 'starting', { pid: child.pid ?? null, startedAt: now(), endedAt: null });
    child.stderr.on('data', (d: Buffer) => { l.stderr = (l.stderr + d.toString()).slice(-2048); });
    child.stdin.on('error', () => { /* worker gone; exit handler reports it */ });
    readline.createInterface({ input: child.stdout }).on('line', line => this.onLine(run.id, l, line));
    child.on('exit', code => this.onExit(run.id, l, code));
    this.write(l, initializeRequest());
    this.write(l, userMessage(this.pendingFirst.get(run.id) ?? resumeMessage(run.goalId)));
    this.pendingFirst.delete(run.id);
  }

  private onLine(runId: string, l: Live, line: string): void {
    const msg = parseWorkerLine(line);
    for (const e of eventsFor(msg)) {
      this.emit({ type: 'worker-event', goalId: l.goalId, runId, event: addEvent(this.db, runId, e) });
    }
    if (msg.kind === 'init') {
      updateRun(this.db, runId, { sessionId: msg.sessionId });
      this.setStatus(runId, 'working');
    } else if (msg.kind === 'permission') {
      const a = createPermissionApproval(this.db, {
        goalId: l.goalId, runId, requestId: msg.requestId, toolName: msg.toolName, input: msg.input, description: msg.description,
      });
      this.setStatus(runId, 'waiting_approval');
      this.emit({ type: 'approval', goalId: l.goalId, runId, approvalId: a.id });
    } else if (msg.kind === 'result') {
      this.onTurnEnd(runId, l);
    }
  }

  private onTurnEnd(runId: string, l: Live): void {
    if (END_STATES.includes(getRun(this.db, runId).status)) return;
    if (getGoal(this.db, l.goalId).status === 'COMPLETED') {
      this.finish(runId, l, 'completed', null);
    } else if (openMaterialQuestions(this.db, l.goalId).length > 0) {
      this.setStatus(runId, 'waiting_answers');
    } else if (!l.nudged) {
      l.nudged = true;
      this.write(l, userMessage(nudgeMessage(l.goalId)));
      this.setStatus(runId, 'working');
    } else {
      this.finish(runId, l, 'stopped', 'stalled');
    }
  }

  private finish(runId: string, l: Live, status: 'completed' | 'stopped', reason: string | null): void {
    this.setStatus(runId, status, { endedAt: now(), exitReason: reason });
    l.ended = true;
    l.child.stdin.end();
  }

  private onExit(runId: string, l: Live, code: number | null): void {
    this.live.delete(runId);
    const run = getRun(this.db, runId);
    if (!l.ended && !END_STATES.includes(run.status)) {
      const tail = l.stderr.trim() ? ` — ${l.stderr.trim().split('\n').slice(-3).join(' | ')}` : '';
      this.setStatus(runId, 'failed', { endedAt: now(), exitReason: `exit code ${code ?? 'signal'}${tail}` });
    }
    this.pump();
  }

  private write(l: Live, obj: unknown): void {
    if (l.child.stdin.writable) l.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  private setStatus(runId: string, status: WorkerRun['status'], extra: Partial<WorkerRun> = {}): void {
    const r = updateRun(this.db, runId, { ...extra, status } as never);
    this.emit({ type: 'run-changed', goalId: r.goalId, runId, status });
  }

  private emit(e: ManagerEvent): void { this.opts.onEvent?.(e); }
}
```

- [ ] **Step 5: Run** `npx vitest run tests/worker-manager.test.ts 2>&1 | tail -15` (10 pass), full suite, tsc.

- [ ] **Step 6: Commit** `src/workers/manager.ts tests/fixtures/fake-claude.mjs tests/worker-manager.test.ts` — `feat: worker manager — launch, question loop, approvals, queue, resume`.

---

### Task 4: Change feed

**Files:**
- Create: `src/web/change-feed.ts`
- Test: `tests/change-feed.test.ts`

**Interfaces:**
- Produces (from `src/web/change-feed.js`): `class ChangeFeed extends EventEmitter` — `constructor(db: BrainDb, opts?: { intervalMs?: number })`, `start(): void`, `stop(): void`, `poll(): string[]` (changed goal ids; emits `'goal-changed'` with the goal id for each). Only detects writes from **other** connections (SQLite `data_version` semantics); the server announces its own writes directly (Task 5).

- [ ] **Step 1: Write the failing test** — `tests/change-feed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrateDb } from '../src/db/connection.js';
import { createGoal } from '../src/services/goals.js';
import { addDecision } from '../src/services/decisions.js';
import { ChangeFeed } from '../src/web/change-feed.js';

describe('change feed', () => {
  it('reports goals changed by another connection, once per change', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-feed-')), 'brain.db');
    const a = openDb(file); migrateDb(a);
    const b = openDb(file);
    const g1 = createGoal(b, { title: 'one', objective: 'o' });
    const g2 = createGoal(b, { title: 'two', objective: 'o' });
    const feed = new ChangeFeed(a);
    const seen: string[] = [];
    feed.on('goal-changed', (id: string) => seen.push(id));
    expect(feed.poll()).toEqual([]);                    // first poll = baseline
    addDecision(b, { goalId: g2.id, decision: 'use SSE' });
    expect(feed.poll()).toEqual([g2.id]);
    expect(feed.poll()).toEqual([]);                    // nothing new
    b.$client.prepare("UPDATE goals SET status = 'BLOCKED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), g1.id);
    expect(feed.poll()).toEqual([g1.id]);
    expect(seen).toEqual([g2.id, g1.id]);
    const g3 = createGoal(b, { title: 'three', objective: 'o' });
    expect(feed.poll()).toEqual([g3.id]);               // new goals are reported too
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/change-feed.test.ts 2>&1 | tail -10` — FAIL.

- [ ] **Step 3: Implement** `src/web/change-feed.ts`:

```ts
import { EventEmitter } from 'node:events';
import type { BrainDb } from '../db/connection.js';

// Per-goal signature over everything the UI shows for a goal. Cheap: one query, only run when data_version moves.
const SIGNATURE_SQL = `
SELECT g.id AS id, g.updated_at
  || '|q' || COALESCE((SELECT MAX(id) || ':' || COUNT(*) || ':' || SUM(status = 'pending') FROM goal_questions WHERE goal_id = g.id), '')
  || '|r' || COALESCE((SELECT COUNT(*) || ':' || GROUP_CONCAT(status) FROM goal_requirements WHERE goal_id = g.id), '')
  || '|d' || COALESCE((SELECT MAX(id) FROM decisions WHERE goal_id = g.id), '')
  || '|f' || COALESCE((SELECT MAX(id) || ':' || SUM(resolved) FROM failures WHERE goal_id = g.id), '')
  || '|v' || COALESCE((SELECT MAX(id) FROM verification_runs WHERE goal_id = g.id), '')
  || '|a' || COALESCE((SELECT MAX(id) || ':' || SUM(status = 'pending') FROM approvals WHERE goal_id = g.id), '')
  || '|w' || COALESCE((SELECT GROUP_CONCAT(status) FROM worker_runs WHERE goal_id = g.id), '')
  AS sig
FROM goals g`;

export class ChangeFeed extends EventEmitter {
  private version = -1;
  private sigs: Map<string, string> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private db: BrainDb, private opts: { intervalMs?: number } = {}) { super(); }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 1000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  poll(): string[] {
    const v = this.db.$client.pragma('data_version', { simple: true }) as number;
    if (this.sigs && v === this.version) return [];
    this.version = v;
    const next = new Map((this.db.$client.prepare(SIGNATURE_SQL).all() as { id: string; sig: string }[]).map(r => [r.id, r.sig]));
    const prev = this.sigs;
    this.sigs = next;
    if (!prev) return [];
    const changed = [...next].filter(([id, sig]) => prev.get(id) !== sig).map(([id]) => id);
    for (const id of changed) this.emit('goal-changed', id);
    return changed;
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/change-feed.test.ts 2>&1 | tail -8` (1 pass), full suite, tsc.

- [ ] **Step 5: Commit** `src/web/change-feed.ts tests/change-feed.test.ts` — `feat: data_version change feed for cross-process goal updates`.

---

### Task 5: HTTP API + SSE server

**Files:**
- Create: `src/web/api.ts`, `src/web/server.ts`
- Test: `tests/web-api.test.ts`

**Interfaces:**
- Consumes: Task 1 store; `WorkerControl`, `ManagerEvent` (Task 3); `ChangeFeed` (Task 4); services `createGoal`, `getGoal`, `listGoals`, `listRequirements`, `openMaterialQuestions` (goals), `listQuestions`, `answerQuestion`, `dismissQuestion` (questions), `listDecisions` (decisions), `listVerifications` (verification), `buildIntakeReport` (intake), `hybridSearch` (hybrid-search), `search` (search), `listProjects` (projects), `failures` table.
- Produces (from `src/web/server.js`): `interface UiServerOptions { db: BrainDb; workers: WorkerControl; feed?: ChangeFeed; embedder: () => Embedder; port: number; webRoot: string; defaultCwd: string }`, `startUiServer(opts): Promise<{ url: string; port: number; broadcast(event: string, data: unknown): void; announce(goalId: string): void; close(): Promise<void> }>`. The caller wires `ManagerEvent`s in (Task 6): `worker-event` → `broadcast('worker-event', e)`, everything else → `announce(e.goalId)` (the manager writes through the server's own connection, which the change feed cannot see).
- Produces (from `src/web/api.js`): `goalSummaries(db)`, `goalDetail(db, id)`, `needsYou(db)`, `handleApi(ctx, req, res, url): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** — `tests/web-api.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers.js';
import { fakeEmbedder } from '../src/services/embedder.js';
import { addProject } from '../src/services/projects.js';
import { createGoal } from '../src/services/goals.js';
import { listQuestions } from '../src/services/questions.js';
import { createRun, createPermissionApproval } from '../src/services/workers.js';
import { startUiServer } from '../src/web/server.js';
import type { WorkerControl } from '../src/workers/manager.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

function stubWorkers() {
  const calls: unknown[][] = [];
  const w: WorkerControl = {
    start: (...a) => { calls.push(['start', ...a]); return { id: 'RUN-x', status: 'queued' } as never; },
    stop: (...a) => { calls.push(['stop', ...a]); return {} as never; },
    resume: (...a) => { calls.push(['resume', ...a]); return {} as never; },
    answersUpdated: (...a) => { calls.push(['answersUpdated', ...a]); },
    decide: (...a) => { calls.push(['decide', ...a]); return { id: a[0], status: 'approved' } as never; },
    stopAll: () => { calls.push(['stopAll']); },
  };
  return { w, calls };
}

async function boot() {
  const db = createTestDb();
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<title>Central Brain</title>');
  fs.writeFileSync(path.join(webRoot, 'app.js'), 'console.log(1)');
  const { w, calls } = stubWorkers();
  const s = await startUiServer({ db, workers: w, embedder: () => fakeEmbedder(), port: 0, webRoot, defaultCwd: '/tmp/projects' });
  closers.push(s.close);
  const origin = `http://127.0.0.1:${s.port}`;
  const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: any; text: string; type: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers: {
        host: `127.0.0.1:${s.port}`, ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...headers,
      } }, res => {
        let t = ''; res.on('data', c => (t += c)); res.on('end', () => {
          let json: any = null; try { json = JSON.parse(t); } catch { /* not json */ }
          resolve({ status: res.statusCode!, json, text: t, type: String(res.headers['content-type']) });
        });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
  return { db, s, calls, req, origin };
}

describe('web API', () => {
  it('serves the static UI and refuses path traversal', async () => {
    const { req } = await boot();
    expect((await req('GET', '/')).text).toContain('Central Brain');
    expect((await req('GET', '/app.js')).type).toContain('javascript');
    expect((await req('GET', '/../package.json')).status).toBe(404);
  });

  it('rejects foreign Host (DNS rebinding) and foreign Origin on writes', async () => {
    const { req } = await boot();
    expect((await req('GET', '/api/goals', undefined, { host: 'evil.example:80' })).status).toBe(403);
    expect((await req('POST', '/api/goals', { title: 't', objective: 'o' }, { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('creates a goal: intake runs, worker starts in the chosen project', async () => {
    const { db, req, calls } = await boot();
    const p = addProject(db, { name: 'KidTube', rootPath: '/Users/x/kidtube' });
    const r = await req('POST', '/api/goals', { title: 'Resume videos', objective: 'Resume where left off', projectId: p.id, startWorker: true });
    expect(r.status).toBe(201);
    expect(r.json.goal.id).toMatch(/^GOAL-/);
    expect(listQuestions(db, r.json.goal.id).map(q => q.checkKey)).toContain('review:behaviour');
    expect(calls).toContainEqual(['start', r.json.goal.id, { cwd: '/Users/x/kidtube' }]);
    expect((await req('POST', '/api/goals', { title: ' ', objective: 'o' })).status).toBe(400);
  });

  it('lists goals with counts, returns detail with timeline, 404s unknown ids (Review Focus 4)', async () => {
    const { db, req } = await boot();
    const g = createGoal(db, { title: 'Alpha', objective: 'first' });
    const list = await req('GET', '/api/goals');
    expect(list.json.find((x: any) => x.id === g.id)).toMatchObject({ title: 'Alpha', status: 'DRAFT', openQuestions: 0, criteria: { passed: 0, total: 0 } });
    const d = await req('GET', `/api/goals/${g.id}`);
    expect(d.json.goal.id).toBe(g.id);
    expect(d.json.timeline.some((t: any) => t.kind === 'goal' && t.text.includes('created'))).toBe(true);
    expect((await req('GET', '/api/goals/nope')).status).toBe(404);
    expect((await req('GET', '/api/goals/%E0%A4%A')).status).toBe(404);
  });

  it('answer/dismiss call answersUpdated; approvals and worker actions reach the worker control', async () => {
    const { db, req, calls } = await boot();
    const g = (await req('POST', '/api/goals', { title: 'T', objective: 'O', startWorker: false })).json.goal;
    const [q1, q2] = listQuestions(db, g.id);
    expect((await req('POST', `/api/questions/${q1.id}/answer`, { answer: 'auth only', as: 'scope' })).status).toBe(200);
    expect((await req('POST', `/api/questions/${q2.id}/dismiss`, { reason: 'n/a' })).status).toBe(200);
    expect(calls.filter(c => c[0] === 'answersUpdated')).toHaveLength(2);
    const run = createRun(db, { goalId: g.id, cwd: '/tmp' });
    const a = createPermissionApproval(db, { goalId: g.id, runId: run.id, requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } });
    expect((await req('GET', '/api/needs-you')).json.approvals.map((x: any) => x.id)).toContain(a.id);
    await req('POST', `/api/approvals/${a.id}`, { decision: 'allow' });
    expect(calls).toContainEqual(['decide', a.id, 'allow', undefined]);
    await req('POST', `/api/goals/${g.id}/worker`, { action: 'resume' });
    expect(calls).toContainEqual(['resume', g.id]);
    expect((await req('POST', `/api/goals/${g.id}/worker`, { action: 'explode' })).status).toBe(400);
  });

  it('pushes goal-changed over SSE after a write', async () => {
    const { db, s, req } = await boot();
    const g = (await req('POST', '/api/goals', { title: 'T', objective: 'O', startWorker: false })).json.goal;
    const got = new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: { host: `127.0.0.1:${s.port}` } }, res => {
        let buf = '';
        res.on('data', c => { buf += c; if (buf.includes('event: goal-changed')) { res.destroy(); resolve(buf); } });
      });
    });
    await new Promise(r => setTimeout(r, 100));
    const [q] = listQuestions(db, g.id);
    await req('POST', `/api/questions/${q.id}/dismiss`, { reason: 'x' });
    expect(await got).toContain(g.id);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/web-api.test.ts 2>&1 | tail -15` — FAIL.

- [ ] **Step 3: Implement** `src/web/api.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { desc, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { failures } from '../db/schema.js';
import type { Embedder } from '../services/embedder.js';
import { listDecisions } from '../services/decisions.js';
import { createGoal, getGoal, listGoals, listRequirements, openMaterialQuestions } from '../services/goals.js';
import { hybridSearch } from '../services/hybrid-search.js';
import { buildIntakeReport } from '../services/intake.js';
import { listProjects } from '../services/projects.js';
import { answerQuestion, dismissQuestion, getQuestion, listQuestions } from '../services/questions.js';
import { search } from '../services/search.js';
import { listVerifications } from '../services/verification.js';
import { activeRunForGoal, listEvents, listRuns, pendingApprovals } from '../services/workers.js';
import type { WorkerControl } from '../workers/manager.js';

export interface ApiContext {
  db: BrainDb; workers: WorkerControl; embedder: () => Embedder; defaultCwd: string;
  announce(goalId: string): void;
}

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new HttpError(413, 'Body too large'); }
  if (!raw) return {};
  try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } catch { /* fallthrough */ }
  throw new HttpError(400, 'Body must be a JSON object');
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  return v.trim();
};

function goalOr404(db: BrainDb, id: string) {
  try { return getGoal(db, id); } catch { throw new HttpError(404, `Goal not found: ${id}`); }
}

export function goalSummaries(db: BrainDb) {
  return listGoals(db).map(g => {
    const crit = listRequirements(db, g.id).filter(r => r.requirementType === 'success_criterion' && r.priority === 'required');
    const run = activeRunForGoal(db, g.id) ?? listRuns(db, g.id)[0];
    return {
      id: g.id, title: g.title, status: g.status, riskLevel: g.riskLevel, updatedAt: g.updatedAt,
      criteria: { passed: crit.filter(r => r.status === 'PASSED').length, total: crit.length },
      openQuestions: TERMINAL.includes(g.status) ? 0 : openMaterialQuestions(db, g.id).length,
      pendingApprovals: pendingApprovals(db, g.id).length,
      run: run ? { id: run.id, status: run.status, cwd: run.cwd } : null,
    };
  });
}

export function goalDetail(db: BrainDb, id: string) {
  const goal = goalOr404(db, id);
  const questions = listQuestions(db, id);
  const decisions = listDecisions(db, { goalId: id });
  const fails = db.select().from(failures).where(eq(failures.goalId, id)).orderBy(desc(failures.id)).all();
  const verifications = listVerifications(db, { goalId: id });
  const runs = listRuns(db, id);
  const events = runs[0] ? listEvents(db, runs[0].id, { limit: 200 }) : [];
  const approvals = db.$client.prepare('SELECT * FROM approvals WHERE goal_id = ? ORDER BY id DESC').all(id);
  const t: { ts: string; kind: string; text: string }[] = [
    { ts: goal.createdAt, kind: 'goal', text: 'Goal created' },
    ...(goal.lockedAt ? [{ ts: goal.lockedAt, kind: 'goal', text: 'Contract locked' }] : []),
    ...(goal.startedAt ? [{ ts: goal.startedAt, kind: 'goal', text: 'Execution started' }] : []),
    ...(goal.completedAt ? [{ ts: goal.completedAt, kind: 'goal', text: 'Goal completed' }] : []),
    ...questions.map(q => ({ ts: q.createdAt, kind: 'question', text: `Asked: ${q.question}` })),
    ...questions.filter(q => q.answeredAt).map(q => ({ ts: q.answeredAt!, kind: 'answer', text: `Answered: ${q.answer}` })),
    ...decisions.map(d => ({ ts: d.createdAt, kind: 'decision', text: d.decision })),
    ...fails.map(f => ({ ts: f.createdAt, kind: 'failure', text: f.errorMessage ?? 'Failure' })),
    ...verifications.map(v => ({ ts: v.createdAt, kind: v.passed ? 'verified' : 'verify-failed', text: v.actualResult ?? v.command ?? 'Verification' })),
    ...events.map(e => ({ ts: e.ts, kind: `worker-${e.kind}`, text: e.summary })),
  ];
  t.sort((a, b) => a.ts.localeCompare(b.ts));
  return {
    goal, requirements: listRequirements(db, id), questions, approvals, decisions, failures: fails,
    verifications, runs, events, timeline: t,
    openQuestions: TERMINAL.includes(goal.status) ? [] : openMaterialQuestions(db, id).map(q => q.id),
  };
}

export function needsYou(db: BrainDb) {
  const goals = listGoals(db).filter(g => !TERMINAL.includes(g.status));
  const questions = goals.flatMap(g => openMaterialQuestions(db, g.id).map(q => ({ ...q, goalTitle: g.title })));
  const approvals = pendingApprovals(db).map(a => ({ ...a, goalTitle: a.goalId ? goalOr404(db, a.goalId).title : '' }));
  return { questions, approvals, count: questions.length + approvals.length };
}

async function searchGoalIds(ctx: ApiContext, q: string): Promise<Set<string>> {
  try {
    return new Set((await hybridSearch(ctx.db, ctx.embedder(), q, { types: ['goal'], limit: 50 })).map(r => r.id));
  } catch {
    return new Set(search(ctx.db, q, { types: ['goal'], limit: 50 }).map(r => r.id));
  }
}

export async function handleApi(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;
  const m = (re: RegExp) => p.match(re);
  try {
    if (req.method === 'GET' && p === '/api/goals') {
      let rows = goalSummaries(ctx.db);
      const status = url.searchParams.get('status');
      if (status) rows = rows.filter(r => r.status === status);
      const q = url.searchParams.get('q')?.trim();
      if (q) { const ids = await searchGoalIds(ctx, q); rows = rows.filter(r => ids.has(r.id)); }
      send(res, 200, rows); return true;
    }
    if (req.method === 'GET' && p === '/api/projects') { send(res, 200, listProjects(ctx.db)); return true; }
    if (req.method === 'GET' && p === '/api/needs-you') { send(res, 200, needsYou(ctx.db)); return true; }
    let g = m(/^\/api\/goals\/([^/]+)$/);
    if (req.method === 'GET' && g) {
      let id: string;
      try { id = decodeURIComponent(g[1]!); } catch { throw new HttpError(404, 'Goal not found'); }
      send(res, 200, goalDetail(ctx.db, id)); return true;
    }
    if (req.method === 'POST' && p === '/api/goals') {
      const b = await readJson(req);
      const title = str(b.title, 'title');
      const objective = str(b.objective, 'objective');
      let cwd = ctx.defaultCwd;
      if (typeof b.projectId === 'string' && b.projectId) {
        const proj = listProjects(ctx.db).find(x => x.id === b.projectId);
        if (!proj) throw new HttpError(400, `Unknown project: ${b.projectId}`);
        if (proj.rootPath) cwd = proj.rootPath;
      }
      const goal = createGoal(ctx.db, { title, objective });
      await buildIntakeReport(ctx.db, ctx.embedder(), goal.id);
      const run = b.startWorker === false ? null : ctx.workers.start(goal.id, { cwd });
      ctx.announce(goal.id);
      send(res, 201, { goal: getGoal(ctx.db, goal.id), run }); return true;
    }
    let q = m(/^\/api\/questions\/(\d+)\/(answer|dismiss)$/);
    if (req.method === 'POST' && q) {
      const b = await readJson(req);
      const id = Number(q[1]);
      const goalId = getQuestion(ctx.db, id).goalId;
      const out = q[2] === 'answer'
        ? answerQuestion(ctx.db, id, str(b.answer, 'answer'), { as: typeof b.as === 'string' && b.as ? b.as : undefined })
        : dismissQuestion(ctx.db, id, str(b.reason, 'reason'));
      ctx.workers.answersUpdated(goalId);
      ctx.announce(goalId);
      send(res, 200, out); return true;
    }
    let a = m(/^\/api\/approvals\/(\d+)$/);
    if (req.method === 'POST' && a) {
      const b = await readJson(req);
      if (b.decision !== 'allow' && b.decision !== 'deny') throw new HttpError(400, 'decision must be allow or deny');
      const out = ctx.workers.decide(Number(a[1]), b.decision, typeof b.note === 'string' && b.note ? b.note : undefined);
      if (out.goalId) ctx.announce(out.goalId);
      send(res, 200, out); return true;
    }
    g = m(/^\/api\/goals\/([^/]+)\/worker$/);
    if (req.method === 'POST' && g) {
      const b = await readJson(req);
      const goal = goalOr404(ctx.db, g[1]!);
      let out: unknown;
      if (b.action === 'start') out = ctx.workers.start(goal.id);
      else if (b.action === 'resume') out = ctx.workers.resume(goal.id);
      else if (b.action === 'stop') {
        const run = activeRunForGoal(ctx.db, goal.id);
        if (!run) throw new HttpError(409, 'No active worker for this goal');
        out = ctx.workers.stop(run.id);
      } else throw new HttpError(400, 'action must be start, stop or resume');
      ctx.announce(goal.id);
      send(res, 200, out); return true;
    }
    send(res, 404, { error: 'Not found' }); return true;
  } catch (e) {
    const err = e as Error;
    const status = e instanceof HttpError ? e.status : /not found/i.test(err.message) ? 404 : 400;
    send(res, status, { error: err.message }); return true;
  }
}
```

- [ ] **Step 4: Implement** `src/web/server.ts`:

```ts
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { BrainDb } from '../db/connection.js';
import type { Embedder } from '../services/embedder.js';
import type { WorkerControl } from '../workers/manager.js';
import type { ChangeFeed } from './change-feed.js';
import { handleApi, needsYou } from './api.js';

export interface UiServerOptions {
  db: BrainDb; workers: WorkerControl; feed?: ChangeFeed; embedder: () => Embedder;
  port: number; webRoot: string; defaultCwd: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

export async function startUiServer(opts: UiServerOptions) {
  const clients = new Set<http.ServerResponse>();
  let port = opts.port;
  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const announce = (goalId: string) => {
    broadcast('goal-changed', { goalId });
    broadcast('needs-you', { count: needsYou(opts.db).count });
  };
  opts.feed?.on('goal-changed', (goalId: string) => announce(goalId));

  const server = http.createServer(async (req, res) => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(String(req.headers.host))) { res.writeHead(403).end('Forbidden host'); return; }
    if (req.method !== 'GET') {
      const origins = allowedHosts.map(h => `http://${h}`);
      if (!origins.includes(String(req.headers.origin))) { res.writeHead(403).end('Forbidden origin'); return; }
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: needs-you\ndata: ${JSON.stringify({ count: needsYou(opts.db).count })}\n\n`);
      clients.add(res);
      const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
      return;
    }
    if (await handleApi({ db: opts.db, workers: opts.workers, embedder: opts.embedder, defaultCwd: opts.defaultCwd, announce }, req, res, url)) return;
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.resolve(opts.webRoot, rel);
    if (!file.startsWith(path.resolve(opts.webRoot) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('Not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    broadcast,
    announce,
    close: () => new Promise<void>(resolve => {
      for (const c of clients) c.end();
      server.close(() => resolve());
    }),
  };
}
```

Note: `/../package.json` is normalised by `new URL` to `/package.json`, which then 404s because it isn't under `webRoot` — the test asserts the 404.

- [ ] **Step 5: Run** `npx vitest run tests/web-api.test.ts 2>&1 | tail -15` (6 pass), full suite, tsc.

- [ ] **Step 6: Commit** `src/web/api.ts src/web/server.ts tests/web-api.test.ts` — `feat: localhost API + SSE server with host/origin guards`.

---

### Task 6: Static UI + `brain ui` command

**Files:**
- Create: `web/index.html`, `web/styles.css`, `web/app.js`
- Modify: `src/cli/index.ts` (add `ui` command)
- Test: `tests/web-static.test.ts`

**Interfaces:**
- Consumes: `startUiServer` (Task 5), `WorkerManager`, `readMaxWorkers` (Task 3), `ChangeFeed` (Task 4), `packageRoot` (`src/db/connection.js`), the CLI's existing `db()`, `embedder()`, `out`, `runAsync`.
- Produces: CLI `brain ui [--port <n>] [--no-open]` → prints `{"url": "http://127.0.0.1:<port>"}` and keeps running; SIGINT/SIGTERM stop workers and exit.

- [ ] **Step 1: Write the failing test** — `tests/web-static.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

describe('static UI', () => {
  it('ships index.html, styles.css and a syntactically valid app.js wired to the API', () => {
    const html = fs.readFileSync('web/index.html', 'utf8');
    expect(html).toContain('<title>Central Brain</title>');
    expect(html).toContain('app.js');
    expect(fs.existsSync('web/styles.css')).toBe(true);
    execFileSync(process.execPath, ['--check', 'web/app.js']);
    const js = fs.readFileSync('web/app.js', 'utf8');
    for (const route of ['/api/goals', '/api/needs-you', '/api/events', '/api/projects', '/api/questions/', '/api/approvals/']) {
      expect(js).toContain(route);
    }
    expect(js).toContain('function esc(');
  });

  it('brain ui is registered', () => {
    const help = execFileSync('npx', ['tsx', 'src/cli/index.ts', 'ui', '--help'], { encoding: 'utf8' });
    expect(help).toContain('--port');
    expect(help).toContain('--no-open');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/web-static.test.ts 2>&1 | tail -10` — FAIL.

- [ ] **Step 3: `web/index.html`:**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Central Brain</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="top">
    <a href="#/" class="brand">Central Brain</a>
    <span id="needs" class="needs" hidden></span>
    <a href="#/new" class="btn primary">New goal</a>
  </header>
  <div id="banner" class="banner" hidden>Disconnected — reconnecting…</div>
  <main id="view"></main>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 4: `web/styles.css`:**

```css
:root { --bg:#f7f7f5; --panel:#fff; --ink:#1d1d1b; --muted:#6b6b66; --line:#e3e2dc; --accent:#2f5bd3;
  --warn:#b25b00; --warnbg:#fff4e5; --ok:#1f7a3a; --bad:#b3261e; --radius:10px; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --panel:#1d1d1b; --ink:#ecebe6; --muted:#a3a29b;
  --line:#33332f; --accent:#7f9cf5; --warnbg:#3a2a12; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--ink); }
.top { display:flex; align-items:center; gap:16px; padding:12px 20px; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; }
.brand { font-weight:700; color:var(--ink); text-decoration:none; margin-right:auto; }
.btn { display:inline-block; padding:6px 12px; border:1px solid var(--line); border-radius:8px; background:var(--panel); color:var(--ink); cursor:pointer; text-decoration:none; font:inherit; }
.btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.btn.danger { color:var(--bad); }
.needs { background:var(--warnbg); color:var(--warn); padding:4px 10px; border-radius:999px; font-weight:600; }
.banner { background:var(--warnbg); color:var(--warn); padding:8px 20px; }
main { max-width:1100px; margin:0 auto; padding:20px; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:16px; margin-bottom:16px; }
.panel h2 { margin:0 0 12px; font-size:16px; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
tr.row { cursor:pointer; } tr.row:hover { background:var(--bg); }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--muted); }
.badge.EXECUTING, .badge.working, .badge.starting { color:var(--accent); border-color:var(--accent); }
.badge.COMPLETED, .badge.completed, .badge.PASSED { color:var(--ok); border-color:var(--ok); }
.badge.FAILED, .badge.failed { color:var(--bad); border-color:var(--bad); }
.badge.waiting_answers, .badge.waiting_approval { color:#fff; background:var(--warn); border-color:var(--warn); }
.muted { color:var(--muted); } .small { font-size:13px; }
.filters { display:flex; gap:8px; margin-bottom:12px; }
input, textarea, select { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:8px; background:var(--panel); color:var(--ink); }
textarea { width:100%; min-height:70px; }
.card { border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:10px; }
.card.risk-HIGH { border-left:4px solid var(--bad); } .card.risk-MEDIUM { border-left:4px solid var(--warn); }
.row-actions { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }
pre { white-space:pre-wrap; word-break:break-word; background:var(--bg); padding:8px; border-radius:6px; margin:6px 0; font-size:13px; }
.timeline { max-height:480px; overflow:auto; }
.tl { display:grid; grid-template-columns:90px 110px 1fr; gap:8px; padding:4px 0; border-bottom:1px dashed var(--line); font-size:13px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
@media (max-width: 800px) { .grid2 { grid-template-columns:1fr; } .tl { grid-template-columns:70px 1fr; } .tl .k { display:none; } }
```

- [ ] **Step 5: `web/app.js`:**

```js
// Central Brain UI — framework-free. All server data is escaped with esc() before rendering.
const view = document.getElementById('view');
const needsEl = document.getElementById('needs');
const banner = document.getElementById('banner');
let current = { page: 'home', goalId: null };
let reloadTimer = null;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const time = ts => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const when = ts => (ts ? new Date(ts).toLocaleString() : '');

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function flash(msg) { alert(msg); }

// ---------- home ----------
async function renderHome() {
  const [goals, needs] = await Promise.all([api(`/api/goals${homeQuery()}`), api('/api/needs-you')]);
  view.innerHTML = `
    ${needsPanel(needs)}
    <section class="panel">
      <h2>Goals</h2>
      <div class="filters">
        <input id="q" placeholder="Search goals" value="${esc(sessionStorage.q || '')}">
        <select id="status">
          ${['', 'DRAFT', 'LOCKED', 'EXECUTING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED']
            .map(s => `<option value="${s}" ${s === (sessionStorage.status || '') ? 'selected' : ''}>${s || 'All statuses'}</option>`).join('')}
        </select>
      </div>
      <table>
        <thead><tr><th>Goal</th><th>Status</th><th>Worker</th><th>Criteria</th><th>Needs you</th><th>Updated</th></tr></thead>
        <tbody>${goals.map(g => `
          <tr class="row" data-id="${esc(g.id)}">
            <td><strong>${esc(g.id)}</strong><br>${esc(g.title)}</td>
            <td><span class="badge ${esc(g.status)}">${esc(g.status)}</span></td>
            <td>${g.run ? `<span class="badge ${esc(g.run.status)}">${esc(label(g.run.status))}</span>` : '<span class="muted">—</span>'}</td>
            <td>${g.criteria.total ? `${g.criteria.passed}/${g.criteria.total}` : '<span class="muted">—</span>'}</td>
            <td>${g.openQuestions + g.pendingApprovals || ''}</td>
            <td class="small muted">${esc(when(g.updatedAt))}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No goals</td></tr>'}
        </tbody>
      </table>
    </section>`;
  view.querySelectorAll('tr.row').forEach(tr => tr.addEventListener('click', () => { location.hash = `#/goal/${tr.dataset.id}`; }));
  const q = document.getElementById('q');
  q.addEventListener('change', () => { sessionStorage.q = q.value; renderHome(); });
  document.getElementById('status').addEventListener('change', e => { sessionStorage.status = e.target.value; renderHome(); });
  bindNeeds();
}

function homeQuery() {
  const p = new URLSearchParams();
  if (sessionStorage.q) p.set('q', sessionStorage.q);
  if (sessionStorage.status) p.set('status', sessionStorage.status);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const label = s => ({ waiting_answers: 'Waiting for you', waiting_approval: 'Waiting for approval' }[s] || s);

function needsPanel(needs) {
  if (!needs.count) return '';
  return `<section class="panel"><h2>Needs you (${needs.count})</h2>
    ${needs.approvals.map(approvalCard).join('')}
    ${needs.questions.length ? `<p class="small muted">Open questions — answer them on the goal page:</p>
      <ul>${needs.questions.map(q => `<li><a href="#/goal/${esc(q.goalId)}">${esc(q.goalId)} · ${esc(q.goalTitle)}</a>: ${esc(q.question)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function approvalCard(a) {
  let input = a.requestJson;
  try { input = JSON.stringify(JSON.parse(a.requestJson), null, 2); } catch { /* keep raw */ }
  return `<div class="card risk-${esc(a.riskLevel)}" data-approval="${esc(a.id)}">
    <div><span class="badge">${esc(a.riskLevel)}</span> <strong>${esc(a.toolName || 'Action')}</strong>
      <span class="small muted">· ${esc(a.goalId)} ${a.goalTitle ? `· ${esc(a.goalTitle)}` : ''}</span></div>
    <div>${esc(a.action)}</div>
    <pre>${esc(input)}</pre>
    <div class="row-actions">
      <button class="btn primary" data-decide="allow">Allow</button>
      <button class="btn danger" data-decide="deny">Deny</button>
      <input placeholder="Note to the worker (optional)" data-note>
    </div></div>`;
}

function bindNeeds() {
  view.querySelectorAll('[data-approval]').forEach(card => {
    card.querySelectorAll('[data-decide]').forEach(btn => btn.addEventListener('click', async () => {
      const note = card.querySelector('[data-note]').value.trim() || undefined;
      try { await api(`/api/approvals/${card.dataset.approval}`, { decision: btn.dataset.decide, note }); refresh(); }
      catch (e) { flash(e.message); }
    }));
  });
}

// ---------- new goal ----------
async function renderNew() {
  const projects = await api('/api/projects');
  view.innerHTML = `<section class="panel"><h2>New goal</h2>
    <p><label>Title<br><input id="title" style="width:100%"></label></p>
    <p><label>Objective — what must be true when this is done?<br><textarea id="objective"></textarea></label></p>
    <p><label>Project (optional)<br><select id="project"><option value="">Let the worker find it</option>
      ${projects.sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
    </select></label></p>
    <p><label><input type="checkbox" id="start" checked> Start a worker now</label></p>
    <button class="btn primary" id="create">Create goal</button></section>`;
  document.getElementById('create').addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const out = await api('/api/goals', {
        title: document.getElementById('title').value, objective: document.getElementById('objective').value,
        projectId: document.getElementById('project').value || undefined, startWorker: document.getElementById('start').checked,
      });
      location.hash = `#/goal/${out.goal.id}`;
    } catch (err) { flash(err.message); e.target.disabled = false; }
  });
}

// ---------- goal detail ----------
async function renderGoal(id) {
  const d = await api(`/api/goals/${encodeURIComponent(id)}`);
  const g = d.goal;
  const run = d.runs[0];
  const active = run && ['queued', 'starting', 'working', 'waiting_answers', 'waiting_approval'].includes(run.status);
  const reqs = t => d.requirements.filter(r => r.requirementType === t);
  const evidence = r => d.verifications.filter(v => v.requirementId === r.id).map(v => `<div class="small muted">${esc(v.actualResult)}</div>`).join('');
  const open = d.questions.filter(q => d.openQuestions.includes(q.id));
  const pending = d.approvals.filter(a => a.status === 'pending' && a.runId);
  view.innerHTML = `
    <section class="panel">
      <h2>${esc(g.id)} · ${esc(g.title)}</h2>
      <p>${esc(g.objective)}</p>
      <p><span class="badge ${esc(g.status)}">${esc(g.status)}</span>
        ${g.riskLevel ? `<span class="badge">risk ${esc(g.riskLevel)}</span>` : ''}
        ${run ? `<span class="badge ${esc(run.status)}">worker: ${esc(label(run.status))}</span> <span class="small muted">${esc(run.cwd)}</span>` : ''}
        ${run?.exitReason ? `<span class="small muted"> — ${esc(run.exitReason)}</span>` : ''}</p>
      <div class="row-actions">
        ${!active && g.status !== 'COMPLETED' ? `<button class="btn primary" data-worker="${run?.sessionId ? 'resume' : 'start'}">${run?.sessionId ? 'Resume worker' : 'Start worker'}</button>` : ''}
        ${active ? '<button class="btn danger" data-worker="stop">Stop worker</button>' : ''}
      </div>
    </section>
    ${pending.length ? `<section class="panel"><h2>Approvals</h2>${pending.map(approvalCard).join('')}</section>` : ''}
    ${open.length ? `<section class="panel"><h2>Questions (${open.length}) — answer together</h2>
      ${open.map(q => `<div class="card" data-q="${esc(q.id)}">
        <div><strong>${esc(q.question)}</strong> <span class="small muted">${esc(q.source)}${q.checkKey ? ` · ${esc(q.checkKey)}` : ''}</span></div>
        <textarea data-answer></textarea>
        <div class="row-actions">
          <select data-as><option value="">Record as answer only</option>
            ${['constraint', 'scope', 'success_criterion', 'exclusion', 'assumption', 'permission'].map(t => `<option value="${t}">Record as ${t}</option>`).join('')}
          </select>
          <input placeholder="Dismiss reason" data-reason><button class="btn" data-dismiss>Dismiss</button>
        </div></div>`).join('')}
      <button class="btn primary" id="send-answers">Send answers</button></section>` : ''}
    <div class="grid2">
      <section class="panel"><h2>Contract</h2>
        ${section('Scope', reqs('scope'), r => esc(r.description))}
        ${section('Success criteria', reqs('success_criterion'), r => `<span class="badge ${esc(r.status)}">${esc(r.status)}</span> ${esc(r.description)}${evidence(r)}`)}
        ${section('Constraints', reqs('constraint'), r => esc(r.description))}
        ${section('Exclusions', reqs('exclusion'), r => esc(r.description))}
        ${section('Answered questions', d.questions.filter(q => q.status === 'answered'), q => `${esc(q.question)}<div class="small muted">${esc(q.answer)}</div>`)}
      </section>
      <section class="panel"><h2>Live timeline</h2><div class="timeline" id="timeline">
        ${d.timeline.map(tlRow).join('') || '<p class="muted">Nothing yet</p>'}</div></section>
    </div>
    <div class="grid2">
      <section class="panel"><h2>Decisions</h2>${d.decisions.map(x => `<div class="card">${esc(x.decision)}<div class="small muted">${esc(x.reason)}</div></div>`).join('') || '<p class="muted">None</p>'}</section>
      <section class="panel"><h2>Failures</h2>${d.failures.map(x => `<div class="card">${x.resolved ? '✓ ' : ''}${esc(x.errorMessage)}</div>`).join('') || '<p class="muted">None</p>'}</section>
    </div>`;
  const tl = document.getElementById('timeline');
  tl.scrollTop = tl.scrollHeight;
  view.querySelectorAll('[data-worker]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/goals/${encodeURIComponent(g.id)}/worker`, { action: b.dataset.worker }); refresh(); } catch (e) { flash(e.message); }
  }));
  view.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click', async () => {
    const card = b.closest('[data-q]');
    try { await api(`/api/questions/${card.dataset.q}/dismiss`, { reason: card.querySelector('[data-reason]').value }); refresh(); }
    catch (e) { flash(e.message); }
  }));
  const send = document.getElementById('send-answers');
  send?.addEventListener('click', async () => {
    send.disabled = true;
    try {
      for (const card of view.querySelectorAll('[data-q]')) {
        const answer = card.querySelector('[data-answer]').value.trim();
        if (!answer) continue;
        await api(`/api/questions/${card.dataset.q}/answer`, { answer, as: card.querySelector('[data-as]').value || undefined });
      }
      refresh();
    } catch (e) { flash(e.message); send.disabled = false; }
  });
  bindNeeds();
}

function section(title, rows, fmt) {
  if (!rows.length) return '';
  return `<h3 class="small muted">${esc(title)}</h3><ul>${rows.map(r => `<li>${fmt(r)}</li>`).join('')}</ul>`;
}

function tlRow(t) {
  return `<div class="tl"><span class="muted">${esc(time(t.ts))}</span><span class="k badge">${esc(t.kind)}</span><span>${esc(t.text)}</span></div>`;
}

// ---------- routing + live updates ----------
function route() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/goal\/(.+)$/);
  current = m ? { page: 'goal', goalId: decodeURIComponent(m[1]) } : { page: h === '#/new' ? 'new' : 'home', goalId: null };
  refresh();
}

function refresh() {
  const p = current.page === 'goal' ? renderGoal(current.goalId) : current.page === 'new' ? renderNew() : renderHome();
  p.catch(e => { view.innerHTML = `<section class="panel"><h2>Error</h2><p>${esc(e.message)}</p><a href="#/">Back to goals</a></section>`; });
}

function scheduleReload() {
  if (current.page === 'new') return;              // never wipe a half-typed form
  if (view.querySelector('textarea:focus, input:focus')) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(refresh, 300);
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { banner.hidden = true; };
  es.onerror = () => { banner.hidden = false; };
  es.addEventListener('needs-you', e => {
    const { count } = JSON.parse(e.data);
    needsEl.hidden = !count;
    needsEl.textContent = `${count} need${count === 1 ? 's' : ''} you`;
    document.title = count ? `(${count}) Central Brain` : 'Central Brain';
  });
  es.addEventListener('goal-changed', e => {
    const { goalId } = JSON.parse(e.data);
    if (current.page === 'home' || current.goalId === goalId) scheduleReload();
  });
  es.addEventListener('worker-event', e => {
    const { goalId, event } = JSON.parse(e.data);
    if (current.goalId !== goalId) return;
    const tl = document.getElementById('timeline');
    if (!tl) return;
    const atBottom = tl.scrollTop + tl.clientHeight >= tl.scrollHeight - 20;
    tl.insertAdjacentHTML('beforeend', tlRow({ ts: event.ts, kind: `worker-${event.kind}`, text: event.summary }));
    if (atBottom) tl.scrollTop = tl.scrollHeight;
  });
  es.addEventListener('run-changed', e => {
    const { goalId } = JSON.parse(e.data);
    if (current.page === 'home' || current.goalId === goalId) scheduleReload();
  });
}

window.addEventListener('hashchange', route);
connect();
route();
```

- [ ] **Step 6: `brain ui` command.** In `src/cli/index.ts` add imports:

```ts
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { packageRoot } from '../db/connection.js';
import { WorkerManager } from '../workers/manager.js';
import { ChangeFeed } from '../web/change-feed.js';
import { startUiServer } from '../web/server.js';
```

(skip any already imported), and before the final `await program.parseAsync()`:

```ts
// ---- web UI ----
program.command('ui').description('Start the Brain web UI on 127.0.0.1 (launches Claude workers)')
  .option('--port <n>', 'port', '4410').option('--no-open', 'do not open the browser')
  .action((o) => runAsync(async () => {
    const d = db();
    let ui: Awaited<ReturnType<typeof startUiServer>> | null = null;
    const manager = new WorkerManager(d, {
      defaultCwd: path.join(os.homedir(), 'Projects'),
      // Test hook: BRAIN_WORKER_COMMAND='["node","tests/fixtures/fake-claude.mjs"]' swaps the real claude binary.
      command: process.env.BRAIN_WORKER_COMMAND ? JSON.parse(process.env.BRAIN_WORKER_COMMAND) : undefined,
      onEvent: (e) => {
        if (!ui) return;
        if (e.type === 'worker-event') ui.broadcast('worker-event', e);
        else { ui.broadcast('run-changed', e); ui.announce(e.goalId); }
      },
    });
    const feed = new ChangeFeed(d);
    const server = ui = await startUiServer({
      db: d, workers: manager, feed, embedder, port: Number(o.port),
      webRoot: path.join(packageRoot(), 'web'), defaultCwd: path.join(os.homedir(), 'Projects'),
    });
    feed.start();
    out({ url: server.url });
    if (o.open && process.platform === 'darwin') spawn('open', [server.url], { stdio: 'ignore', detached: true }).unref();
    const shutdown = async () => { manager.stopAll(); feed.stop(); await server.close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }));
```

- [ ] **Step 7: Run** `npx vitest run tests/web-static.test.ts 2>&1 | tail -8` (2 pass), full suite, tsc, `npm run build 2>&1 | tail -3`. Then a manual smoke on a temp DB with a fake worker (never the live DB):

```bash
T=$(mktemp -d); BRAIN_DB=$T/brain.db npx tsx src/cli/index.ts ui --port 4499 --no-open > $T/ui.log 2>&1 &
sleep 4; curl -s http://127.0.0.1:4499/ | grep -c '<title>Central Brain</title>'; curl -s http://127.0.0.1:4499/api/goals; kill %1
```

Expected: `1`, then `[]`.

- [ ] **Step 8: Commit** `web src/cli/index.ts tests/web-static.test.ts` — `feat: brain ui — static single-page UI served by the localhost server`.

---

### Task 7: Live run, docs, completion

**Files:**
- Modify: `README.md`
- No src changes.

- [ ] **Step 1: Browser smoke with the fake worker** (temp DB — never the live one):

```bash
npm run build
T=$(mktemp -d)
BRAIN_DB=$T/brain.db BRAIN_WORKER_COMMAND='["node","tests/fixtures/fake-claude.mjs"]' \
  FAKE_SCENARIO=permission FAKE_LOG=$T/fake.log node dist/cli/index.js ui --port 4499 --no-open > $T/ui.log 2>&1 &
```

Drive http://127.0.0.1:4499 with the Playwright MCP tools: create a goal (worker on) → the goal page shows the four intake questions → an approval card appears (fake worker asks for `git push`) → Deny with a note → the timeline shows the denial without a reload → answer all questions → Send answers → worker state changes → home list badges update without reload. Screenshot each step into the scratchpad. Stop the server afterwards.

- [ ] **Step 2: Real run with the user.** `npm run build`, then `node dist/cli/index.js ui` (live DB; `brain ui` migrates with a snapshot on start). The user submits a real goal through the UI — the pending KidTube resume feature ("tapping a Continue watching video resumes where the kid left off", project yt-kids-alternative) — answers the worker's batched questions (which must include the `review:behaviour` choices), decides any approval cards, and watches progress. Controller audits Brain records afterwards (questions asked before lock, no push/deploy, verifications with evidence).

- [ ] **Step 3: Verify + complete.** Record verifications for GOAL-2026-0010's success criterion (API/manager/feed test counts, Playwright smoke evidence, real-run evidence) and GOAL-2026-0006's criterion (the real worker asked behaviour questions before locking) via `brain verify add`; `brain goal complete` both (no force); `brain backup`.

- [ ] **Step 4: README + commit.** Append:

```markdown
- UI: `brain ui` → http://127.0.0.1:4410 — goals, live timeline, submit goals (launches a headless Claude worker in auto mode), answer questions and approve risky actions in the browser. `maxWorkers` in `~/.central-brain/config.json` (default 2).
```

```bash
git commit -m "docs: brain ui command surface" -m "Goal: GOAL-2026-0010" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- README.md
```

---

## Verification (whole-plan)

- Full suite green, tsc clean, build clean; no new dependencies.
- Browser smoke (fake worker) passes every screen; real worker run completes a real goal with questions answered and approvals decided in the UI.
- Server reachable only on 127.0.0.1; Host/Origin guards tested.

## Out of scope

Editing locked contracts; login/multi-user; non-localhost access; push notifications; charts; remote workers.

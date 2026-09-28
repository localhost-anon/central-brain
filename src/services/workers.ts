import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
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
  return db.select().from(workerRuns).where(eq(workerRuns.goalId, goalId)).orderBy(desc(workerRuns.createdAt), desc(sql`rowid`)).all();
}

export function activeRunForGoal(db: BrainDb, goalId: string): WorkerRun | undefined {
  return db.select().from(workerRuns)
    .where(and(eq(workerRuns.goalId, goalId), inArray(workerRuns.status, [...ACTIVE_RUN_STATUSES])))
    .orderBy(desc(workerRuns.createdAt), desc(sql`rowid`)).get();
}

export function queuedRuns(db: BrainDb): WorkerRun[] {
  return db.select().from(workerRuns).where(eq(workerRuns.status, 'queued')).orderBy(asc(workerRuns.createdAt), asc(sql`rowid`)).all();
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

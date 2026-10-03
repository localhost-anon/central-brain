import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { failures, failureSolutions, observations } from '../db/schema.js';
import { search, type SearchResult } from './search.js';
import { touchGoal } from './activity.js';
import { VERDICTS } from './contract-rules.js';

export type Failure = typeof failures.$inferSelect;
export type FailureSolution = typeof failureSolutions.$inferSelect;

const now = () => new Date().toISOString();

export function addFailure(db: BrainDb, input: {
  errorMessage: string; goalId?: string; workUnitId?: string;
  failureType?: string; context?: string;
}): Failure {
  const res = db.insert(failures).values({
    errorMessage: input.errorMessage, goalId: input.goalId ?? null,
    workUnitId: input.workUnitId ?? null, failureType: input.failureType ?? null,
    context: input.context ?? null, createdAt: now(),
  }).run();
  touchGoal(db, input.goalId);
  return db.select().from(failures).where(eq(failures.id, Number(res.lastInsertRowid))).get()!;
}

export function getFailure(db: BrainDb, id: number): Failure & { solutions: FailureSolution[] } {
  const f = db.select().from(failures).where(eq(failures.id, id)).get();
  if (!f) throw new Error(`Failure not found: ${id}`);
  const solutions = db.select().from(failureSolutions)
    .where(eq(failureSolutions.failureId, id)).all();
  return { ...f, solutions };
}

export function searchFailures(db: BrainDb, query: string, opts: { limit?: number } = {}): SearchResult[] {
  return search(db, query, { types: ['failure'], limit: opts.limit });
}

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
  let verdict: string | null = input.verdict ?? (input.successful === undefined ? null : input.successful ? 'verified' : 'failed');
  let note: string | undefined;
  if (verdict === 'verified' && !reproduction) {
    if (input.verdict === undefined) verdict = 'partial'; // legacy successful:true
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

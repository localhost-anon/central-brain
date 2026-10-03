import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { failures, failureSolutions } from '../db/schema.js';
import { search, type SearchResult } from './search.js';
import { touchGoal } from './activity.js';

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

export function resolveFailure(db: BrainDb, id: number): Failure {
  getFailure(db, id);
  db.update(failures).set({ resolved: 1, resolvedAt: now() }).where(eq(failures.id, id)).run();
  return db.select().from(failures).where(eq(failures.id, id)).get()!;
}

export function addSolution(db: BrainDb, failureId: number, input: {
  solution: string; successful?: boolean;
}): FailureSolution {
  getFailure(db, failureId);
  const res = db.insert(failureSolutions).values({
    failureId, solution: input.solution,
    successful: input.successful === undefined ? null : input.successful ? 1 : 0,
    createdAt: now(),
  }).run();
  touchGoal(db, getFailure(db, failureId).goalId);
  if (input.successful) resolveFailure(db, failureId);
  return db.select().from(failureSolutions)
    .where(eq(failureSolutions.id, Number(res.lastInsertRowid))).get()!;
}

import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goals } from '../db/schema.js';

const OPEN = ['DRAFT', 'LOCKED', 'PLANNING', 'EXECUTING', 'VERIFYING', 'BLOCKED'];
const DAY_MS = 86_400_000;

/** Any goal-scoped write bumps updated_at so live goals never look abandoned. */
export function touchGoal(db: BrainDb, goalId: string | null | undefined, at: Date = new Date()): void {
  if (!goalId) return;
  db.update(goals).set({ updatedAt: at.toISOString() }).where(eq(goals.id, goalId)).run();
}

export function staleDays(): number {
  const n = Number(process.env.BRAIN_STALE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export function isStale(goal: { status: string; updatedAt: string }, now: Date = new Date()): boolean {
  return OPEN.includes(goal.status) && now.getTime() - Date.parse(goal.updatedAt) > staleDays() * DAY_MS;
}

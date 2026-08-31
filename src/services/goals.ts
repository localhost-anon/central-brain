import { desc, eq, inArray } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goals, goalRequirements, observations } from '../db/schema.js';
import { nextGoalId } from '../ids.js';

export type Goal = typeof goals.$inferSelect;
export type Requirement = typeof goalRequirements.$inferSelect;

export const ACTIVE_STATUSES = ['LOCKED', 'PLANNING', 'EXECUTING', 'VERIFYING', 'BLOCKED'];
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

export class GoalLockedError extends Error {}
export class IncompleteCriteriaError extends Error {}

const now = () => new Date().toISOString();

export function createGoal(
  db: BrainDb,
  input: { title: string; objective: string; autonomyLevel?: string; riskLevel?: string; complexity?: string },
): Goal {
  const id = nextGoalId(db);
  const ts = now();
  db.insert(goals).values({
    id, title: input.title, objective: input.objective,
    autonomyLevel: input.autonomyLevel ?? 'full', riskLevel: input.riskLevel ?? null,
    complexity: input.complexity ?? null,
    status: 'DRAFT', createdAt: ts, updatedAt: ts,
  }).run();
  return getGoal(db, id);
}

export function getGoal(db: BrainDb, id: string): Goal {
  const g = db.select().from(goals).where(eq(goals.id, id)).get();
  if (!g) throw new Error(`Goal not found: ${id}`);
  return g;
}

export function listGoals(db: BrainDb, opts: { status?: string } = {}): Goal[] {
  const q = db.select().from(goals);
  const rows = opts.status ? q.where(eq(goals.status, opts.status)).all() : q.all();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function currentGoal(db: BrainDb): Goal | undefined {
  return db.select().from(goals)
    .where(inArray(goals.status, ACTIVE_STATUSES))
    .orderBy(desc(goals.updatedAt))
    .get();
}

export function listRequirements(db: BrainDb, goalId: string): Requirement[] {
  return db.select().from(goalRequirements).where(eq(goalRequirements.goalId, goalId)).all();
}

const VALID_REQUIREMENT_TYPES = [
  'objective', 'constraint', 'success_criterion', 'exclusion', 'assumption',
];

export function addRequirement(
  db: BrainDb, goalId: string,
  input: { type: string; description: string; priority?: 'required' | 'optional' },
): Requirement {
  if (!VALID_REQUIREMENT_TYPES.includes(input.type)) {
    throw new Error(`Invalid requirement type: ${input.type}`);
  }
  const g = getGoal(db, goalId);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${goalId} is locked; requirements are frozen (§18).`);
  const res = db.insert(goalRequirements).values({
    goalId, requirementType: input.type, description: input.description,
    priority: input.priority ?? 'required',
  }).run();
  return db.select().from(goalRequirements)
    .where(eq(goalRequirements.id, Number(res.lastInsertRowid))).get()!;
}

const VALID_REQUIREMENT_STATUSES = ['PENDING', 'PASSED', 'FAILED', 'NOT_APPLICABLE'];

export function setRequirementStatus(
  db: BrainDb, requirementId: number,
  status: 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_APPLICABLE', reason?: string,
): void {
  if (!VALID_REQUIREMENT_STATUSES.includes(status)) {
    throw new Error(`Invalid requirement status: ${status}`);
  }
  if (status === 'NOT_APPLICABLE' && !reason) {
    throw new Error('NOT_APPLICABLE requires a status reason (§19).');
  }
  db.update(goalRequirements)
    .set({ status, statusReason: reason ?? null })
    .where(eq(goalRequirements.id, requirementId)).run();
}

function setStatus(db: BrainDb, id: string, status: string, extra: Partial<typeof goals.$inferInsert> = {}): Goal {
  db.update(goals).set({ status, updatedAt: now(), ...extra }).where(eq(goals.id, id)).run();
  return getGoal(db, id);
}

export function lockGoal(db: BrainDb, id: string): Goal {
  const g = getGoal(db, id);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${id} is already locked.`);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot lock.`);
  const snapshot = JSON.stringify({
    objective: g.objective,
    requirements: listRequirements(db, id).map(r => ({
      type: r.requirementType, description: r.description, priority: r.priority,
    })),
  });
  return setStatus(db, id, 'LOCKED', {
    lockedAt: now(), contractSnapshot: snapshot, clarificationStatus: 'complete',
  });
}

export function startGoal(db: BrainDb, id: string): Goal {
  const g = getGoal(db, id);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot start.`);
  if (!g.lockedAt) throw new Error(`Goal ${id} must be locked before starting (§10).`);
  return setStatus(db, id, 'EXECUTING', { startedAt: g.startedAt ?? now() });
}

export function blockGoal(db: BrainDb, id: string, reason: string): Goal {
  const g = getGoal(db, id);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot block.`);
  db.insert(observations).values({
    goalId: id, scopeType: 'GOAL', scopeId: `goal:${id}`,
    observation: `Goal blocked: ${reason}`, createdAt: now(),
  }).run();
  return setStatus(db, id, 'BLOCKED');
}

export function completeGoal(db: BrainDb, id: string, opts: { force?: boolean } = {}): Goal {
  const g = getGoal(db, id);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot complete.`);
  if (!opts.force) {
    const unmet = listRequirements(db, id).filter(r =>
      r.requirementType === 'success_criterion' && r.priority === 'required' &&
      !['PASSED', 'NOT_APPLICABLE'].includes(r.status));
    if (unmet.length > 0) {
      throw new IncompleteCriteriaError(
        `Cannot complete ${id}; unmet required success criteria (§64): ` +
        unmet.map(r => `#${r.id} ${r.description} [${r.status}]`).join('; '));
    }
  }
  return setStatus(db, id, 'COMPLETED', { completedAt: now() });
}

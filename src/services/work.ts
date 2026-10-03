import { asc, eq, inArray } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { workUnits, workUnitDependencies } from '../db/schema.js';
import { workUnitIdFor } from '../ids.js';
import { getGoal } from './goals.js';
import { touchGoal } from './activity.js';

export type WorkUnit = typeof workUnits.$inferSelect;

const now = () => new Date().toISOString();

export function createWorkUnit(db: BrainDb, input: {
  goalId: string; title: string; description?: string; workType?: string;
  complexity?: string; priority?: number; parentId?: string; dependsOn?: string[];
}): WorkUnit {
  getGoal(db, input.goalId);
  const id = workUnitIdFor(db, input.goalId);
  db.insert(workUnits).values({
    id, goalId: input.goalId, title: input.title,
    description: input.description ?? null, workType: input.workType ?? null,
    complexity: input.complexity ?? null,
    priority: input.priority ?? 100, parentId: input.parentId ?? null,
    status: 'PENDING', createdAt: now(),
  }).run();
  for (const dep of input.dependsOn ?? []) {
    db.insert(workUnitDependencies).values({ workUnitId: id, dependsOn: dep }).run();
  }
  touchGoal(db, input.goalId);
  return getWorkUnit(db, id);
}

export function getWorkUnit(db: BrainDb, id: string): WorkUnit {
  const wu = db.select().from(workUnits).where(eq(workUnits.id, id)).get();
  if (!wu) throw new Error(`Work unit not found: ${id}`);
  return wu;
}

const VALID_WORK_UNIT_STATUSES = [
  'PENDING', 'READY', 'RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED', 'BLOCKED', 'SKIPPED',
];

export function updateWorkUnit(db: BrainDb, id: string, patch: {
  status?: string; title?: string; description?: string; priority?: number;
}): WorkUnit {
  if (patch.status !== undefined && !VALID_WORK_UNIT_STATUSES.includes(patch.status)) {
    throw new Error(`Invalid work unit status: ${patch.status}`);
  }
  const wu = getWorkUnit(db, id);
  const set: Partial<typeof workUnits.$inferInsert> = { ...patch };
  if (patch.status === 'RUNNING') {
    set.startedAt = wu.startedAt ?? now();
    set.attemptCount = wu.attemptCount + 1;
  }
  if (patch.status === 'COMPLETED') set.completedAt = now();
  db.update(workUnits).set(set).where(eq(workUnits.id, id)).run();
  touchGoal(db, wu.goalId);
  return getWorkUnit(db, id);
}

export function listWorkUnits(db: BrainDb, goalId: string): WorkUnit[] {
  return db.select().from(workUnits)
    .where(eq(workUnits.goalId, goalId)).orderBy(asc(workUnits.id)).all();
}

export function readyWorkUnits(db: BrainDb, goalId: string): WorkUnit[] {
  const candidates = db.select().from(workUnits)
    .where(eq(workUnits.goalId, goalId)).orderBy(asc(workUnits.priority)).all()
    .filter(w => ['PENDING', 'READY'].includes(w.status));
  if (candidates.length === 0) return [];
  const deps = db.select().from(workUnitDependencies)
    .where(inArray(workUnitDependencies.workUnitId, candidates.map(c => c.id))).all();
  const done = new Set(
    db.select().from(workUnits).where(eq(workUnits.goalId, goalId)).all()
      .filter(w => ['COMPLETED', 'SKIPPED'].includes(w.status)).map(w => w.id));
  return candidates.filter(c =>
    deps.filter(d => d.workUnitId === c.id).every(d => done.has(d.dependsOn)));
}

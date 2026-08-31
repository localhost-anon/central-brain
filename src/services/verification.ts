import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { verificationRuns, goalRequirements } from '../db/schema.js';
import { listRequirements, setRequirementStatus, type Requirement } from './goals.js';

export type VerificationRun = typeof verificationRuns.$inferSelect;

const now = () => new Date().toISOString();

export function recordVerification(db: BrainDb, input: {
  passed: boolean; goalId?: string; workUnitId?: string; requirementId?: number;
  verificationType?: string; command?: string; expectedResult?: string; actualResult?: string;
}): VerificationRun {
  if (input.requirementId !== undefined) {
    const req = db.select().from(goalRequirements)
      .where(eq(goalRequirements.id, input.requirementId)).get();
    if (!req) throw new Error(`Requirement not found: ${input.requirementId}`);
    if (input.goalId !== undefined && req.goalId !== input.goalId) {
      throw new Error(`Requirement ${input.requirementId} belongs to ${req.goalId}, not ${input.goalId}`);
    }
  }
  const res = db.insert(verificationRuns).values({
    passed: input.passed ? 1 : 0, goalId: input.goalId ?? null,
    workUnitId: input.workUnitId ?? null, requirementId: input.requirementId ?? null,
    verificationType: input.verificationType ?? null, command: input.command ?? null,
    expectedResult: input.expectedResult ?? null, actualResult: input.actualResult ?? null,
    createdAt: now(),
  }).run();
  if (input.requirementId !== undefined) {
    setRequirementStatus(db, input.requirementId, input.passed ? 'PASSED' : 'FAILED');
  }
  return db.select().from(verificationRuns)
    .where(eq(verificationRuns.id, Number(res.lastInsertRowid))).get()!;
}

export function listVerifications(db: BrainDb, opts: { goalId?: string } = {}): VerificationRun[] {
  const q = db.select().from(verificationRuns);
  return opts.goalId ? q.where(eq(verificationRuns.goalId, opts.goalId)).all() : q.all();
}

export function goalVerificationState(db: BrainDb, goalId: string): {
  requirements: (Requirement & { runs: VerificationRun[] })[];
  allRequiredPassed: boolean;
} {
  const runs = listVerifications(db, { goalId });
  const requirements = listRequirements(db, goalId).map(r => ({
    ...r, runs: runs.filter(v => v.requirementId === r.id),
  }));
  const allRequiredPassed = requirements
    .filter(r => r.requirementType === 'success_criterion' && r.priority === 'required')
    .every(r => ['PASSED', 'NOT_APPLICABLE'].includes(r.status));
  return { requirements, allRequiredPassed };
}

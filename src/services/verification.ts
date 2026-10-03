import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { verificationRuns, goalRequirements, goals } from '../db/schema.js';
import { listRequirements, setRequirementStatus, type Requirement } from './goals.js';
import { touchGoal } from './activity.js';
import { VERDICTS } from './contract-rules.js';

export type VerificationRun = typeof verificationRuns.$inferSelect;

const now = () => new Date().toISOString();

export function recordVerification(db: BrainDb, input: {
  passed?: boolean; verdict?: 'verified' | 'partial' | 'failed'; goalId?: string; workUnitId?: string; requirementId?: number;
  verificationType?: string; command?: string; expectedResult?: string; actualResult?: string;
}): VerificationRun {
  if (input.verdict === undefined && input.passed === undefined) throw new Error('Provide verdict (verified|partial|failed) or passed.');
  if (input.verdict !== undefined && !(VERDICTS as readonly string[]).includes(input.verdict)) {
    throw new Error(`Invalid verdict: ${input.verdict}`);
  }
  const verdict = input.verdict ?? (input.passed ? 'verified' : 'failed');
  let req: typeof goalRequirements.$inferSelect | undefined;
  if (input.requirementId !== undefined) {
    req = db.select().from(goalRequirements).where(eq(goalRequirements.id, input.requirementId)).get();
    if (!req) throw new Error(`Requirement not found: ${input.requirementId}`);
    if (input.goalId !== undefined && req.goalId !== input.goalId) {
      throw new Error(`Requirement ${input.requirementId} belongs to ${req.goalId}, not ${input.goalId}`);
    }
    const goal = db.select().from(goals).where(eq(goals.id, req.goalId)).get()!;
    if (goal.rulesVersion >= 1 && verdict === 'verified') {
      if (!input.actualResult?.trim()) {
        throw new Error('A verified verdict needs actualResult (what was observed) — completion claims are not evidence.');
      }
      if (req.verifyMethod && input.verificationType !== req.verifyMethod) {
        throw new Error(`Criterion #${req.id} is verified by verify method "${req.verifyMethod}"; got verificationType "${input.verificationType ?? ''}".`);
      }
    }
  }
  const res = db.insert(verificationRuns).values({
    passed: verdict === 'verified' ? 1 : 0, verdict, goalId: input.goalId ?? req?.goalId ?? null,
    workUnitId: input.workUnitId ?? null, requirementId: input.requirementId ?? null,
    verificationType: input.verificationType ?? null, command: input.command ?? null,
    expectedResult: input.expectedResult ?? null, actualResult: input.actualResult ?? null,
    createdAt: now(),
  }).run();
  if (input.requirementId !== undefined) {
    setRequirementStatus(db, input.requirementId, verdict === 'verified' ? 'PASSED' : verdict === 'failed' ? 'FAILED' : 'PENDING');
  }
  touchGoal(db, input.goalId ?? req?.goalId);
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

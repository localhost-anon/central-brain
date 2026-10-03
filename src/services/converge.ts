import { and, eq, inArray } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { failures, goalRequirements, goals, verificationRuns, workUnitRequirements, workUnits } from '../db/schema.js';
import {
  coverageFindings, evidenceFindings, isConverged, principleFindings, sortFindings, type Finding, type ReqRow,
} from './contract-rules.js';
import { principleAckRows, principleRows } from './principle-rows.js';

export interface ConvergeReport {
  goalId: string; rulesVersion: number; converged: boolean; findings: Finding[];
  criteria: { id: number; description: string; verifyMethod: string | null; verdict: string | null; evidenceAt: string | null }[];
  nextAction: string;
}

/** Read-only: inventory the contract and judge the present evidence (spec-kit /converge). */
export function convergeGoal(db: BrainDb, goalId: string): ConvergeReport {
  const goal = db.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  const reqs: ReqRow[] = db.select().from(goalRequirements).where(eq(goalRequirements.goalId, goalId)).all()
    .map(r => ({ id: r.id, requirementType: r.requirementType, description: r.description, priority: r.priority,
      status: r.status, verifyMethod: r.verifyMethod, coverage: r.coverage }));
  const units = db.select().from(workUnits).where(eq(workUnits.goalId, goalId)).all();
  const links = units.length
    ? db.select().from(workUnitRequirements).where(inArray(workUnitRequirements.workUnitId, units.map(u => u.id))).all() : [];
  // Legacy runs (verdict NULL, pre-upgrade) are read as passed ? verified : failed.
  const runs = db.select().from(verificationRuns).where(eq(verificationRuns.goalId, goalId)).all()
    .map(r => ({ ...r, verdict: r.verdict ?? (r.passed ? 'verified' : 'failed') }));
  const open = db.select().from(failures).where(and(eq(failures.goalId, goalId), eq(failures.resolved, 0))).all();

  const findings = sortFindings([
    ...evidenceFindings(reqs, runs, units, open),
    // v1 (R8): a required criterion no work unit serves blocks completion, even from LOCKED.
    ...coverageFindings(reqs, units, links)
      .filter(f => f.kind === 'unrequested' || (goal.rulesVersion >= 1 && f.kind === 'uncovered')),
    ...principleFindings(principleRows(db, goalId), principleAckRows(db, goalId), 'converge'),
  ]);
  const criteria = reqs.filter(r => r.requirementType === 'success_criterion').map(r => {
    const last = runs.filter(x => x.requirementId === r.id && x.verdict)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).at(-1);
    return { id: r.id, description: r.description, verifyMethod: r.verifyMethod, verdict: last?.verdict ?? null, evidenceAt: last?.createdAt ?? null };
  });
  const converged = isConverged(findings);
  const top = findings[0];
  const nextAction = converged || !top
    ? 'Converged — complete the goal'
    : `fix ${top.severity} ${top.id} — ${top.message}`;
  return { goalId, rulesVersion: goal.rulesVersion, converged, findings, criteria, nextAction };
}

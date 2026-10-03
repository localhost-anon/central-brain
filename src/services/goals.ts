import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goals, goalRequirements, goalQuestions, observations, workUnits, workUnitRequirements } from '../db/schema.js';
import { nextGoalId } from '../ids.js';
import { addDecision } from './decisions.js';
import { isStale } from './activity.js';
import { coverageFindings, COVERAGE_CATEGORIES, lockFindings, uncoveredCategories, principleFindings, VERIFY_METHODS, type ReqRow } from './contract-rules.js';
import { principleAckRows, principleRows } from './principle-rows.js';

export type Goal = typeof goals.$inferSelect;
export type Requirement = typeof goalRequirements.$inferSelect;

export const ACTIVE_STATUSES = ['LOCKED', 'PLANNING', 'EXECUTING', 'VERIFYING', 'BLOCKED'];
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

export class GoalLockedError extends Error {}
export class IncompleteCriteriaError extends Error {}
export type GoalQuestion = typeof goalQuestions.$inferSelect;
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'IRREVERSIBLE'] as const;
export class ContractIncompleteError extends Error {}
export interface ContractGap { field: 'objective' | 'success_criterion' | 'scope' | 'risk_level'; message: string }
export interface ContractCheck { ready: boolean; gaps: ContractGap[]; openQuestions: GoalQuestion[] }

/** Case-insensitive; returns the canonical uppercase level (model routing already upper-cases). */
function normaliseRiskLevel(level: string): string {
  const up = level.trim().toUpperCase();
  if (!(RISK_LEVELS as readonly string[]).includes(up)) {
    throw new Error(`Invalid risk level: ${level} (expected ${RISK_LEVELS.join(', ')})`);
  }
  return up;
}

const now = () => new Date().toISOString();

export function createGoal(
  db: BrainDb,
  input: { title: string; objective: string; autonomyLevel?: string; riskLevel?: string; complexity?: string },
): Goal {
  const riskLevel = input.riskLevel !== undefined ? normaliseRiskLevel(input.riskLevel) : null;
  const id = nextGoalId(db);
  const ts = now();
  db.insert(goals).values({
    id, title: input.title, objective: input.objective,
    autonomyLevel: input.autonomyLevel ?? 'full', riskLevel,
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

export function currentGoal(db: BrainDb, opts: { now?: Date } = {}): Goal | undefined {
  return db.select().from(goals)
    .where(inArray(goals.status, ACTIVE_STATUSES))
    .orderBy(desc(goals.updatedAt))
    .all()
    .find(g => !isStale(g, opts.now));
}

export function staleGoals(db: BrainDb, at: Date = new Date()): Goal[] {
  return listGoals(db).filter(g => isStale(g, at));
}

export function cancelGoal(db: BrainDb, id: string, reason: string): Goal {
  const g = getGoal(db, id);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot cancel.`);
  if (!reason?.trim()) throw new Error('Cancelling a goal requires a reason.');
  db.insert(observations).values({
    goalId: id, scopeType: 'GOAL', scopeId: `goal:${id}`,
    observation: `Goal cancelled: ${reason.trim()}`, createdAt: now(),
  }).run();
  return setStatus(db, id, 'CANCELLED');
}

export const toReqRow = (r: Requirement): ReqRow => ({
  id: r.id, requirementType: r.requirementType, description: r.description, priority: r.priority,
  status: r.status, verifyMethod: r.verifyMethod, coverage: r.coverage,
});

export function listRequirements(db: BrainDb, goalId: string): Requirement[] {
  return db.select().from(goalRequirements).where(eq(goalRequirements.goalId, goalId)).all();
}

function contractGaps(db: BrainDb, goalId: string): ContractGap[] {
  const g = getGoal(db, goalId);
  const reqs = listRequirements(db, goalId);
  const gaps: ContractGap[] = [];
  if (!g.objective.trim()) gaps.push({ field: 'objective', message: 'Objective is empty' });
  if (!reqs.some(r => r.requirementType === 'success_criterion' && r.priority === 'required')) {
    gaps.push({ field: 'success_criterion', message: 'No required success criterion' });
  }
  if (!reqs.some(r => r.requirementType === 'scope')) gaps.push({ field: 'scope', message: 'No scope defined' });
  if (!g.riskLevel) gaps.push({ field: 'risk_level', message: 'Risk level not set' });
  return gaps;
}

function isFilledGapQuestion(q: GoalQuestion, gaps: ContractGap[], coverageDone = false): boolean {
  if (coverageDone && q.source === 'brain' && q.checkKey === 'review:coverage') return true;
  if (q.source !== 'brain' || !q.checkKey?.startsWith('missing:')) return false;
  return !gaps.some(x => `missing:${x.field}` === q.checkKey);
}

function coverageComplete(db: BrainDb, goalId: string): boolean {
  return uncoveredCategories(listRequirements(db, goalId).map(toReqRow)).length === 0;
}

function pendingMaterialQuestions(db: BrainDb, goalId: string): GoalQuestion[] {
  return db.select().from(goalQuestions).where(and(
    eq(goalQuestions.goalId, goalId), eq(goalQuestions.status, 'pending'), eq(goalQuestions.materiality, 'material'),
  )).all();
}

/**
 * The single definition of "open material question": pending + material, minus brain
 * `missing:<field>` gap questions whose field is now filled (they stop blocking as soon as
 * the contract covers them). Used by checkContract, refreshClarificationStatus and context.
 */
export function openMaterialQuestions(db: BrainDb, goalId: string): GoalQuestion[] {
  const gaps = contractGaps(db, goalId);
  const coverageDone = coverageComplete(db, goalId);
  return pendingMaterialQuestions(db, goalId).filter(q => !isFilledGapQuestion(q, gaps, coverageDone));
}

export function checkContract(db: BrainDb, goalId: string): ContractCheck {
  const gaps = contractGaps(db, goalId);
  const openQuestions = openMaterialQuestions(db, goalId);
  return { ready: gaps.length === 0 && openQuestions.length === 0, gaps, openQuestions };
}

export function setGoalFields(
  db: BrainDb, id: string, input: { riskLevel?: string; autonomyLevel?: string },
): Goal {
  const g = getGoal(db, id);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${id} is locked; contract fields are frozen (§18).`);
  const set: Partial<typeof goals.$inferInsert> = { updatedAt: now() };
  if (input.riskLevel !== undefined) set.riskLevel = normaliseRiskLevel(input.riskLevel);
  if (input.autonomyLevel !== undefined) set.autonomyLevel = input.autonomyLevel;
  db.update(goals).set(set).where(eq(goals.id, id)).run();
  return getGoal(db, id);
}

const VALID_REQUIREMENT_TYPES = [
  'objective', 'constraint', 'success_criterion', 'exclusion', 'assumption', 'scope', 'permission',
];

export function addRequirement(
  db: BrainDb, goalId: string,
  input: { type: string; description: string; priority?: 'required' | 'optional'; verifyMethod?: string; coverage?: string },
): Requirement {
  if (!VALID_REQUIREMENT_TYPES.includes(input.type)) {
    throw new Error(`Invalid requirement type: ${input.type}`);
  }
  if (input.verifyMethod !== undefined && !(VERIFY_METHODS as readonly string[]).includes(input.verifyMethod))
    throw new Error(`Invalid verify method: ${input.verifyMethod} (expected ${VERIFY_METHODS.join(', ')})`);
  if (input.coverage !== undefined && !(COVERAGE_CATEGORIES as readonly string[]).includes(input.coverage))
    throw new Error(`Invalid coverage: ${input.coverage} (expected ${COVERAGE_CATEGORIES.join(', ')})`);
  const g = getGoal(db, goalId);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${goalId} is locked; requirements are frozen (§18).`);
  const res = db.insert(goalRequirements).values({
    goalId, requirementType: input.type, description: input.description,
    priority: input.priority ?? 'required',
    verifyMethod: input.verifyMethod ?? null, coverage: input.coverage ?? null,
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

export function lockGoal(db: BrainDb, id: string, opts: { force?: boolean; reason?: string } = {}): Goal {
  const g = getGoal(db, id);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${id} is already locked.`);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot lock.`);
  if (opts.force && !opts.reason?.trim()) throw new Error('Force-locking requires a reason (recorded as a decision).');
  const check = checkContract(db, id);
  const v1 = [
    ...lockFindings(listRequirements(db, id).map(toReqRow)),
    ...principleFindings(principleRows(db, id), principleAckRows(db, id), 'lock'),
  ];
  const unresolved = [
    ...check.gaps.map(x => x.message),
    ...check.openQuestions.map(q => `open question #${q.id}: ${q.question}`),
    ...v1.map(x => x.message),
  ];
  const ready = check.ready && v1.length === 0;
  if (!ready && !opts.force) {
    throw new ContractIncompleteError(`Cannot lock ${id}; contract incomplete (§9): ${unresolved.join('; ')}`);
  }
  // Brain gap questions whose field is filled are answered before freezing (same as intake),
  // so a locked goal with no real open questions ends with clarificationStatus 'complete'.
  const coverageDone = coverageComplete(db, id);
  const filledGapQuestions = pendingMaterialQuestions(db, id).filter(q => isFilledGapQuestion(q, check.gaps, coverageDone));
  // better-sqlite3 transactions are connection-scoped, so addDecision(db, …) joins this transaction.
  db.transaction((tx) => {
    const ts = now();
    for (const q of filledGapQuestions) {
      tx.update(goalQuestions).set({ answer: q.checkKey === 'review:coverage' ? 'covered via contract' : 'filled via contract', status: 'answered', answeredAt: ts })
        .where(eq(goalQuestions.id, q.id)).run();
    }
    if (!ready) {
      addDecision(db, {
        goalId: id, decision: `Force-locked ${id} with an incomplete contract`,
        reason: `${opts.reason} | unresolved: ${unresolved.join('; ')}`, riskLevel: 'MEDIUM', reversible: true,
      });
    }
    const answered = tx.select().from(goalQuestions)
      .where(and(eq(goalQuestions.goalId, id), eq(goalQuestions.status, 'answered'))).all();
    const snapshot = JSON.stringify({
      objective: g.objective, riskLevel: g.riskLevel, autonomyLevel: g.autonomyLevel,
      requirements: listRequirements(db, id).map(r => ({
        type: r.requirementType, description: r.description, priority: r.priority,
      })),
      answeredQuestions: answered.map(q => ({ question: q.question, answer: q.answer })),
    });
    const clarificationStatus = check.openQuestions.length > 0 ? 'pending' : 'complete';
    tx.update(goals).set({
      status: 'LOCKED', updatedAt: ts, lockedAt: ts, contractSnapshot: snapshot, clarificationStatus, rulesVersion: 1,
    }).where(eq(goals.id, id)).run();
  });
  return getGoal(db, id);
}

export function startGoal(db: BrainDb, id: string): Goal {
  const g = getGoal(db, id);
  if (TERMINAL_STATUSES.includes(g.status)) throw new Error(`Goal ${id} is ${g.status}; cannot start.`);
  if (!g.lockedAt) throw new Error(`Goal ${id} must be locked before starting (§10).`);
  if (g.rulesVersion >= 1) {
    const units = db.select().from(workUnits).where(eq(workUnits.goalId, id)).all();
    const links = units.length
      ? db.select().from(workUnitRequirements).where(inArray(workUnitRequirements.workUnitId, units.map(u => u.id))).all()
      : [];
    const uncovered = coverageFindings(listRequirements(db, id).map(toReqRow), units, links)
      .filter(f => f.kind === 'uncovered');
    if (uncovered.length > 0) {
      throw new ContractIncompleteError(`Cannot start ${id}; plan does not cover the contract: ${uncovered.map(f => f.message).join('; ')}`);
    }
  }
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

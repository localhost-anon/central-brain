import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { decisions, observations, approvals } from '../db/schema.js';
import { parsePrefixedId } from '../ids.js';

export type Decision = typeof decisions.$inferSelect;
export type Observation = typeof observations.$inferSelect;
export type Approval = typeof approvals.$inferSelect;

const now = () => new Date().toISOString();
const assertScope = (scopeId?: string) => { if (scopeId) parsePrefixedId(scopeId); };

export function addDecision(db: BrainDb, input: {
  decision: string; goalId?: string; scopeType?: string; scopeId?: string;
  reason?: string; alternatives?: string; riskLevel?: string;
  reversible?: boolean; executor?: string;
}): Decision {
  assertScope(input.scopeId);
  const res = db.insert(decisions).values({
    decision: input.decision, goalId: input.goalId ?? null,
    scopeType: input.scopeType ?? null, scopeId: input.scopeId ?? null,
    reason: input.reason ?? null, alternatives: input.alternatives ?? null,
    riskLevel: input.riskLevel ?? null,
    reversible: input.reversible === false ? 0 : 1,
    executor: input.executor ?? null, createdAt: now(),
  }).run();
  return db.select().from(decisions).where(eq(decisions.id, Number(res.lastInsertRowid))).get()!;
}

export function listDecisions(db: BrainDb, opts: { goalId?: string } = {}): Decision[] {
  const q = db.select().from(decisions);
  return opts.goalId ? q.where(eq(decisions.goalId, opts.goalId)).all() : q.all();
}

export function addObservation(db: BrainDb, input: {
  observation: string; goalId?: string; workUnitId?: string;
  scopeType?: string; scopeId?: string; confidence?: number;
}): Observation {
  assertScope(input.scopeId);
  const res = db.insert(observations).values({
    observation: input.observation, goalId: input.goalId ?? null,
    workUnitId: input.workUnitId ?? null, scopeType: input.scopeType ?? null,
    scopeId: input.scopeId ?? null, confidence: input.confidence ?? 1, createdAt: now(),
  }).run();
  return db.select().from(observations).where(eq(observations.id, Number(res.lastInsertRowid))).get()!;
}

export function addApproval(db: BrainDb, input: {
  action: string; riskLevel: string; goalId?: string; decisionId?: number;
}): Approval {
  const res = db.insert(approvals).values({
    action: input.action, riskLevel: input.riskLevel,
    goalId: input.goalId ?? null, decisionId: input.decisionId ?? null,
    requestedAt: now(),
  }).run();
  return db.select().from(approvals).where(eq(approvals.id, Number(res.lastInsertRowid))).get()!;
}

export function resolveApproval(db: BrainDb, id: number, status: 'approved' | 'denied'): Approval {
  const a = db.select().from(approvals).where(eq(approvals.id, id)).get();
  if (!a) throw new Error(`Approval not found: ${id}`);
  db.update(approvals).set({ status, resolvedAt: now() }).where(eq(approvals.id, id)).run();
  return db.select().from(approvals).where(eq(approvals.id, id)).get()!;
}

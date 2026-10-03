import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goalPrincipleAcks, goalProjects } from '../db/schema.js';
import { touchGoal } from './activity.js';
import { addDecision } from './decisions.js';
import { getGoal, GoalLockedError } from './goals.js';
import { principleAckRows, principleRows } from './principle-rows.js';
import { getProject } from './projects.js';

export type GoalPrincipleAck = typeof goalPrincipleAcks.$inferSelect;

export function linkGoalProject(db: BrainDb, goalId: string, projectIdOrName: string): { goalId: string; projectId: string } {
  getGoal(db, goalId);
  const projectId = getProject(db, projectIdOrName).id;
  db.insert(goalProjects).values({ goalId, projectId }).onConflictDoNothing().run();
  touchGoal(db, goalId);
  return { goalId, projectId };
}

export function goalProjectIds(db: BrainDb, goalId: string): string[] {
  return db.select().from(goalProjects).where(eq(goalProjects.goalId, goalId)).all().map(r => r.projectId);
}

export const applicablePrinciples = principleRows;
export const listPrincipleAcks = principleAckRows;

export function ackPrinciple(
  db: BrainDb,
  input: { goalId: string; knowledgeId: number; mode: 'honoured' | 'exception'; note: string },
): GoalPrincipleAck {
  const g = getGoal(db, input.goalId);
  if (g.lockedAt) throw new GoalLockedError(`Goal ${input.goalId} is locked; principle acks are frozen.`);
  if (input.mode !== 'honoured' && input.mode !== 'exception') throw new Error(`Invalid ack mode: ${input.mode}`);
  if (!input.note?.trim()) throw new Error('Acknowledging a principle requires a note.');
  const p = applicablePrinciples(db, input.goalId).find(x => x.id === input.knowledgeId);
  if (!p) throw new Error(`Knowledge #${input.knowledgeId} is not applicable to ${input.goalId}.`);
  const prior = principleAckRows(db, input.goalId).find(a => a.knowledgeId === input.knowledgeId);
  let decisionId: number | null = null;
  if (input.mode === 'exception' && prior?.mode === 'exception') decisionId = prior.decisionId;
  else if (input.mode === 'exception') {
    decisionId = addDecision(db, {
      goalId: input.goalId, decision: `Principle exception: ${p.statement}`,
      reason: input.note.trim(), riskLevel: 'MEDIUM', reversible: true,
    }).id;
  }
  db.insert(goalPrincipleAcks).values({
    goalId: input.goalId, knowledgeId: input.knowledgeId, mode: input.mode,
    note: input.note.trim(), decisionId, createdAt: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: [goalPrincipleAcks.goalId, goalPrincipleAcks.knowledgeId],
    set: { mode: input.mode, note: input.note.trim(), decisionId },
  }).run();
  touchGoal(db, input.goalId);
  return listPrincipleAcks(db, input.goalId).find(a => a.knowledgeId === input.knowledgeId)!;
}

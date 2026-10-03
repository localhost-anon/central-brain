import { and, eq, inArray, or } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goalPrincipleAcks, goalProjects, knowledge } from '../db/schema.js';

/** Active `principle` knowledge: GLOBAL, or PROJECT-scoped to a project linked to the goal. */
export function principleRows(db: BrainDb, goalId: string): { id: number; statement: string; scopeId: string | null }[] {
  const scopes = db.select().from(goalProjects).where(eq(goalProjects.goalId, goalId)).all()
    .map(r => `project:${r.projectId}`);
  const scoped = scopes.length
    ? or(eq(knowledge.scopeType, 'GLOBAL'), and(eq(knowledge.scopeType, 'PROJECT'), inArray(knowledge.scopeId, scopes)))
    : eq(knowledge.scopeType, 'GLOBAL');
  return db.select().from(knowledge)
    .where(and(eq(knowledge.status, 'active'), eq(knowledge.category, 'principle'), scoped)).all()
    .map(k => ({ id: k.id, statement: k.statement, scopeId: k.scopeId }));
}

export function principleAckRows(db: BrainDb, goalId: string) {
  return db.select().from(goalPrincipleAcks).where(eq(goalPrincipleAcks.goalId, goalId)).all();
}

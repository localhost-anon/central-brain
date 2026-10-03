import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, makeLockable } from './helpers.js';
import { createGoal, addRequirement, lockGoal, getGoal, setGoalFields, ContractIncompleteError, GoalLockedError } from '../src/services/goals.js';
import { addProject } from '../src/services/projects.js';
import { addKnowledge } from '../src/services/knowledge.js';
import { knowledge } from '../src/db/schema.js';
import {
  linkGoalProject, applicablePrinciples, ackPrinciple, listPrincipleAcks, goalProjectIds,
} from '../src/services/principles.js';
import { principleRows } from '../src/services/principle-rows.js';
import { listDecisions } from '../src/services/decisions.js';
import type { BrainDb } from '../src/db/connection.js';

function draft(db: BrainDb, criterion: string, verifyMethod?: string) {
  const g = createGoal(db, { title: 't', objective: 'o' });
  setGoalFields(db, g.id, { riskLevel: 'LOW' });
  addRequirement(db, g.id, { type: 'scope', description: 'scope' });
  addRequirement(db, g.id, { type: 'success_criterion', description: criterion, verifyMethod });
  return g;
}

describe('v1 lock gate', () => {
  it('refuses a non-atomic criterion', () => {
    const db = createTestDb();
    const g = draft(db, '1) login works 2) logout works', 'test');
    expect(() => lockGoal(db, g.id)).toThrow(ContractIncompleteError);
    expect(() => lockGoal(db, g.id)).toThrow(/one requirement per claim/);
  });

  it('refuses a criterion without a verify method', () => {
    const db = createTestDb();
    const g = draft(db, 'login works');
    expect(() => lockGoal(db, g.id)).toThrow(/no verify method|verify method/);
  });

  it('locks an atomic, method-tagged criterion and sets rules_version 1', () => {
    const db = createTestDb();
    const g = lockGoal(db, draft(db, 'login works', 'test').id);
    expect(g.rulesVersion).toBe(1);
  });

  it('validates verifyMethod and coverage values', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => addRequirement(db, g.id, { type: 'success_criterion', description: 'x', verifyMethod: 'vibes' })).toThrow(/verify method/);
    expect(() => addRequirement(db, g.id, { type: 'constraint', description: 'x', coverage: 'misc' })).toThrow(/coverage/);
  });

  it('principles: GLOBAL + linked project apply; lock refuses until acknowledged', () => {
    const db = createTestDb();
    const p = addProject(db, { name: 'market' });
    const glob = addKnowledge(db, { statement: 'No secrets in Brain', category: 'principle', scopeType: 'GLOBAL' });
    const proj = addKnowledge(db, { statement: 'Sandbox first', category: 'principle', scopeType: 'PROJECT', scopeId: `project:${p.id}` });
    addKnowledge(db, { statement: 'Other project rule', category: 'principle', scopeType: 'PROJECT', scopeId: 'project:elsewhere' });
    const g = draft(db, 'strategy runs in analyzer', 'inspection');
    linkGoalProject(db, g.id, 'market');
    expect(goalProjectIds(db, g.id)).toEqual([p.id]);
    expect(applicablePrinciples(db, g.id).map(x => x.id).sort()).toEqual([glob.id, proj.id].sort());
    expect(() => lockGoal(db, g.id)).toThrow(/Sandbox first/);
    ackPrinciple(db, { goalId: g.id, knowledgeId: glob.id, mode: 'honoured', note: 'no secrets stored' });
    ackPrinciple(db, { goalId: g.id, knowledgeId: proj.id, mode: 'exception', note: 'read-only goal, no orders' });
    expect(listPrincipleAcks(db, g.id)).toHaveLength(2);
    expect(lockGoal(db, g.id).status).toBe('LOCKED');
  });

  it('principleRows ignores inactive principles', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { statement: 'Old rule', category: 'principle', scopeType: 'GLOBAL' });
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(principleRows(db, g.id).map(x => x.id)).toEqual([k.id]);
    db.update(knowledge).set({ status: 'invalid' }).where(eq(knowledge.id, k.id)).run();
    expect(principleRows(db, g.id)).toEqual([]);
  });

  it('makeLockable helper produces a lockable v1 goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    expect(lockGoal(db, g.id).status).toBe('LOCKED');
    expect(getGoal(db, g.id).rulesVersion).toBe(1);
  });

  it('ack rejects a non-applicable principle', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { statement: 'x', category: 'principle', scopeType: 'PROJECT', scopeId: 'project:elsewhere' });
    const g = draft(db, 'y', 'test');
    expect(() => ackPrinciple(db, { goalId: g.id, knowledgeId: k.id, mode: 'honoured', note: 'n' })).toThrow(/not applicable/);
  });

  it('force-lock with reason bypasses a blob criterion and records a decision', () => {
    const db = createTestDb();
    const g = draft(db, '(1) a (2) b', 'test');
    expect(lockGoal(db, g.id, { force: true, reason: 'spike' }).rulesVersion).toBe(1);
    expect(listDecisions(db, { goalId: g.id })[0]!.reason).toContain('several claims');
  });

  it('exception ack creates one decision, stored in decisionId, reused on re-ack', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { statement: 'Rule R', category: 'principle', scopeType: 'GLOBAL' });
    const g = draft(db, 'y', 'test');
    const a1 = ackPrinciple(db, { goalId: g.id, knowledgeId: k.id, mode: 'exception', note: 'because' });
    const ds = listDecisions(db, { goalId: g.id }).filter(d => d.decision.includes('Principle exception'));
    expect(ds).toHaveLength(1);
    expect(a1.decisionId).toBe(ds[0]!.id);
    const a2 = ackPrinciple(db, { goalId: g.id, knowledgeId: k.id, mode: 'exception', note: 'still because' });
    expect(a2.decisionId).toBe(a1.decisionId);
    expect(listDecisions(db, { goalId: g.id }).filter(d => d.decision.includes('Principle exception'))).toHaveLength(1);
  });

  it('ack on a locked goal is refused', () => {
    const db = createTestDb();
    const k = addKnowledge(db, { statement: 'Rule R', category: 'principle', scopeType: 'GLOBAL' });
    const g = draft(db, 'y', 'test');
    ackPrinciple(db, { goalId: g.id, knowledgeId: k.id, mode: 'honoured', note: 'ok' });
    lockGoal(db, g.id);
    expect(() => ackPrinciple(db, { goalId: g.id, knowledgeId: k.id, mode: 'exception', note: 'downgrade' })).toThrow(GoalLockedError);
  });
});

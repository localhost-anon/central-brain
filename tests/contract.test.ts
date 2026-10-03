import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import {
  createGoal, addRequirement, checkContract, lockGoal, setGoalFields, getGoal, ContractIncompleteError,
} from '../src/services/goals.js';
import { listDecisions } from '../src/services/decisions.js';

function addOpenQuestion(db: ReturnType<typeof createTestDb>, goalId: string, q: string) {
  db.$client.prepare('INSERT INTO goal_questions (goal_id, question, created_at) VALUES (?, ?, ?)')
    .run(goalId, q, new Date().toISOString());
}

describe('goal contract (§9) and lock gate', () => {
  it('reports each missing field, then ready once filled', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'SSO', objective: 'Users sign in with Microsoft' });
    expect(checkContract(db, g.id).gaps.map(x => x.field).sort())
      .toEqual(['risk_level', 'scope', 'success_criterion']);
    addRequirement(db, g.id, { type: 'success_criterion', description: 'MS login works', verifyMethod: 'test' });
    addRequirement(db, g.id, { type: 'scope', description: 'auth service + login UI' });
    setGoalFields(db, g.id, { riskLevel: 'HIGH' });
    expect(checkContract(db, g.id)).toMatchObject({ ready: true, gaps: [] });
  });

  it('optional success criteria do not satisfy the gate; open material questions block', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', riskLevel: 'LOW' });
    addRequirement(db, g.id, { type: 'scope', description: 's' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'nice', priority: 'optional' });
    expect(checkContract(db, g.id).gaps.map(x => x.field)).toEqual(['success_criterion']);
    addRequirement(db, g.id, { type: 'success_criterion', description: 'must', verifyMethod: 'test' });
    addOpenQuestion(db, g.id, 'Keep password login?');
    const c = checkContract(db, g.id);
    expect(c.ready).toBe(false);
    expect(c.openQuestions.map(q => q.question)).toEqual(['Keep password login?']);
  });

  it('lock refuses an incomplete contract and lists what is missing', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => lockGoal(db, g.id)).toThrow(ContractIncompleteError);
    expect(() => lockGoal(db, g.id)).toThrow(/scope/);
    expect(getGoal(db, g.id).status).toBe('DRAFT');
  });

  it('--force requires a reason, records a decision, keeps clarification pending', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addOpenQuestion(db, g.id, 'Keep password login?');
    expect(() => lockGoal(db, g.id, { force: true })).toThrow(/reason/);
    const locked = lockGoal(db, g.id, { force: true, reason: 'spike, contract later' });
    expect(locked.status).toBe('LOCKED');
    expect(locked.clarificationStatus).toBe('pending');
    const d = listDecisions(db, { goalId: g.id });
    expect(d).toHaveLength(1);
    expect(d[0]!.riskLevel).toBe('MEDIUM');
    expect(d[0]!.reason).toContain('spike, contract later');
    expect(d[0]!.reason).toContain('Keep password login?');
  });

  it('snapshot freezes risk, autonomy and answered questions', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', riskLevel: 'LOW' });
    addRequirement(db, g.id, { type: 'scope', description: 's' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'c', verifyMethod: 'test' });
    db.$client.prepare("INSERT INTO goal_questions (goal_id, question, answer, status, created_at) VALUES (?, 'Q?', 'A.', 'answered', ?)")
      .run(g.id, new Date().toISOString());
    const snap = JSON.parse(lockGoal(db, g.id).contractSnapshot!);
    expect(snap).toMatchObject({ riskLevel: 'LOW', autonomyLevel: 'full', answeredQuestions: [{ question: 'Q?', answer: 'A.' }] });
    expect(snap.requirements).toHaveLength(2);
  });

  it('risk levels are validated case-insensitively and stored uppercase; locked goals refuse edits', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => setGoalFields(db, g.id, { riskLevel: 'medium-ish' })).toThrow(/risk level/i);
    expect(() => createGoal(db, { title: 'x', objective: 'y', riskLevel: 'extreme' })).toThrow(/risk level/i);
    expect(createGoal(db, { title: 'x', objective: 'y', riskLevel: 'high' }).riskLevel).toBe('HIGH');
    expect(setGoalFields(db, g.id, { riskLevel: 'irreversible' }).riskLevel).toBe('IRREVERSIBLE');
    lockGoal(db, g.id, { force: true, reason: 'test' });
    expect(() => setGoalFields(db, g.id, { riskLevel: 'LOW' })).toThrow(/locked/);
  });

  it('accepts scope and permission requirement types', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(addRequirement(db, g.id, { type: 'permission', description: 'may deploy staging' }).requirementType).toBe('permission');
  });
});

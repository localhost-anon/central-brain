import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable } from './helpers.js';
import { createGoal, getGoal, listRequirements, checkContract, lockGoal, setGoalFields, addRequirement } from '../src/services/goals.js';
import {
  addQuestion, answerQuestion, dismissQuestion, listQuestions, upsertBrainQuestion,
} from '../src/services/questions.js';

describe('goal questions', () => {
  it('add → answer --as creates a linked requirement; clarification status tracks open material questions', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const q = addQuestion(db, g.id, { question: 'Keep password login?' });
    expect(q).toMatchObject({ status: 'pending', materiality: 'material', source: 'session' });
    expect(getGoal(db, g.id).clarificationStatus).toBe('pending');
    const a = answerQuestion(db, q.id, 'Yes, keep it as fallback', { as: 'constraint' });
    expect(a.status).toBe('answered');
    const req = listRequirements(db, g.id).find(r => r.id === a.requirementId)!;
    expect(req).toMatchObject({ requirementType: 'constraint', description: 'Yes, keep it as fallback' });
    expect(getGoal(db, g.id).clarificationStatus).toBe('complete');
  });

  it('detail questions never block; dismiss needs a reason', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addQuestion(db, g.id, { question: 'Service class name?', materiality: 'detail' });
    expect(getGoal(db, g.id).clarificationStatus).toBe('complete');
    const q = addQuestion(db, g.id, { question: 'Provision new users?' });
    expect(() => dismissQuestion(db, q.id, ' ')).toThrow(/reason/);
    expect(dismissQuestion(db, q.id, 'implementation detail').status).toBe('dismissed');
    expect(listQuestions(db, g.id, { open: true }).map(x => x.question)).toEqual(['Service class name?']);
  });

  it('invalid --as leaves the question pending and writes no requirement (Review Focus 5)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const q = addQuestion(db, g.id, { question: 'Q?' });
    expect(() => answerQuestion(db, q.id, 'A', { as: 'objective' })).toThrow(/--as/);
    expect(listQuestions(db, g.id)[0]!.status).toBe('pending');
    expect(listRequirements(db, g.id)).toHaveLength(0);
  });

  it('answering twice, empty answers, and edits after lock are rejected', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const q = addQuestion(db, g.id, { question: 'Q?' });
    expect(() => answerQuestion(db, q.id, '  ')).toThrow(/empty/);
    answerQuestion(db, q.id, 'A');
    expect(() => answerQuestion(db, q.id, 'B')).toThrow(/answered/);
    const q2 = addQuestion(db, g.id, { question: 'Q2?', materiality: 'detail' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    expect(() => addQuestion(db, g.id, { question: 'late' })).toThrow(/locked/);
    expect(() => answerQuestion(db, q2.id, 'late')).toThrow(/locked/);
  });

  it('upsertBrainQuestion is idempotent per check key', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(upsertBrainQuestion(db, g.id, 'missing:scope', 'What is in scope?').created).toBe(true);
    expect(upsertBrainQuestion(db, g.id, 'missing:scope', 'What is in scope?').created).toBe(false);
    expect(listQuestions(db, g.id)).toHaveLength(1);
    expect(listQuestions(db, g.id)[0]).toMatchObject({ source: 'brain', checkKey: 'missing:scope' });
  });

  it('filling a field directly unblocks its brain gap question (Review Focus 1)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    upsertBrainQuestion(db, g.id, 'missing:scope', 'What is in scope?');
    addRequirement(db, g.id, { type: 'scope', description: 'auth only' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'c' });
    setGoalFields(db, g.id, { riskLevel: 'LOW' });
    expect(checkContract(db, g.id).ready).toBe(true);
  });
});

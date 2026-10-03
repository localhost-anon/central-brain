import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal, addRequirement, lockGoal, setGoalFields, listRequirements, checkContract } from '../src/services/goals.js';
import { buildIntakeReport } from '../src/services/intake.js';
import { addQuestion, listQuestions, answerQuestion } from '../src/services/questions.js';
import type { Embedder } from '../src/services/embedder.js';

const failingEmbedder: Embedder = { model: 'none', embed: async () => { throw new Error('offline'); } };

describe('intake coverage + question cap', () => {
  it('upserts one review:coverage question listing uncovered categories, idempotently', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addRequirement(db, g.id, { type: 'constraint', description: 'c', coverage: 'data' });
    const r1 = await buildIntakeReport(db, failingEmbedder, g.id);
    await buildIntakeReport(db, failingEmbedder, g.id);
    const cov = listQuestions(db, g.id).filter(q => q.checkKey === 'review:coverage');
    expect(cov).toHaveLength(1);
    expect(cov[0]!.question).toContain('failure_modes');
    expect(cov[0]!.question).not.toContain(' data,');
    expect(r1.uncoveredCategories).not.toContain('data');
    answerQuestion(db, cov[0]!.id, 'n/a: integration — standalone; rest covered');
    const r3 = await buildIntakeReport(db, failingEmbedder, g.id);
    expect(r3.openQuestions.some(q => q.checkKey === 'review:coverage')).toBe(false);
    expect(listQuestions(db, g.id).filter(q => q.checkKey === 'review:coverage')).toHaveLength(1);
  });

  it('flags no project link as a review item', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = await buildIntakeReport(db, failingEmbedder, g.id);
    expect(r.reviewItems.some(i => i.kind === 'no_project_link')).toBe(true);
  });

  it('caps material session questions at 5; detail and brain questions do not count', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    for (let i = 0; i < 5; i++) addQuestion(db, g.id, { question: `q${i}?`, recommended: `A${i}` });
    addQuestion(db, g.id, { question: 'detail?', materiality: 'detail' });
    addQuestion(db, g.id, { question: 'brain?', source: 'brain', checkKey: 'review:x' });
    expect(() => addQuestion(db, g.id, { question: 'sixth?' })).toThrow(/at most 5/);
    expect(listQuestions(db, g.id).find(q => q.question === 'q0?')!.recommended).toBe('A0');
  });

  const fillContract = (db: any, id: string) => {
    addRequirement(db, id, { type: 'scope', description: 's' });
    setGoalFields(db, id, { riskLevel: 'LOW' });
  };
  const ALL = ['behaviour', 'data', 'failure_modes', 'edge_cases', 'non_functional', 'integration', 'completion'] as const;

  it('tagging remaining categories after the question exists unblocks lock; intake auto-answers it', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'c', verifyMethod: 'test', coverage: 'behaviour' });
    fillContract(db, g.id);
    await buildIntakeReport(db, failingEmbedder, g.id);
    answerQuestion(db, listQuestions(db, g.id).find(q => q.checkKey === 'review:behaviour')!.id, 'none');
    expect(checkContract(db, g.id).ready).toBe(false);
    for (const c of ALL.slice(1)) addRequirement(db, g.id, { type: 'constraint', description: `c-${c}`, coverage: c });
    expect(checkContract(db, g.id).ready).toBe(true);
    const r = await buildIntakeReport(db, failingEmbedder, g.id);
    const cov = listQuestions(db, g.id).find(q => q.checkKey === 'review:coverage')!;
    expect(cov.status).toBe('answered');
    expect(cov.answer).toBe('covered via contract');
    expect(r.openQuestions.some(q => q.checkKey === 'review:coverage')).toBe(false);
  });

  it('lockGoal answers a pending coverage question once fully covered', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'c', verifyMethod: 'test', coverage: 'behaviour' });
    fillContract(db, g.id);
    await buildIntakeReport(db, failingEmbedder, g.id);
    answerQuestion(db, listQuestions(db, g.id).find(q => q.checkKey === 'review:behaviour')!.id, 'none');
    for (const c of ALL.slice(1)) addRequirement(db, g.id, { type: 'constraint', description: `c-${c}`, coverage: c });
    lockGoal(db, g.id);
    expect(listQuestions(db, g.id).find(q => q.checkKey === 'review:coverage')!.answer).toBe('covered via contract');
  });

  it('answerQuestion --as success_criterion with verifyMethod/coverage yields a lockable criterion', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const q = addQuestion(db, g.id, { question: 'how verified?' });
    answerQuestion(db, q.id, 'login works', { as: 'success_criterion', verifyMethod: 'test', coverage: 'behaviour' });
    const req = listRequirements(db, g.id).find(r => r.description === 'login works')!;
    expect(req.verifyMethod).toBe('test');
    expect(req.coverage).toBe('behaviour');
    fillContract(db, g.id);
    for (const c of ALL.slice(1)) addRequirement(db, g.id, { type: 'constraint', description: `c-${c}`, coverage: c });
    expect(lockGoal(db, g.id).status).toBe('LOCKED');
  });

  it('verifyMethod without --as is rejected', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const q = addQuestion(db, g.id, { question: 'x?' });
    expect(() => answerQuestion(db, q.id, 'a', { verifyMethod: 'test' })).toThrow(/require --as/);
  });
});

import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable, satisfyCriteria } from './helpers.js';
import { createGoal, lockGoal, completeGoal, getGoal, listRequirements } from '../src/services/goals.js';
import { convergeGoal } from '../src/services/converge.js';
import { listDecisions } from '../src/services/decisions.js';

describe('never-locked goals cannot complete (I1 / R7)', () => {
  it('refuses a DRAFT goal with satisfied criteria', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    satisfyCriteria(db, g.id);
    expect(() => completeGoal(db, g.id)).toThrow(`Goal ${g.id} was never locked; lock its contract first (or force with a reason)`);
    expect(getGoal(db, g.id).status).toBe('DRAFT');
  });

  it('refuses a never-locked v0 goal too', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    db.$client.prepare('UPDATE goals SET rules_version = 0 WHERE id = ?').run(g.id);
    expect(() => completeGoal(db, g.id)).toThrow(/never locked/);
  });

  it('force with a reason still completes (forced, MEDIUM decision)', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(() => completeGoal(db, g.id, { force: true })).toThrow(/reason/);
    const done = completeGoal(db, g.id, { force: true, reason: 'abandoned draft' });
    expect(done.completionMode).toBe('forced');
    expect(listDecisions(db, { goalId: g.id }).some(d => d.riskLevel === 'MEDIUM')).toBe(true);
  });
});

describe('v1 completion requires covered criteria (I2 / R8)', () => {
  it('LOCKED goal with zero work units cannot complete; uncovered criterion is named', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    satisfyCriteria(db, g.id);
    const crit = listRequirements(db, g.id).find(r => r.requirementType === 'success_criterion')!;
    const rep = convergeGoal(db, g.id);
    expect(rep.findings.some(f => f.kind === 'uncovered' && f.severity === 'CRITICAL')).toBe(true);
    expect(() => completeGoal(db, g.id)).toThrow(new RegExp(`No work unit serves criterion #${crit.id}`));
  });

  it('v0 converge does not report uncovered', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    db.$client.prepare('UPDATE goals SET rules_version = 0 WHERE id = ?').run(g.id);
    expect(convergeGoal(db, g.id).findings.some(f => f.kind === 'uncovered')).toBe(false);
  });
});

import { fakeEmbedder } from '../src/services/embedder.js';
import { buildIntakeReport } from '../src/services/intake.js';
import { addRequirement } from '../src/services/goals.js';
import { listQuestions, answerQuestion } from '../src/services/questions.js';
import { addKnowledge } from '../src/services/knowledge.js';
import { ackPrinciple } from '../src/services/principles.js';

async function clearQuestions(db: ReturnType<typeof createTestDb>, goalId: string) {
  await buildIntakeReport(db, fakeEmbedder(), goalId);
  for (const q of listQuestions(db, goalId, { open: true })) answerQuestion(db, q.id, 'n/a: all categories — test');
}

describe('intake folds lock blockers into ready/nextAction (I3)', () => {
  it('non-atomic criterion and missing verify method block ready and name the fix', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    const multi = addRequirement(db, g.id, { type: 'success_criterion', description: '(1) login works (2) logout works', verifyMethod: 'test' });
    const bare = addRequirement(db, g.id, { type: 'success_criterion', description: 'export works' });
    await clearQuestions(db, g.id);
    const r = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r.ready).toBe(false);
    expect(r.lockBlockers.map(f => f.kind).sort()).toEqual(['no_verify_method', 'non_atomic']);
    expect(r.nextAction).toBe(`split criterion #${multi.id}; add verify method to #${bare.id}`);
    expect(() => lockGoal(db, g.id)).toThrow(/contract incomplete/);
  });

  it('unacknowledged principle blocks ready until acked', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    const p = addKnowledge(db, { statement: 'No secrets in Brain', category: 'principle', scopeType: 'GLOBAL' });
    await clearQuestions(db, g.id);
    const r = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r.ready).toBe(false);
    expect(r.nextAction).toBe('acknowledge 1 principle(s) (principle ack)');
    ackPrinciple(db, { goalId: g.id, knowledgeId: p.id, mode: 'honoured', note: 'none stored' });
    const r2 = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r2.ready).toBe(true);
    expect(r2.lockBlockers).toEqual([]);
    expect(r2.nextAction).toBe('ready to lock');
    expect(lockGoal(db, g.id).status).toBe('LOCKED');
  });
});

import { resumeGoal } from '../src/services/resume.js';
import { startGoal, setRequirementStatus } from '../src/services/goals.js';
import { updateWorkUnit } from '../src/services/work.js';
import { makeStartable } from './helpers.js';

describe('resume keeps the legacy order for v0 goals (I4)', () => {
  function executing(db: ReturnType<typeof createTestDb>, rulesVersion: number) {
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    db.$client.prepare('UPDATE goals SET rules_version = ? WHERE id = ?').run(rulesVersion, g.id);
    const wu = makeStartable(db, g.id);
    startGoal(db, g.id);
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    for (const r of listRequirements(db, g.id).filter(x => x.requirementType === 'success_criterion')) {
      setRequirementStatus(db, r.id, 'PASSED');
    }
    return g;
  }

  it('v0: PASSED criteria without runs → complete, converge embedded as information', () => {
    const db = createTestDb();
    const g = executing(db, 0);
    const r = resumeGoal(db, g.id);
    expect(r.nextRecommendedAction).toBe('All criteria passed — complete the goal');
    expect(r.converge?.converged).toBe(false);
  });

  it('v1: the same state recommends fixing the converge finding', () => {
    const db = createTestDb();
    const g = executing(db, 1);
    expect(resumeGoal(db, g.id).nextRecommendedAction).toMatch(/^fix CRITICAL /);
  });
});

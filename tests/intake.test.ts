import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable } from './helpers.js';
import { fakeEmbedder, type Embedder } from '../src/services/embedder.js';
import { reindexEmbeddings } from '../src/services/embedding-store.js';
import { buildIntakeReport } from '../src/services/intake.js';
import { createGoal, addRequirement, lockGoal } from '../src/services/goals.js';
import { listQuestions, answerQuestion, dismissQuestion } from '../src/services/questions.js';
import { addDecision } from '../src/services/decisions.js';

const broken: Embedder = { model: 'broken', async embed() { throw new Error('model unavailable'); } };

describe('intake report', () => {
  it('creates one brain question per gap, idempotently, and names the next action', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Add SSO', objective: 'Users sign in with Microsoft' });
    const r1 = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r1.ready).toBe(false);
    expect(r1.gaps.map(x => x.field).sort()).toEqual(['risk_level', 'scope', 'success_criterion']);
    expect(listQuestions(db, g.id).map(q => q.checkKey).sort())
      .toEqual(['missing:risk_level', 'missing:scope', 'missing:success_criterion']);
    expect(r1.nextAction).toMatch(/answer 3 material question/);
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(listQuestions(db, g.id)).toHaveLength(3);
  });

  it('answered or dismissed gap questions are never recreated (Review Focus 2)', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    const qs = listQuestions(db, g.id);
    answerQuestion(db, qs.find(q => q.checkKey === 'missing:scope')!.id, 'auth service only', { as: 'scope' });
    dismissQuestion(db, qs.find(q => q.checkKey === 'missing:risk_level')!.id, 'will set via goal set');
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(listQuestions(db, g.id)).toHaveLength(3);
  });

  it('auto-answers gap questions once their field is filled; ready → "ready to lock"', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    makeLockable(db, g.id);
    const r = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r.ready).toBe(true);
    expect(r.nextAction).toBe('ready to lock');
    expect(listQuestions(db, g.id).every(q => q.status === 'answered' && q.answer === 'filled via contract')).toBe(true);
  });

  it('finds exact and semantic duplicate requirements', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const a = addRequirement(db, g.id, { type: 'success_criterion', description: 'All suites pass.' });
    const b = addRequirement(db, g.id, { type: 'success_criterion', description: 'all  suites pass' });
    const c = addRequirement(db, g.id, { type: 'success_criterion', description: 'import observations idempotent' });
    const d = addRequirement(db, g.id, { type: 'success_criterion', description: 'observations import idempotent' });
    const r = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r.duplicates).toContainEqual({ a: a.id, b: b.id, reason: 'exact' });
    expect(r.duplicates).toContainEqual({ a: c.id, b: d.id, reason: 'semantic' });
    expect(r.nextAction).toMatch(/answer|fill|duplicate/);
  });

  it('surfaces related context and review items without asking them', async () => {
    const db = createTestDb();
    const e = fakeEmbedder();
    const other = createGoal(db, { title: 'Microsoft sign in', objective: 'users sign in with microsoft accounts' });
    addDecision(db, { decision: 'use microsoft entra for sign in', reason: 'company standard' });
    const g = createGoal(db, { title: 'Microsoft sign in v2', objective: 'users sign in with microsoft' });
    await reindexEmbeddings(db, e);
    const r = await buildIntakeReport(db, e, g.id);
    expect(r.context.goal.some(h => h.id === other.id)).toBe(true);
    expect(r.context.goal.some(h => h.id === g.id)).toBe(false);
    expect(r.reviewItems.some(i => i.kind === 'overlapping_goal' && i.ref === `goal:${other.id}`)).toBe(true);
    expect(r.reviewItems.some(i => i.kind === 'related_decision')).toBe(true);
    expect(listQuestions(db, g.id).every(q => q.source === 'brain')).toBe(true); // review items never auto-asked
    expect(r.semanticUnavailable).toBe(false);
  });

  it('degrades to FTS + exact duplicates when the embedder fails', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Microsoft sign in', objective: 'users sign in' });
    addRequirement(db, g.id, { type: 'scope', description: 'auth only' });
    addRequirement(db, g.id, { type: 'scope', description: 'Auth only.' });
    const r = await buildIntakeReport(db, broken, g.id);
    expect(r.semanticUnavailable).toBe(true);
    expect(r.duplicates).toHaveLength(1);
    expect(r.reviewItems.filter(i => i.kind === 'overlapping_goal')).toHaveLength(0);
  });

  it('is read-only on a locked goal', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    lockGoal(db, g.id, { force: true, reason: 'spike' });
    const r = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r.gaps.length).toBeGreaterThan(0);
    expect(listQuestions(db, g.id)).toHaveLength(0);
  });
});

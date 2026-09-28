import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable } from './helpers.js';
import { fakeEmbedder, type Embedder } from '../src/services/embedder.js';
import { reindexEmbeddings } from '../src/services/embedding-store.js';
import { buildIntakeReport, BEHAVIOUR_QUESTION } from '../src/services/intake.js';
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
      .toEqual(['missing:risk_level', 'missing:scope', 'missing:success_criterion', 'review:behaviour']);
    expect(r1.nextAction).toMatch(/answer 4 material question/);
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(listQuestions(db, g.id)).toHaveLength(4);
  });

  it('always asks the behaviour-choices question; it blocks lock until answered and is never duplicated', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    makeLockable(db, g.id); // no contract gaps at all
    const r1 = await buildIntakeReport(db, fakeEmbedder(), g.id);
    const q = listQuestions(db, g.id).find(x => x.checkKey === 'review:behaviour')!;
    expect(q).toMatchObject({ source: 'brain', materiality: 'material', status: 'pending', question: BEHAVIOUR_QUESTION });
    expect(r1.ready).toBe(false);
    expect(r1.nextAction).toMatch(/answer 1 material question/);
    expect(() => lockGoal(db, g.id)).toThrow(/open question/);
    answerQuestion(db, q.id, 'User chose: finished = watched past 95%');
    const r2 = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r2.ready).toBe(true);
    expect(listQuestions(db, g.id).filter(x => x.checkKey === 'review:behaviour')).toHaveLength(1);
    expect(lockGoal(db, g.id).status).toBe('LOCKED');
  });

  it('answered or dismissed gap questions are never recreated (Review Focus 2)', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    const qs = listQuestions(db, g.id);
    answerQuestion(db, qs.find(q => q.checkKey === 'missing:scope')!.id, 'auth service only', { as: 'scope' });
    dismissQuestion(db, qs.find(q => q.checkKey === 'missing:risk_level')!.id, 'will set via goal set');
    dismissQuestion(db, qs.find(q => q.checkKey === 'review:behaviour')!.id, 'no user-visible behaviour change');
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(listQuestions(db, g.id)).toHaveLength(4);
  });

  it('auto-answers gap questions once their field is filled; ready → "ready to lock"', async () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    await buildIntakeReport(db, fakeEmbedder(), g.id);
    makeLockable(db, g.id);
    const behaviour = listQuestions(db, g.id).find(q => q.checkKey === 'review:behaviour')!;
    answerQuestion(db, behaviour.id, 'none — internal change');
    const r = await buildIntakeReport(db, fakeEmbedder(), g.id);
    expect(r.ready).toBe(true);
    expect(r.nextAction).toBe('ready to lock');
    expect(listQuestions(db, g.id).filter(q => q.checkKey?.startsWith('missing:'))
      .every(q => q.status === 'answered' && q.answer === 'filled via contract')).toBe(true);
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

  it('overlapping_goal score is the cosine similarity (0..1], sorted desc', async () => {
    const db = createTestDb();
    const e = fakeEmbedder();
    const other = createGoal(db, { title: 'Microsoft sign in', objective: 'users sign in with microsoft accounts' });
    const g = createGoal(db, { title: 'Microsoft sign in v2', objective: 'users sign in with microsoft' });
    await reindexEmbeddings(db, e);
    const r = await buildIntakeReport(db, e, g.id);
    const overlaps = r.reviewItems.filter(i => i.kind === 'overlapping_goal');
    const item = overlaps.find(i => i.ref === `goal:${other.id}`)!;
    expect(item).toBeDefined();
    expect(item.score).toBeGreaterThan(0);
    expect(item.score).toBeLessThanOrEqual(1 + 1e-6);
    expect(item.text).toBe('Microsoft sign in: users sign in with microsoft accounts');
    expect(overlaps.some(i => i.ref === `goal:${g.id}`)).toBe(false);
    for (let i = 1; i < overlaps.length; i++) expect(overlaps[i - 1]!.score).toBeGreaterThanOrEqual(overlaps[i]!.score);
  });

  it('overlapping goals respect the embedder similarity floor; FTS-only matches are not flagged', async () => {
    const db = createTestDb();
    const f = fakeEmbedder();
    const e: Embedder = { model: f.model, minSimilarity: 0.95, embed: (t) => f.embed(t) };
    // FTS ANDs every query term, so the new goal's query is the single shared word
    const other = createGoal(db, { title: 'Kubernetes cluster', objective: 'upgrade worker nodes to the zanzibar release' });
    const g = createGoal(db, { title: 'Zanzibar', objective: 'zanzibar' });
    await reindexEmbeddings(db, e);
    const r = await buildIntakeReport(db, e, g.id);
    expect(r.semanticUnavailable).toBe(false);
    expect(r.context.goal.some(h => h.id === other.id)).toBe(true);
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

import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { goalQuestions, goals } from '../db/schema.js';
import { addRequirement, getGoal, GoalLockedError, type GoalQuestion } from './goals.js';

export const ANSWER_AS_TYPES = ['constraint', 'exclusion', 'assumption', 'scope', 'permission', 'success_criterion'];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const now = () => new Date().toISOString();

function assertEditable(db: BrainDb, goalId: string): void {
  const g = getGoal(db, goalId);
  if (g.lockedAt || TERMINAL.includes(g.status)) {
    throw new GoalLockedError(`Goal ${goalId} is locked; questions are frozen (§18).`);
  }
}

export function getQuestion(db: BrainDb, id: number): GoalQuestion {
  const q = db.select().from(goalQuestions).where(eq(goalQuestions.id, id)).get();
  if (!q) throw new Error(`Question not found: #${id}`);
  return q;
}

export function listQuestions(db: BrainDb, goalId: string, opts: { open?: boolean } = {}): GoalQuestion[] {
  const rows = db.select().from(goalQuestions).where(eq(goalQuestions.goalId, goalId)).all();
  return opts.open ? rows.filter(q => q.status === 'pending') : rows;
}

export function refreshClarificationStatus(db: BrainDb, goalId: string): 'pending' | 'complete' {
  const open = db.select().from(goalQuestions).where(and(
    eq(goalQuestions.goalId, goalId), eq(goalQuestions.status, 'pending'), eq(goalQuestions.materiality, 'material'),
  )).all().length;
  const status = open > 0 ? 'pending' : 'complete';
  db.update(goals).set({ clarificationStatus: status }).where(eq(goals.id, goalId)).run();
  return status;
}

export function addQuestion(
  db: BrainDb, goalId: string,
  input: { question: string; materiality?: 'material' | 'detail'; source?: 'brain' | 'session'; checkKey?: string },
): GoalQuestion {
  assertEditable(db, goalId);
  if (!input.question.trim()) throw new Error('Question text is empty.');
  const res = db.insert(goalQuestions).values({
    goalId, question: input.question.trim(), materiality: input.materiality ?? 'material',
    source: input.source ?? 'session', checkKey: input.checkKey ?? null, createdAt: now(),
  }).run();
  refreshClarificationStatus(db, goalId);
  return getQuestion(db, Number(res.lastInsertRowid));
}

export function answerQuestion(db: BrainDb, id: number, answer: string, opts: { as?: string } = {}): GoalQuestion {
  const q = getQuestion(db, id);
  assertEditable(db, q.goalId);
  if (q.status !== 'pending') throw new Error(`Question #${id} is already ${q.status}.`);
  if (!answer.trim()) throw new Error('Answer is empty.');
  if (opts.as !== undefined && !ANSWER_AS_TYPES.includes(opts.as)) {
    throw new Error(`Invalid --as type: ${opts.as} (expected ${ANSWER_AS_TYPES.join(', ')})`);
  }
  const requirementId = opts.as
    ? addRequirement(db, q.goalId, { type: opts.as, description: answer.trim() }).id
    : null;
  db.update(goalQuestions).set({
    answer: answer.trim(), status: 'answered', answeredAt: now(), requirementId,
  }).where(eq(goalQuestions.id, id)).run();
  refreshClarificationStatus(db, q.goalId);
  return getQuestion(db, id);
}

export function dismissQuestion(db: BrainDb, id: number, reason: string): GoalQuestion {
  const q = getQuestion(db, id);
  assertEditable(db, q.goalId);
  if (q.status !== 'pending') throw new Error(`Question #${id} is already ${q.status}.`);
  if (!reason.trim()) throw new Error('Dismissing a question requires a reason.');
  db.update(goalQuestions).set({ status: 'dismissed', statusReason: reason.trim() })
    .where(eq(goalQuestions.id, id)).run();
  refreshClarificationStatus(db, q.goalId);
  return getQuestion(db, id);
}

export function upsertBrainQuestion(
  db: BrainDb, goalId: string, checkKey: string, question: string,
): { question: GoalQuestion; created: boolean } {
  const existing = db.select().from(goalQuestions)
    .where(and(eq(goalQuestions.goalId, goalId), eq(goalQuestions.checkKey, checkKey))).get();
  if (existing) return { question: existing, created: false };
  return { question: addQuestion(db, goalId, { question, source: 'brain', checkKey }), created: true };
}

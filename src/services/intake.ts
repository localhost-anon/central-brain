import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { knowledge } from '../db/schema.js';
import { cosine, fromBlob, type Embedder } from './embedder.js';
import { loadEmbeddings } from './embedding-store.js';
import {
  checkContract, getGoal, listRequirements, type ContractGap, type Goal, type GoalQuestion,
} from './goals.js';
import { hybridSearch } from './hybrid-search.js';
import { answerQuestion, listQuestions, refreshClarificationStatus, upsertBrainQuestion } from './questions.js';
import { search, type SearchResult, type SearchType } from './search.js';

export const GAP_QUESTIONS: Record<ContractGap['field'], string> = {
  objective: 'What outcome must be true when this goal is done?',
  success_criterion: 'How will we verify the goal is complete (required success criteria)?',
  scope: 'What is in scope, and which systems may change?',
  risk_level: 'What is the risk level (LOW, MEDIUM, HIGH, IRREVERSIBLE)?',
};

/** Asked on every editable goal: sessions otherwise decide user-visible choices silently. */
export const BEHAVIOUR_QUESTION =
  'Which user-visible behaviour choices does this change involve (thresholds, defaults, limits, ' +
  'data or history that disappears or changes, side effects on existing users)? Put each to the ' +
  'user and record their decision here; answer "none" only if nothing a user would notice changes.';
const BEHAVIOUR_CHECK_KEY = 'review:behaviour';

const CONTEXT_TYPES = ['decision', 'failure', 'learning', 'knowledge', 'goal', 'observation'] as const;
type ContextType = typeof CONTEXT_TYPES[number];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const DUPLICATE_COSINE = 0.9;
const PER_TYPE = 5;

export interface IntakeReport {
  goal: Goal;
  ready: boolean;
  gaps: ContractGap[];
  openQuestions: GoalQuestion[];
  context: Record<ContextType, SearchResult[]>;
  reviewItems: { kind: 'overlapping_goal' | 'related_decision' | 'user_preference'; ref: string; text: string; score: number }[];
  duplicates: { a: number; b: number; reason: 'exact' | 'semantic' }[];
  semanticUnavailable: boolean;
  nextAction: string;
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?;:,]+$/, '');

export async function buildIntakeReport(db: BrainDb, embedder: Embedder, goalId: string): Promise<IntakeReport> {
  const goal = getGoal(db, goalId);
  const editable = !goal.lockedAt && !TERMINAL.includes(goal.status);

  // 1. deterministic gap questions (never on locked/terminal goals)
  if (editable) {
    const gapKeys = new Set(checkContract(db, goalId).gaps.map(g => `missing:${g.field}`));
    for (const field of Object.keys(GAP_QUESTIONS) as ContractGap['field'][]) {
      if (gapKeys.has(`missing:${field}`)) upsertBrainQuestion(db, goalId, `missing:${field}`, GAP_QUESTIONS[field]);
    }
    upsertBrainQuestion(db, goalId, BEHAVIOUR_CHECK_KEY, BEHAVIOUR_QUESTION);
    for (const q of listQuestions(db, goalId, { open: true })) {
      if (q.source === 'brain' && q.checkKey?.startsWith('missing:') && !gapKeys.has(q.checkKey)) {
        answerQuestion(db, q.id, 'filled via contract');
      }
    }
    refreshClarificationStatus(db, goalId);
  }
  const check = checkContract(db, goalId);

  // 2. related context (hybrid; FTS-only if the embedder fails)
  const query = `${goal.title}: ${goal.objective}`;
  let semanticUnavailable = false;
  const context = {} as Record<ContextType, SearchResult[]>;
  for (const t of CONTEXT_TYPES) {
    let hits: SearchResult[];
    if (!semanticUnavailable) {
      try {
        hits = await hybridSearch(db, embedder, query, { types: [t as SearchType], limit: PER_TYPE + 1 });
      } catch {
        semanticUnavailable = true;
        hits = search(db, query, { types: [t as SearchType], limit: PER_TYPE + 1 });
      }
    } else {
      hits = search(db, query, { types: [t as SearchType], limit: PER_TYPE + 1 });
    }
    context[t] = hits.filter(h => !(h.type === 'goal' && h.id === goalId)).slice(0, PER_TYPE);
  }

  // 3. duplicate requirements (embedded before review items so a late embedder failure suppresses overlaps)
  const reqs = listRequirements(db, goalId);
  const duplicates: IntakeReport['duplicates'] = [];
  let vectors: Float32Array[] | null = null;
  if (!semanticUnavailable && reqs.length > 1) {
    try { vectors = await embedder.embed(reqs.map(r => r.description)); } catch { semanticUnavailable = true; }
  }
  for (let i = 0; i < reqs.length; i++) {
    for (let j = i + 1; j < reqs.length; j++) {
      if (normalise(reqs[i]!.description) === normalise(reqs[j]!.description)) {
        duplicates.push({ a: reqs[i]!.id, b: reqs[j]!.id, reason: 'exact' });
      } else if (vectors && cosine(vectors[i]!, vectors[j]!) >= DUPLICATE_COSINE) {
        duplicates.push({ a: reqs[i]!.id, b: reqs[j]!.id, reason: 'semantic' });
      }
    }
  }

  // 4. overlapping goals — semantic similarity against stored goal vectors, above the embedder's floor (§4.2.3)
  let overlaps: IntakeReport['reviewItems'] = [];
  if (!semanticUnavailable) {
    let queryVec: Float32Array | undefined;
    try { [queryVec] = await embedder.embed([query]); } catch { semanticUnavailable = true; }
    if (queryVec && !semanticUnavailable) {
      const floor = embedder.minSimilarity ?? 0;
      for (const row of loadEmbeddings(db, embedder.model)) {
        if (row.sourceType !== 'goal' || String(row.sourceId) === goalId) continue;
        const similarity = cosine(queryVec, fromBlob(row.vector as Buffer));
        if (!(similarity > 0) || similarity < floor) continue;
        const other = getGoal(db, String(row.sourceId));
        if (TERMINAL.includes(other.status)) continue;
        overlaps.push({
          kind: 'overlapping_goal', ref: `goal:${other.id}`,
          text: `${other.title}: ${other.objective}`, score: similarity,
        });
      }
      overlaps = overlaps.sort((x, y) => y.score - x.score).slice(0, PER_TYPE);
    }
  }

  // 5. review items — surfaced for the session to judge, never auto-asked
  const reviewItems: IntakeReport['reviewItems'] = semanticUnavailable ? [] : overlaps;
  for (const h of context.decision) {
    reviewItems.push({ kind: 'related_decision', ref: `decision:${h.id}`, text: h.text, score: -h.score });
  }
  for (const h of context.knowledge) {
    const k = db.select().from(knowledge).where(eq(knowledge.id, Number(h.id))).get();
    if (k && (k.category === 'preference' || k.statement.startsWith('User preference'))) {
      reviewItems.push({ kind: 'user_preference', ref: `knowledge:${h.id}`, text: h.text, score: -h.score });
    }
  }

  // 5. next action — first applicable
  let nextAction = 'ready to lock';
  if (check.openQuestions.length > 0) {
    nextAction = `answer ${check.openQuestions.length} material question(s) — ask them in one batch`;
  } else if (check.gaps.length > 0) {
    nextAction = `fill: ${check.gaps.map(g => g.field).join(', ')}`;
  } else if (duplicates.length > 0) {
    nextAction = `resolve ${duplicates.length} duplicate requirement pair(s)`;
  }

  return {
    goal: getGoal(db, goalId), ready: check.ready,
    gaps: check.gaps, openQuestions: check.openQuestions, context, reviewItems, duplicates,
    semanticUnavailable, nextAction,
  };
}

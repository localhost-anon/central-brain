import { pendingMigrations, SCHEMA_NOTICE, type BrainDb } from '../db/connection.js';
import type { Goal } from './goals.js';
import type { Requirement } from './goals.js';
import type { WorkUnit } from './work.js';
import type { Knowledge } from './knowledge.js';
import type { Learning } from './knowledge.js';
import type { Decision } from './decisions.js';
import type { ModelRouting } from './model.js';
import type { SearchResult } from './search.js';
import { currentGoal, getGoal, listRequirements, listGoals, staleGoals, openMaterialQuestions as openQuestionsFor } from './goals.js';
import { listWorkUnits } from './work.js';
import { listKnowledge, listLearnings } from './knowledge.js';
import { listDecisions } from './decisions.js';
import { recommendModel } from './model.js';
import { search } from './search.js';

export interface BrainContext {
  goal: Goal | null;
  requirements: Requirement[];
  workUnits: WorkUnit[];
  decisions: Decision[];
  knowledge: Knowledge[];
  learnings: Learning[];
  relatedGoals: { id: string; title: string; status: string }[];
  recommendedModel: ModelRouting;
  openMaterialQuestions: number;
  staleGoals: { id: string; title: string; updatedAt: string }[];
  staleNotice: string | null;
  schemaPending: false;
}

/** Returned instead of a context when the schema is behind: the new columns may not exist yet. */
export interface SchemaPendingContext {
  schemaPending: true;
  notice: string;
}

function rankKnowledge(rows: Knowledge[], goalId?: string): Knowledge[] {
  const bucket = (k: Knowledge) =>
    goalId && k.scopeId === `goal:${goalId}` ? 0 : k.scopeType === 'GLOBAL' ? 1 : 2;
  return [...rows].sort(
    (a, b) =>
      bucket(a) - bucket(b) ||
      (b.lastVerifiedAt ?? b.createdAt).localeCompare(a.lastVerifiedAt ?? a.createdAt) ||
      b.confidence - a.confidence
  );
}

export function getContext(
  db: BrainDb, opts: { goalId?: string; budget?: number } = {},
): BrainContext | SchemaPendingContext {
  // Passive path (SessionStart hook): never query columns a pending migration adds.
  if (pendingMigrations(db) > 0) return { schemaPending: true, notice: SCHEMA_NOTICE };
  const budget = opts.budget ?? 30;
  const goal = opts.goalId ? getGoal(db, opts.goalId) : currentGoal(db) ?? null;

  const requirements = goal ? listRequirements(db, goal.id) : [];
  const workUnits = goal
    ? listWorkUnits(db, goal.id).filter(w => !['COMPLETED', 'SKIPPED'].includes(w.status))
    : [];

  const decisionsAll = goal ? listDecisions(db, { goalId: goal.id }) : [];
  const knowledgeAll = rankKnowledge(listKnowledge(db), goal?.id);
  const learningsAll = listLearnings(db)
    .sort((a, b) => b.usefulnessScore - a.usefulnessScore || b.timesUsed - a.timesUsed);
  const relatedAll = listGoals(db)
    .filter(g => g.id !== goal?.id)
    .slice(0, 10)
    .map(g => ({ id: g.id, title: g.title, status: g.status }));

  let openMaterialQuestions = 0;
  if (goal) {
    openMaterialQuestions = openQuestionsFor(db, goal.id).length;
  }

  const stale: BrainContext['staleGoals'] =
    staleGoals(db).map(g => ({ id: g.id, title: g.title, updatedAt: g.updatedAt }));
  const staleNotice = stale.length > 0
    ? `${stale.length} stale goals: ${stale.map(g => g.id).join(', ')} — complete, cancel or resume`
    : null;

  // Allocate budget across four capped categories, then backfill.
  const cats: { rows: unknown[] }[] = [
    { rows: decisionsAll },
    { rows: knowledgeAll },
    { rows: learningsAll },
    { rows: relatedAll },
  ];
  const per = Math.floor(budget / cats.length);
  const caps = cats.map(c => Math.min(c.rows.length, per));
  let remaining = budget - caps.reduce((s, n) => s + n, 0);
  for (let i = 0; i < cats.length && remaining > 0; i++) {
    const extra = Math.min(remaining, cats[i]!.rows.length - caps[i]!);
    caps[i]! += extra;
    remaining -= extra;
  }

  return {
    goal,
    requirements,
    workUnits,
    decisions: decisionsAll.slice(0, caps[0]),
    knowledge: knowledgeAll.slice(0, caps[1]),
    learnings: learningsAll.slice(0, caps[2]),
    relatedGoals: relatedAll.slice(0, caps[3]),
    recommendedModel: recommendModel(db, { goalId: goal?.id }),
    openMaterialQuestions,
    staleGoals: stale,
    staleNotice,
    schemaPending: false,
  };
}

export function searchContext(db: BrainDb, query: string, opts: { limit?: number } = {}): SearchResult[] {
  return search(db, query, { limit: opts.limit ?? 20 });
}

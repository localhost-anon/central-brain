import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { failures } from '../db/schema.js';
import { getGoal, listRequirements, type Goal, type Requirement } from './goals.js';
import { listDecisions, type Decision } from './decisions.js';
import { listWorkUnits, readyWorkUnits, type WorkUnit } from './work.js';
import { goalVerificationState } from './verification.js';
import type { Failure } from './failures.js';

export interface ResumeState {
  goal: Goal;
  contract: unknown | null;
  completedWork: WorkUnit[];
  pendingWork: WorkUnit[];
  readyWork: WorkUnit[];
  decisions: Decision[];
  unresolvedFailures: Failure[];
  requirements: Requirement[];
  nextRecommendedAction: string;
}

function recommend(goal: Goal, ready: WorkUnit[], pending: WorkUnit[], allPassed: boolean): string {
  switch (goal.status) {
    case 'DRAFT': return 'Clarify requirements and lock the goal contract';
    case 'LOCKED': return `Start the goal (brain goal start ${goal.id})`;
    case 'BLOCKED': return 'Resolve the blocker (see latest observation), then restart';
    case 'COMPLETED':
    case 'FAILED':
    case 'CANCELLED': return `Goal is ${goal.status}; nothing to resume`;
    default: {
      if (ready.length > 0) return `Work on ${ready[0].id}: ${ready[0].title}`;
      if (pending.length === 0 && allPassed) return 'All criteria passed — complete the goal';
      if (pending.length === 0) return 'Verify remaining success criteria';
      return 'No ready work: resolve dependencies or blocked work units';
    }
  }
}

export function resumeGoal(db: BrainDb, id: string): ResumeState {
  const goal = getGoal(db, id);
  const all = listWorkUnits(db, id);
  const completedWork = all.filter(w => ['COMPLETED', 'SKIPPED'].includes(w.status));
  const pendingWork = all.filter(w => !['COMPLETED', 'SKIPPED'].includes(w.status));
  const readyWork = readyWorkUnits(db, id);
  const unresolvedFailures = db.select().from(failures)
    .where(and(eq(failures.goalId, id), eq(failures.resolved, 0))).all();
  const { allRequiredPassed } = goalVerificationState(db, id);
  return {
    goal,
    contract: goal.contractSnapshot ? JSON.parse(goal.contractSnapshot) : null,
    completedWork,
    pendingWork,
    readyWork,
    decisions: listDecisions(db, { goalId: id }),
    unresolvedFailures,
    requirements: listRequirements(db, id),
    nextRecommendedAction: recommend(goal, readyWork, pendingWork, allRequiredPassed),
  };
}

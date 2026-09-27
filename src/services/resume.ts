import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { failures } from '../db/schema.js';
import { checkContract, getGoal, listRequirements, type Goal, type Requirement } from './goals.js';
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

function recommend(
  goal: Goal, ready: WorkUnit[], pending: WorkUnit[], allPassed: boolean,
  intake: { openMaterial: number; ready: boolean },
): string {
  switch (goal.status) {
    case 'DRAFT':
      if (intake.openMaterial > 0) {
        return `Answer ${intake.openMaterial} open material question(s) in one batch (brain goal question list ${goal.id} --open)`;
      }
      if (intake.ready) return `Contract ready — lock the goal contract (brain goal lock ${goal.id})`;
      return `Run goal intake to find contract gaps (brain goal intake ${goal.id})`;
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
  const contractCheck = checkContract(db, id);
  const intake = { openMaterial: contractCheck.openQuestions.length, ready: contractCheck.ready };
  return {
    goal,
    contract: goal.contractSnapshot ? JSON.parse(goal.contractSnapshot) : null,
    completedWork,
    pendingWork,
    readyWork,
    decisions: listDecisions(db, { goalId: id }),
    unresolvedFailures,
    requirements: listRequirements(db, id),
    nextRecommendedAction: recommend(goal, readyWork, pendingWork, allRequiredPassed, intake),
  };
}

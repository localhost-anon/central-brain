import { recordVerification } from '../src/services/verification.js';
import { addRequirement, listRequirements, setGoalFields } from '../src/services/goals.js';
import { createWorkUnit } from '../src/services/work.js';
import { openDb, migrateDb, type BrainDb } from '../src/db/connection.js';

export function createTestDb(): BrainDb {
  const db = openDb(':memory:');
  migrateDb(db);
  return db;
}

/** Give a test goal the §9 minimum contract so lockGoal passes the gate. */
export function makeLockable(db: BrainDb, goalId: string): void {
  setGoalFields(db, goalId, { riskLevel: 'LOW' });
  addRequirement(db, goalId, { type: 'scope', description: 'test scope' });
  if (!listRequirements(db, goalId).some(r => r.requirementType === 'success_criterion' && r.priority === 'required')) {
    addRequirement(db, goalId, { type: 'success_criterion', description: 'test criterion', verifyMethod: 'test' });
  }
}


/** One work unit serving every required success criterion, so a v1 goal can start. */
export function makeStartable(db: BrainDb, goalId: string) {
  const serves = listRequirements(db, goalId)
    .filter(r => r.requirementType === 'success_criterion' && r.priority === 'required').map(r => r.id);
  return createWorkUnit(db, { goalId, title: 'implement', serves });
}

/** Record a verified, method-matched run for every required criterion. */
export function satisfyCriteria(db: BrainDb, goalId: string): void {
  for (const r of listRequirements(db, goalId)) {
    if (r.requirementType !== 'success_criterion' || r.priority !== 'required') continue;
    recordVerification(db, { goalId, requirementId: r.id, verdict: 'verified',
      verificationType: r.verifyMethod ?? undefined, actualResult: 'observed in test' });
  }
}

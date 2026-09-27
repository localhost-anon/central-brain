import { addRequirement, listRequirements, setGoalFields } from '../src/services/goals.js';
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
    addRequirement(db, goalId, { type: 'success_criterion', description: 'test criterion' });
  }
}


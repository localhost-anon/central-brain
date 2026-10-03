import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable, makeStartable, satisfyCriteria } from './helpers.js';
import {
  createGoal, lockGoal, startGoal, completeGoal, listRequirements, IncompleteCriteriaError,
  setRequirementStatus,
} from '../src/services/goals.js';
import { recordVerification } from '../src/services/verification.js';
import { convergeGoal } from '../src/services/converge.js';
import { updateWorkUnit } from '../src/services/work.js';
import { addFailure } from '../src/services/failures.js';
import { listDecisions } from '../src/services/decisions.js';

function started(db: ReturnType<typeof createTestDb>) {
  const g = createGoal(db, { title: 't', objective: 'o' });
  makeLockable(db, g.id); lockGoal(db, g.id);
  const wu = makeStartable(db, g.id); startGoal(db, g.id);
  const crit = listRequirements(db, g.id).find(r => r.requirementType === 'success_criterion')!;
  return { g, wu, crit };
}

describe('verdicts', () => {
  it('v1: verified needs actualResult and matching verificationType', () => {
    const db = createTestDb();
    const { g, crit } = started(db);
    expect(() => recordVerification(db, { goalId: g.id, requirementId: crit.id, passed: true }))
      .toThrow(/actualResult/);
    expect(() => recordVerification(db, { goalId: g.id, requirementId: crit.id, verdict: 'verified', actualResult: 'ok', verificationType: 'manual' }))
      .toThrow(/verify method "test"/);
    recordVerification(db, { goalId: g.id, requirementId: crit.id, verdict: 'partial', actualResult: 'half', verificationType: 'test' });
    expect(listRequirements(db, g.id).find(r => r.id === crit.id)!.status).toBe('PENDING');
  });

  it('v0 goals keep passed:true without evidence (review focus #5)', () => {
    const db = createTestDb();
    const { g, crit } = started(db);
    db.$client.prepare('UPDATE goals SET rules_version = 0 WHERE id = ?').run(g.id);
    const run = recordVerification(db, { goalId: g.id, requirementId: crit.id, passed: true });
    expect(run.verdict).toBe('verified');
    expect(completeGoal(db, g.id).status).toBe('COMPLETED');
  });
});

describe('converge + complete gate (criterion #98)', () => {
  it('refuses on CRITICAL/HIGH, completes once converged, stores snapshot', () => {
    const db = createTestDb();
    const { g, wu, crit } = started(db);
    expect(convergeGoal(db, g.id).findings.map(f => f.id)).toEqual(
      expect.arrayContaining([`missing:req:${crit.id}`, `unfinished_work:wu:${wu.id}`]));
    expect(() => completeGoal(db, g.id)).toThrow(IncompleteCriteriaError);
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    satisfyCriteria(db, g.id);
    const rep = convergeGoal(db, g.id);
    expect(rep.converged).toBe(true);
    const done = completeGoal(db, g.id);
    expect(done.completionMode).toBe('normal');
    expect(JSON.parse(done.convergeSnapshot!).converged).toBe(true);
  });

  it('stale evidence after later work is HIGH', () => {
    const db = createTestDb();
    const { g, wu } = started(db);
    satisfyCriteria(db, g.id);
    db.$client.prepare(`UPDATE verification_runs SET created_at = '2020-01-01T00:00:00Z'`).run();
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    expect(convergeGoal(db, g.id).findings.some(f => f.kind === 'stale_evidence')).toBe(true);
  });

  it('open failure blocks completion', () => {
    const db = createTestDb();
    const { g, wu } = started(db);
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' }); satisfyCriteria(db, g.id);
    const fl = addFailure(db, { goalId: g.id, errorMessage: 'flaky' });
    expect(() => completeGoal(db, g.id)).toThrow(/Unresolved failure/);
    const msg = convergeGoal(db, g.id).findings.find(f => f.kind === 'open_failure')!.message;
    expect(msg).toContain(`failure solution ${fl.id} "<fix>" --verdict verified --reproduction "…"`);
    expect(msg).toContain(`failure resolve ${fl.id} <reason>`);
  });

  it('force requires reason (v0 and v1); forced completion marked and decided', () => {
    const db = createTestDb();
    const { g } = started(db);
    expect(() => completeGoal(db, g.id, { force: true })).toThrow(/reason/);
    const done = completeGoal(db, g.id, { force: true, reason: 'superseded by GOAL-X' });
    expect(done.completionMode).toBe('forced');
    expect(done.convergeSnapshot).toBeTruthy();
    expect(listDecisions(db, { goalId: g.id }).some(d => d.riskLevel === 'MEDIUM' && d.reason?.includes('superseded'))).toBe(true);
  });

  it('NOT_APPLICABLE criterion produces no finding', () => {
    const db = createTestDb();
    const { g, wu, crit } = started(db);
    updateWorkUnit(db, wu.id, { status: 'COMPLETED' });
    setRequirementStatus(db, crit.id, 'NOT_APPLICABLE', 'dropped by user');
    expect(convergeGoal(db, g.id).converged).toBe(true);
  });
});

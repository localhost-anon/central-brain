import { describe, it, expect } from 'vitest';
import {
  isAtomic, lockFindings, uncoveredCategories, principleFindings, coverageFindings,
  evidenceFindings, sortFindings, isConverged, type ReqRow, type UnitRow, type RunRow,
} from '../src/services/contract-rules.js';

const req = (o: Partial<ReqRow> & { id: number }): ReqRow => ({
  requirementType: 'success_criterion', description: 'x works', priority: 'required',
  status: 'PENDING', verifyMethod: 'test', coverage: null, ...o,
});
const unit = (o: Partial<UnitRow> & { id: string }): UnitRow => ({ title: 'u', status: 'COMPLETED', completedAt: '2026-10-01T00:00:00Z', ...o });
const run = (o: Partial<RunRow> & { id: number }): RunRow => ({ requirementId: 1, verdict: 'verified', createdAt: '2026-10-02T00:00:00Z', ...o });

describe('isAtomic', () => {
  it.each([
    '(1) .env holds creds. (2) User logs in. (3) Data test passes',
    '1. lock refuses blobs 2. complete refuses gaps',
    'a) foo b) bar',
    'login works; logout works; refresh works',
    'Checks:\n- login\n- logout',
  ])('rejects blob: %s', (t) => expect(isAtomic(t)).toBe(false));
  it.each([
    'goal_lock refuses a blob criterion, proven by a passing integration test.',
    'Page loads in under 1.5s on v2.1 of the API (e.g. /health).',
    'User logs in to Dhan via OpenAlgo; auth table shows broker dhan',
  ])('accepts: %s', (t) => expect(isAtomic(t)).toBe(true));
});

describe('lockFindings', () => {
  it('flags non-atomic and missing verify method on required criteria only', () => {
    const f = lockFindings([
      req({ id: 1, description: '(1) a (2) b' }),
      req({ id: 2, verifyMethod: null }),
      req({ id: 3, priority: 'optional', verifyMethod: null }),
      req({ id: 4, requirementType: 'scope', description: '(1) a (2) b', verifyMethod: null }),
    ]);
    expect(f.map(x => x.id).sort()).toEqual(['no_verify_method:req:2', 'non_atomic:req:1']);
    expect(f.every(x => x.severity === 'CRITICAL')).toBe(true);
  });
});

describe('uncoveredCategories', () => {
  it('lists categories with no tagged requirement', () => {
    expect(uncoveredCategories([req({ id: 1, coverage: 'data' }), req({ id: 2, coverage: 'edge_cases' })]))
      .toEqual(['behaviour', 'failure_modes', 'non_functional', 'integration', 'completion']);
  });
});

describe('principleFindings', () => {
  const p = [{ id: 7, statement: 'Sandbox first' }, { id: 8, statement: 'No secrets in DB' }];
  it('lock: unacknowledged principles are CRITICAL', () => {
    const f = principleFindings(p, [{ knowledgeId: 7, mode: 'honoured' }], 'lock');
    expect(f).toEqual([expect.objectContaining({ id: 'unacknowledged_principle:knowledge:8', severity: 'CRITICAL' })]);
  });
  it('converge: exceptions are LOW', () => {
    const f = principleFindings(p, [{ knowledgeId: 7, mode: 'exception' }, { knowledgeId: 8, mode: 'honoured' }], 'converge');
    expect(f).toEqual([expect.objectContaining({ id: 'principle_exception:knowledge:7', severity: 'LOW' })]);
  });
});

describe('coverageFindings', () => {
  it('uncovered required criterion CRITICAL, unlinked unit MEDIUM', () => {
    const f = coverageFindings([req({ id: 1 }), req({ id: 2 }), req({ id: 3, priority: 'optional' })],
      [unit({ id: 'WU-1' }), unit({ id: 'WU-2' })], [{ workUnitId: 'WU-1', requirementId: 1 }]);
    expect(f.map(x => `${x.id}/${x.severity}`).sort()).toEqual(['uncovered:req:2/CRITICAL', 'unrequested:wu:WU-2/MEDIUM']);
  });
});

describe('evidenceFindings', () => {
  it('missing, contradicts, partial, stale, unfinished, open failure, optional, review', () => {
    const reqs = [
      req({ id: 1 }), req({ id: 2 }), req({ id: 3 }), req({ id: 4 }), req({ id: 5 }),
      req({ id: 6, priority: 'optional' }),
      req({ id: 7, requirementType: 'constraint', description: 'no downtime', verifyMethod: null }),
      req({ id: 8, status: 'NOT_APPLICABLE' }),
    ];
    const runs = [
      run({ id: 1, requirementId: 2, verdict: 'failed' }),
      run({ id: 2, requirementId: 3, verdict: 'partial' }),
      run({ id: 3, requirementId: 4, verdict: 'verified', createdAt: '2026-09-01T00:00:00Z' }),
      run({ id: 4, requirementId: 5, verdict: 'verified' }),
      run({ id: 5, requirementId: 5, verdict: null }), // legacy row ignored
    ];
    const units = [unit({ id: 'WU-1', completedAt: '2026-10-01T00:00:00Z' }), unit({ id: 'WU-2', status: 'RUNNING', completedAt: null })];
    const f = evidenceFindings(reqs, runs, units, [{ id: 9, errorMessage: 'boom' }]);
    expect(f.map(x => `${x.id}/${x.severity}`).sort()).toEqual([
      'contradicts:req:2/CRITICAL', 'missing:req:1/CRITICAL', 'missing_optional:req:6/MEDIUM',
      'open_failure:failure:9/CRITICAL', 'partial:req:3/HIGH', 'review:req:7/LOW',
      'stale_evidence:req:4/HIGH', 'unfinished_work:wu:WU-2/HIGH',
    ]);
  });
  it('uses the latest verdict run', () => {
    const f = evidenceFindings([req({ id: 1 })],
      [run({ id: 1, verdict: 'failed', createdAt: '2026-10-01T00:00:00Z' }), run({ id: 2, verdict: 'verified', createdAt: '2026-10-02T00:00:00Z' })], [], []);
    expect(f).toEqual([]);
  });
});

describe('sortFindings / isConverged', () => {
  it('orders by severity then id; converged ignores MEDIUM/LOW', () => {
    const f = [
      { id: 'b', severity: 'LOW', kind: 'k', ref: 'r', message: '' },
      { id: 'a', severity: 'HIGH', kind: 'k', ref: 'r', message: '' },
      { id: 'c', severity: 'MEDIUM', kind: 'k', ref: 'r', message: '' },
    ] as const;
    expect(sortFindings([...f]).map(x => x.id)).toEqual(['a', 'c', 'b']);
    expect(isConverged([f[0], f[2]])).toBe(true);
    expect(isConverged([...f])).toBe(false);
  });
});

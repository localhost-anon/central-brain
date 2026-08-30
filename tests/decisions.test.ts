import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal } from '../src/services/goals.js';
import {
  addDecision, listDecisions, addObservation, addApproval, resolveApproval,
} from '../src/services/decisions.js';

describe('decisions, observations, approvals', () => {
  it('records decisions against goals', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addDecision(db, {
      goalId: g.id, decision: 'Use library C for OAuth',
      reason: 'PKCE support', alternatives: 'library A, library B', riskLevel: 'MEDIUM',
    });
    expect(listDecisions(db, { goalId: g.id })).toHaveLength(1);
    expect(listDecisions(db)).toHaveLength(1);
  });

  it('records observations', () => {
    const db = createTestDb();
    const o = addObservation(db, { observation: 'Port 8020 already in use by voiceflowx', scopeType: 'MACHINE', scopeId: 'entity:truenas' });
    expect(o.id).toBeGreaterThan(0);
  });

  it('approvals resolve to approved/denied with timestamps', () => {
    const db = createTestDb();
    const a = addApproval(db, { action: 'Delete production database', riskLevel: 'IRREVERSIBLE' });
    expect(a.status).toBe('pending');
    const resolved = resolveApproval(db, a.id, 'denied');
    expect(resolved.status).toBe('denied');
    expect(resolved.resolvedAt).toBeTruthy();
  });
});

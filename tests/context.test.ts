import { describe, it, expect } from 'vitest';
import { createTestDb, makeLockable } from './helpers.js';
import { createGoal, addRequirement, lockGoal } from '../src/services/goals.js';
import { createWorkUnit } from '../src/services/work.js';
import { addKnowledge } from '../src/services/knowledge.js';
import { addDecision } from '../src/services/decisions.js';
import { getContext, searchContext } from '../src/services/context.js';

describe('context engine', () => {
  it('assembles goal context with requirements and open work', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Add SSO', objective: 'MS auth' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'login works', verifyMethod: 'test' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    createWorkUnit(db, { goalId: g.id, title: 'Inspect auth' });
    addDecision(db, { goalId: g.id, decision: 'Use MSAL' });
    addKnowledge(db, { scopeType: 'GOAL', scopeId: `goal:${g.id}`, statement: 'frontend is Next.js' });
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'Prefer reversible changes' });
    const ctx = getContext(db, { goalId: g.id });
    expect(ctx.goal?.id).toBe(g.id);
    expect(ctx.requirements).toHaveLength(2);
    expect(ctx.workUnits).toHaveLength(1);
    expect(ctx.decisions).toHaveLength(1);
    // goal-scoped knowledge ranks before global
    expect(ctx.knowledge[0].statement).toBe('frontend is Next.js');
    expect(ctx.knowledge[1].statement).toBe('Prefer reversible changes');
    // no complexity set on the goal -> default medium -> sonnet
    expect(ctx.recommendedModel).toEqual({ model: 'sonnet', complexity: 'medium', source: 'default' });
  });

  it('falls back to the current active goal and respects budget', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Active goal', objective: 'o' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    for (let i = 0; i < 50; i++) {
      addKnowledge(db, { scopeType: 'GLOBAL', statement: `fact number ${i}` });
    }
    const ctx = getContext(db, { budget: 10 });
    expect(ctx.goal?.id).toBe(g.id);
    const total = ctx.decisions.length + ctx.knowledge.length + ctx.learnings.length + ctx.relatedGoals.length;
    expect(total).toBeLessThanOrEqual(10);
    expect(total).toBe(10); // 50 knowledge rows available — budget must be fully consumed
  });

  it('returns global-only context when no goal is active', () => {
    const db = createTestDb();
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'Do not commit .env files' });
    const ctx = getContext(db, {});
    expect(ctx.goal).toBeNull();
    expect(ctx.knowledge.length).toBe(1);
  });

  it('searchContext proxies fts search', () => {
    const db = createTestDb();
    addKnowledge(db, { scopeType: 'GLOBAL', statement: 'truenas runs seafile on port 8088' });
    expect(searchContext(db, 'seafile')[0].type).toBe('knowledge');
  });
});

describe('open-question count error handling', () => {
  it('rethrows query errors when no migrations are pending', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    db.$client.exec('DROP TABLE goal_questions');
    expect(() => getContext(db, { goalId: g.id })).toThrow(/goal_questions/);
  });
});

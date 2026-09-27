import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, makeLockable } from './helpers.js';
import { createGoal, lockGoal } from '../src/services/goals.js';
import { recommendModel } from '../src/services/model.js';

describe('model routing', () => {
  it('maps explicit complexity via the default map', () => {
    const db = createTestDb();
    expect(recommendModel(db, { complexity: 'trivial' }))
      .toEqual({ model: 'haiku', complexity: 'trivial', source: 'explicit' });
    expect(recommendModel(db, { complexity: 'critical' }).model).toBe('fable');
  });

  it('routes by goal complexity, defaulting to medium', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', complexity: 'high' });
    expect(recommendModel(db, { goalId: g.id }))
      .toEqual({ model: 'opus', complexity: 'high', source: 'goal' });
    const plain = createGoal(db, { title: 'p', objective: 'o' });
    expect(recommendModel(db, { goalId: plain.id }))
      .toEqual({ model: 'sonnet', complexity: 'medium', source: 'default' });
  });

  it('bumps HIGH/IRREVERSIBLE-risk goals to at least high complexity', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', complexity: 'low', riskLevel: 'IRREVERSIBLE' });
    expect(recommendModel(db, { goalId: g.id }).model).toBe('opus');
  });

  it('uses the current active goal when no goalId is given', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o', complexity: 'critical' });
    makeLockable(db, g.id);
    lockGoal(db, g.id);
    expect(recommendModel(db).model).toBe('fable');
  });

  it('honors modelMap overrides from config.json', () => {
    const db = createTestDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cfg-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ modelMap: { critical: 'opus' } }));
    expect(recommendModel(db, { complexity: 'critical', configPath: cfg }).model).toBe('opus');
  });
});

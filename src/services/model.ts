import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrainDb } from '../db/connection.js';
import { currentGoal, getGoal } from './goals.js';

export type Complexity = 'trivial' | 'low' | 'medium' | 'high' | 'critical';

export interface ModelRouting {
  model: string;
  complexity: Complexity;
  source: 'explicit' | 'goal' | 'default';
}

const DEFAULT_MAP: Record<Complexity, string> = {
  trivial: 'haiku', low: 'sonnet', medium: 'sonnet', high: 'opus', critical: 'fable',
};

const ORDER: Complexity[] = ['trivial', 'low', 'medium', 'high', 'critical'];

export function modelMap(
  configPath: string = path.join(os.homedir(), '.central-brain', 'config.json'),
): Record<Complexity, string> {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { ...DEFAULT_MAP, ...(cfg.modelMap ?? {}) };
  } catch {
    return { ...DEFAULT_MAP };
  }
}

export function recommendModel(
  db: BrainDb,
  opts: { goalId?: string; complexity?: Complexity; configPath?: string } = {},
): ModelRouting {
  const map = modelMap(opts.configPath);
  if (opts.complexity) {
    return { model: map[opts.complexity], complexity: opts.complexity, source: 'explicit' };
  }
  const goal = opts.goalId ? getGoal(db, opts.goalId) : currentGoal(db);
  let complexity = (goal?.complexity ?? 'medium') as Complexity;
  if (!ORDER.includes(complexity)) complexity = 'medium';
  if (goal?.riskLevel && ['HIGH', 'IRREVERSIBLE'].includes(goal.riskLevel.toUpperCase())
      && ORDER.indexOf(complexity) < ORDER.indexOf('high')) {
    complexity = 'high';
  }
  return { model: map[complexity], complexity, source: goal?.complexity ? 'goal' : 'default' };
}

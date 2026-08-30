import { like } from 'drizzle-orm';
import type { BrainDb } from './db/connection.js';
import { goals, workUnits } from './db/schema.js';

const PREFIX_TYPES = ['project', 'repo', 'goal', 'entity', 'wu'] as const;
export type PrefixType = (typeof PREFIX_TYPES)[number];

export function nextGoalId(db: BrainDb, nowDate: Date = new Date()): string {
  const year = nowDate.getUTCFullYear();
  const rows = db.select({ id: goals.id }).from(goals).where(like(goals.id, `GOAL-${year}-%`)).all();
  const max = rows.reduce((m, r) => Math.max(m, Number(r.id.split('-')[2]) || 0), 0);
  return `GOAL-${year}-${String(max + 1).padStart(4, '0')}`;
}

export function workUnitIdFor(db: BrainDb, goalId: string): string {
  const base = goalId.replace(/^GOAL/, 'WU');
  const rows = db.select({ id: workUnits.id }).from(workUnits).where(like(workUnits.id, `${base}.%`)).all();
  const max = rows.reduce((m, r) => Math.max(m, Number(r.id.slice(base.length + 1)) || 0), 0);
  return `${base}.${max + 1}`;
}

export function prefixedId(type: PrefixType, id: string): string {
  return `${type}:${id}`;
}

export function parsePrefixedId(s: string): { type: PrefixType; id: string } {
  const i = s.indexOf(':');
  const type = i > 0 ? (s.slice(0, i) as PrefixType) : undefined;
  if (!type || !PREFIX_TYPES.includes(type) || i === s.length - 1) {
    throw new Error(`Invalid prefixed id "${s}". Expected <${PREFIX_TYPES.join('|')}>:<id> (ARCHITECTURE.md §16.1).`);
  }
  return { type, id: s.slice(i + 1) };
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

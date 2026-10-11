import { EventEmitter } from 'node:events';
import type { BrainDb } from '../db/connection.js';

// Per-goal signature over everything the UI shows for a goal. Cheap: one query, only run when data_version moves.
const SIGNATURE_SQL = `
SELECT g.id AS id, g.updated_at
  || '|q' || COALESCE((SELECT MAX(id) || ':' || COUNT(*) || ':' || SUM(status = 'pending') FROM goal_questions WHERE goal_id = g.id), '')
  || '|r' || COALESCE((SELECT COUNT(*) || ':' || GROUP_CONCAT(status) FROM goal_requirements WHERE goal_id = g.id), '')
  || '|d' || COALESCE((SELECT MAX(id) FROM decisions WHERE goal_id = g.id), '')
  || '|f' || COALESCE((SELECT MAX(id) || ':' || SUM(resolved) FROM failures WHERE goal_id = g.id), '')
  || '|v' || COALESCE((SELECT MAX(id) FROM verification_runs WHERE goal_id = g.id), '')
  || '|a' || COALESCE((SELECT MAX(id) || ':' || SUM(status = 'pending') FROM approvals WHERE goal_id = g.id), '')
  || '|w' || COALESCE((SELECT GROUP_CONCAT(status) FROM worker_runs WHERE goal_id = g.id), '')
  AS sig
FROM goals g`;

export class ChangeFeed extends EventEmitter {
  private version = -1;
  private sigs: Map<string, string> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private db: BrainDb, private opts: { intervalMs?: number } = {}) { super(); }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 1000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  poll(): string[] {
    const v = this.db.$client.pragma('data_version', { simple: true }) as number;
    if (this.sigs && v === this.version) return [];
    this.version = v;
    const next = new Map((this.db.$client.prepare(SIGNATURE_SQL).all() as { id: string; sig: string }[]).map(r => [r.id, r.sig]));
    const prev = this.sigs;
    this.sigs = next;
    if (!prev) return [];
    const changed = [...next].filter(([id, sig]) => prev.get(id) !== sig).map(([id]) => id);
    for (const id of changed) this.emit('goal-changed', id);
    return changed;
  }
}

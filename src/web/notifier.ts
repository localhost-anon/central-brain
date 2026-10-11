import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrainDb } from '../db/connection.js';
import type { ChangeFeed } from './change-feed.js';

/**
 * Phone pushes through a self-hosted ntfy server (phase 3, GOAL-2026-0072). The notifier keeps a
 * small state per goal and sends one push when that state moves into: a worker waits for answers
 * or an approval, a worker finished, a worker failed, or the goal completed. State that already
 * exists when the UI starts sends nothing. A push holds only the project, the goal title and the
 * reason — no question text, paths or logs.
 */
export interface NtfyConfig { url: string; topic: string; token: string; uiUrl: string }

export const NTFY_CONFIG_PATH = path.join(os.homedir(), '.central-brain', 'ntfy.json');

/** Reads the ntfy config file. A missing file means "notifier off" (null); a malformed one throws. */
export function loadNtfyConfig(file = NTFY_CONFIG_PATH): NtfyConfig | null {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<NtfyConfig>;
  for (const k of ['url', 'topic', 'token', 'uiUrl'] as const) {
    if (typeof raw[k] !== 'string' || !raw[k]) throw new Error(`${file}: "${k}" is missing`);
  }
  return { url: raw.url!.replace(/\/+$/, ''), topic: raw.topic!, token: raw.token!, uiUrl: raw.uiUrl!.replace(/\/+$/, '') };
}

export interface Push { title: string; message: string; priority: 3 | 4; tags: string[]; click: string }
export type Sender = (push: Push) => Promise<void>;

/** Posts a push as JSON (JSON keeps non-ASCII goal titles intact; HTTP headers would not). */
export function ntfySender(cfg: NtfyConfig, fetchImpl: typeof fetch = fetch): Sender {
  return async (push) => {
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: cfg.topic, ...push }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
  };
}

interface GoalState { title: string; project: string | null; goalStatus: string; runId: string | null; runStatus: string | null }

const STATE_SQL = `
SELECT g.id, g.title, g.status AS goalStatus,
  (SELECT p.name FROM goal_projects gp JOIN projects p ON p.id = gp.project_id WHERE gp.goal_id = g.id ORDER BY gp.rowid LIMIT 1) AS project,
  r.id AS runId, r.status AS runStatus
FROM goals g
LEFT JOIN worker_runs r ON r.rowid = (SELECT MAX(rowid) FROM worker_runs WHERE goal_id = g.id)`;

const WAITING: Record<string, string> = {
  waiting_answers: 'Questions wait for your answers',
  waiting_approval: 'An approval waits for you',
};

/** The push a state change calls for, or null. */
export function pushFor(goalId: string, prev: GoalState | undefined, next: GoalState, uiUrl: string): Push | null {
  const click = `${uiUrl}/#/goal/${encodeURIComponent(goalId)}`;
  const title = next.project ? `${next.project}: ${next.title}` : next.title;
  const make = (message: string, priority: 3 | 4, tag: string): Push => ({ title, message, priority, tags: [tag], click });
  if (next.goalStatus === 'COMPLETED' && prev?.goalStatus !== 'COMPLETED') return make('Goal completed', 3, 'white_check_mark');
  const runMoved = next.runId !== prev?.runId || next.runStatus !== prev?.runStatus;
  if (!runMoved || !next.runStatus) return null;
  if (WAITING[next.runStatus]) return make(WAITING[next.runStatus]!, 4, 'raising_hand');
  if (next.runStatus === 'completed') return make('Worker finished', 3, 'checkered_flag');
  if (next.runStatus === 'failed') return make('Worker failed', 4, 'x');
  return null;
}

export class Notifier {
  private states = new Map<string, GoalState>();

  constructor(private db: BrainDb, private send: Sender, private uiUrl: string, private log: (m: string) => void = () => {}) {
    // Snapshot first: whatever already waits, finished or completed before start sends nothing.
    for (const [id, s] of this.read()) this.states.set(id, s);
  }

  private read(): Map<string, GoalState> {
    const rows = this.db.$client.prepare(STATE_SQL).all() as (GoalState & { id: string })[];
    return new Map(rows.map(({ id, ...s }) => [id, s]));
  }

  /** Re-reads every goal and sends the pushes the changes call for. Returns them (for tests). */
  check(): Push[] {
    const sent: Push[] = [];
    for (const [id, next] of this.read()) {
      const push = pushFor(id, this.states.get(id), next, this.uiUrl);
      this.states.set(id, next);
      if (!push) continue;
      sent.push(push);
      this.send(push).catch((e: Error) => this.log(`push failed for ${id}: ${e.message}`));
    }
    return sent;
  }

  /** Checks on every change the feed reports. A read error is logged, never thrown into the server. */
  attach(feed: ChangeFeed): void {
    // The feed emits once per changed goal in one poll; one check after the poll covers them all.
    let queued = false;
    feed.on('goal-changed', () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        try { this.check(); } catch (e) { this.log(`notifier check failed: ${(e as Error).message}`); }
      });
    });
  }
}

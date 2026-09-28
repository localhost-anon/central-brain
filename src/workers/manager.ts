import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { BrainDb } from '../db/connection.js';
import { getGoal, openMaterialQuestions } from '../services/goals.js';
import type { Approval } from '../services/decisions.js';
import {
  ACTIVE_RUN_STATUSES, activeRunForGoal, addEvent, createPermissionApproval, createRun, decidePermission,
  getRun, listRuns, pendingApprovals, queuedRuns, updateRun, type WorkerEvent, type WorkerRun,
} from '../services/workers.js';
import {
  answersMessage, eventsFor, firstMessage, initializeRequest, nudgeMessage, parseWorkerLine,
  permissionResponse, resumeMessage, userMessage, workerArgs, workerSystemPrompt,
} from './protocol.js';

export type ManagerEvent =
  | { type: 'run-changed'; goalId: string; runId: string; status: string }
  | { type: 'worker-event'; goalId: string; runId: string; event: WorkerEvent }
  | { type: 'approval'; goalId: string; runId: string; approvalId: number };

export interface WorkerControl {
  start(goalId: string, opts?: { cwd?: string }): WorkerRun;
  stop(runId: string): WorkerRun;
  resume(goalId: string): WorkerRun;
  answersUpdated(goalId: string): void;
  decide(approvalId: number, decision: 'allow' | 'deny', note?: string): Approval;
  stopAll(): void;
}

export function readMaxWorkers(configPath = path.join(os.homedir(), '.central-brain', 'config.json')): number {
  try {
    const n = Number(JSON.parse(fs.readFileSync(configPath, 'utf8')).maxWorkers);
    return Number.isInteger(n) && n > 0 ? n : 2;
  } catch { return 2; }
}

interface Live {
  child: ChildProcessWithoutNullStreams; goalId: string; nudged: boolean; stderr: string; ended: boolean;
  killTimer?: NodeJS.Timeout;
}
const now = () => new Date().toISOString();
const END_STATES = ['completed', 'stopped', 'failed'];
/** Grace period between SIGTERM / stdin close and SIGKILL. */
const KILL_AFTER_MS = 5000;

export class WorkerManager implements WorkerControl {
  private live = new Map<string, Live>();
  private pendingFirst = new Map<string, string>();
  private readonly command: string[];
  private readonly maxWorkers: number;

  constructor(private db: BrainDb, private opts: {
    command?: string[]; maxWorkers?: number; defaultCwd: string; onEvent?: (e: ManagerEvent) => void;
  }) {
    this.command = opts.command ?? ['claude'];
    this.maxWorkers = opts.maxWorkers ?? readMaxWorkers();
    // Runs left active by a previous server have no process any more: make them resumable.
    for (const status of ACTIVE_RUN_STATUSES) {
      for (const r of this.db.$client.prepare('SELECT id FROM worker_runs WHERE status = ?').all(status) as { id: string }[]) {
        this.setStatus(r.id, 'stopped', { exitReason: 'server restarted', endedAt: now() });
      }
    }
  }

  runningCount(): number { return this.live.size; }

  start(goalId: string, o: { cwd?: string } = {}): WorkerRun {
    const goal = getGoal(this.db, goalId);
    if (activeRunForGoal(this.db, goalId)) throw new Error(`Goal ${goalId} already has an active worker.`);
    const run = createRun(this.db, { goalId, cwd: o.cwd ?? this.opts.defaultCwd });
    this.pendingFirst.set(run.id, firstMessage(goal));
    this.emit({ type: 'run-changed', goalId, runId: run.id, status: 'queued' });
    this.pump();
    return getRun(this.db, run.id);
  }

  resume(goalId: string): WorkerRun {
    if (activeRunForGoal(this.db, goalId)) throw new Error(`Goal ${goalId} already has an active worker.`);
    const last = listRuns(this.db, goalId).find(r => r.sessionId);
    if (!last) return this.start(goalId);
    // The previous process for this run id is still exiting; relaunching now would share its live slot.
    if (this.live.has(last.id)) throw new Error(`Worker for ${goalId} is still shutting down; try again in a moment.`);
    this.pendingFirst.set(last.id, resumeMessage(goalId));
    this.setStatus(last.id, 'queued', { exitReason: null, endedAt: null });
    this.pump();
    return getRun(this.db, last.id);
  }

  stop(runId: string): WorkerRun {
    const run = getRun(this.db, runId);
    if (END_STATES.includes(run.status)) return run;
    const l = this.live.get(runId);
    this.pendingFirst.delete(runId);
    this.setStatus(runId, 'stopped', { endedAt: now(), exitReason: 'stopped by user' });
    if (l) this.terminate(l);
    return getRun(this.db, runId);
  }

  stopAll(): void {
    for (const [id, l] of [...this.live.entries()]) {
      if (END_STATES.includes(getRun(this.db, id).status)) this.terminate(l);   // already finished, still exiting
      else this.stop(id);
    }
  }

  answersUpdated(goalId: string): void {
    const run = activeRunForGoal(this.db, goalId);
    if (!run || run.status !== 'waiting_answers') return;
    if (openMaterialQuestions(this.db, goalId).length > 0) return;
    const l = this.live.get(run.id);
    if (l) {
      this.setStatus(run.id, 'working');   // set first: a duplicate call now returns early
      l.nudged = false;
      this.write(l, userMessage(answersMessage(goalId)));
    } else {
      this.pendingFirst.set(run.id, answersMessage(goalId));
      this.setStatus(run.id, 'queued');
      this.pump();
    }
  }

  decide(approvalId: number, decision: 'allow' | 'deny', note?: string): Approval {
    const a = decidePermission(this.db, approvalId, decision, note);
    const l = a.runId ? this.live.get(a.runId) : undefined;
    if (l && !l.ended && a.requestId) {
      this.write(l, permissionResponse(a.requestId, decision, JSON.parse(a.requestJson ?? '{}'), note));
      const stillPending = pendingApprovals(this.db).some(p => p.runId === a.runId);
      if (!stillPending) this.setStatus(a.runId!, 'working');
    }
    return a;
  }

  private pump(): void {
    for (const run of queuedRuns(this.db)) {
      if (this.live.size >= this.maxWorkers) return;
      this.launch(run);
    }
  }

  private launch(run: WorkerRun): void {
    const [bin, ...pre] = this.command;
    const args = [...pre, ...workerArgs({ systemPrompt: workerSystemPrompt(run.goalId), resumeSessionId: run.sessionId ?? undefined })];
    const child = spawn(bin!, args, { cwd: run.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const l: Live = { child, goalId: run.goalId, nudged: false, stderr: '', ended: false };
    this.live.set(run.id, l);
    this.setStatus(run.id, 'starting', { pid: child.pid ?? null, startedAt: now(), endedAt: null });
    child.stderr.on('data', (d: Buffer) => { l.stderr = (l.stderr + d.toString()).slice(-2048); });
    child.stdin.on('error', () => { /* worker gone; exit handler reports it */ });
    readline.createInterface({ input: child.stdout }).on('line', line => this.onLine(run.id, l, line));
    child.on('exit', code => this.onExit(run.id, l, code));
    child.on('error', err => this.onSpawnError(run.id, l, err));
    this.write(l, initializeRequest());
    this.write(l, userMessage(this.pendingFirst.get(run.id) ?? resumeMessage(run.goalId)));
    this.pendingFirst.delete(run.id);
  }

  private onLine(runId: string, l: Live, line: string): void {
    // Output from a stopped/finished or superseded process must not revive the run.
    if (l.ended || this.live.get(runId) !== l) return;
    const msg = parseWorkerLine(line);
    for (const e of eventsFor(msg)) {
      this.emit({ type: 'worker-event', goalId: l.goalId, runId, event: addEvent(this.db, runId, e) });
    }
    if (msg.kind === 'init') {
      updateRun(this.db, runId, { sessionId: msg.sessionId });
      this.setStatus(runId, 'working');
    } else if (msg.kind === 'permission') {
      const a = createPermissionApproval(this.db, {
        goalId: l.goalId, runId, requestId: msg.requestId, toolName: msg.toolName, input: msg.input, description: msg.description,
      });
      this.setStatus(runId, 'waiting_approval');
      this.emit({ type: 'approval', goalId: l.goalId, runId, approvalId: a.id });
    } else if (msg.kind === 'result') {
      this.onTurnEnd(runId, l);
    }
  }

  private onTurnEnd(runId: string, l: Live): void {
    if (END_STATES.includes(getRun(this.db, runId).status)) return;
    const goalStatus = getGoal(this.db, l.goalId).status;
    if (goalStatus === 'COMPLETED') {
      this.finish(runId, l, 'completed', null);
    } else if (goalStatus === 'BLOCKED') {
      // The worker called brain_goal_block after lock: it needs the user, so don't nudge it onward.
      this.finish(runId, l, 'stopped', 'goal blocked — needs you');
    } else if (openMaterialQuestions(this.db, l.goalId).length > 0) {
      this.setStatus(runId, 'waiting_answers');
    } else if (!l.nudged) {
      l.nudged = true;
      this.write(l, userMessage(nudgeMessage(l.goalId)));
      this.setStatus(runId, 'working');
    } else {
      this.finish(runId, l, 'stopped', 'stalled');
    }
  }

  private finish(runId: string, l: Live, status: 'completed' | 'stopped', reason: string | null): void {
    this.setStatus(runId, status, { endedAt: now(), exitReason: reason });
    l.ended = true;
    l.child.stdin.end();
    this.armKill(l);
  }

  /** SIGTERM now, SIGKILL if the child is still around after the grace period. */
  private terminate(l: Live): void {
    l.ended = true;
    l.child.kill('SIGTERM');
    this.armKill(l);
  }

  private armKill(l: Live): void {
    if (l.killTimer || l.child.exitCode !== null || l.child.signalCode !== null) return;
    l.killTimer = setTimeout(() => {
      if (l.child.exitCode === null && l.child.signalCode === null) l.child.kill('SIGKILL');
    }, KILL_AFTER_MS);
    l.killTimer.unref();
  }

  private onExit(runId: string, l: Live, code: number | null): void {
    if (l.killTimer) { clearTimeout(l.killTimer); l.killTimer = undefined; }
    if (this.live.get(runId) !== l) return;   // superseded, or already handled by onSpawnError
    this.live.delete(runId);
    const run = getRun(this.db, runId);
    if (!l.ended && !END_STATES.includes(run.status)) {
      const tail = l.stderr.trim() ? ` — ${l.stderr.trim().split('\n').slice(-3).join(' | ')}` : '';
      this.setStatus(runId, 'failed', { endedAt: now(), exitReason: `exit code ${code ?? 'signal'}${tail}` });
    }
    l.ended = true;
    this.pump();
  }

  private onSpawnError(runId: string, l: Live, err: Error): void {
    if (l.killTimer) { clearTimeout(l.killTimer); l.killTimer = undefined; }
    if (this.live.get(runId) !== l) return;
    this.live.delete(runId);
    const wasEnded = l.ended;
    l.ended = true;
    if (!wasEnded && !END_STATES.includes(getRun(this.db, runId).status)) {
      this.setStatus(runId, 'failed', { endedAt: now(), exitReason: `spawn error: ${err.message}` });
    }
    this.pump();
  }

  private write(l: Live, obj: unknown): void {
    if (l.child.stdin.writable) l.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  private setStatus(runId: string, status: WorkerRun['status'], extra: Partial<WorkerRun> = {}): void {
    const r = updateRun(this.db, runId, { ...extra, status } as never);
    this.emit({ type: 'run-changed', goalId: r.goalId, runId, status });
  }

  private emit(e: ManagerEvent): void { this.opts.onEvent?.(e); }
}

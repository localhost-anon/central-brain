import os from 'node:os';
import path from 'node:path';
import { and, eq, isNotNull, like } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { decisions, goalProjects, goalRequirements, goals, observations, projects, workerRuns } from '../db/schema.js';
import { touchGoal } from './activity.js';
import { getGoal } from './goals.js';
import { getProject, listProjects, type Project } from './projects.js';

/**
 * A goal's project (phase 2, decision 43): the first goal_projects link. The web UI filters
 * by it; new goals get it from the folder the creating session runs in; existing goals get it
 * from a one-time inference.
 */
export interface GoalProjectRef { id: string; name: string }

const ref = (p: Project): GoalProjectRef => ({ id: p.id, name: p.name });

export function goalProject(db: BrainDb, goalId: string): GoalProjectRef | null {
  // goal_projects has a composite key; rowid order = link order, so the first link is the goal's project.
  return (db.$client.prepare(
    'SELECT p.id, p.name FROM goal_projects gp JOIN projects p ON p.id = gp.project_id WHERE gp.goal_id = ? ORDER BY gp.rowid LIMIT 1',
  ).get(goalId) as GoalProjectRef | undefined) ?? null;
}

/** Map of goal id → project for every linked goal (one query, for list views). */
export function goalProjectMap(db: BrainDb): Map<string, GoalProjectRef> {
  const rows = db.$client.prepare(
    'SELECT gp.goal_id AS goalId, p.id, p.name FROM goal_projects gp JOIN projects p ON p.id = gp.project_id ORDER BY gp.rowid',
  ).all() as { goalId: string; id: string; name: string }[];
  const map = new Map<string, GoalProjectRef>();
  for (const r of rows) if (!map.has(r.goalId)) map.set(r.goalId, { id: r.id, name: r.name });
  return map;
}

/** Replace the goal's project links with one project, or remove them all (null). */
export function setGoalProject(db: BrainDb, goalId: string, projectIdOrName: string | null): GoalProjectRef | null {
  getGoal(db, goalId);
  const project = projectIdOrName === null ? null : getProject(db, projectIdOrName);
  db.transaction((tx) => {
    tx.delete(goalProjects).where(eq(goalProjects.goalId, goalId)).run();
    if (project) tx.insert(goalProjects).values({ goalId, projectId: project.id }).run();
  });
  touchGoal(db, goalId);
  return project ? ref(project) : null;
}

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** A stored root_path as an absolute folder: expands a leading `~`. root_path is stored as given. */
export function resolveRoot(root: string): string {
  return path.resolve(root === '~' || root.startsWith('~/') ? path.join(os.homedir(), root.slice(1)) : root);
}

/** Registered project whose root_path is the longest prefix of `p` (on a path-segment boundary). */
export function projectForPath(db: BrainDb, p: string): Project | null {
  const abs = path.resolve(p);
  let best: { proj: Project; root: string } | null = null;
  for (const proj of listProjects(db)) {
    if (!proj.rootPath) continue;
    const root = resolveRoot(proj.rootPath);
    if (within(abs, root) && (!best || root.length > best.root.length)) best = { proj, root };
  }
  return best?.proj ?? null;
}

/** Link a just-created goal: an explicit project wins, else the project of `cwd`. Returns the link or null. */
export function linkGoalToCwd(db: BrainDb, goalId: string, o: { cwd?: string; project?: string }): GoalProjectRef | null {
  if (o.project) return setGoalProject(db, goalId, o.project);
  const proj = o.cwd ? projectForPath(db, o.cwd) : null;
  return proj ? setGoalProject(db, goalId, proj.id) : null;
}

// ---- one-time inference for goals without a project ----

export interface InferredLink { goalId: string; projectId: string; reason: 'records' | 'worker_cwd' | 'path' | 'name' }

/** The single top-scoring key, or null on an empty map or a tie. */
function winner(scores: Map<string, number>): string | null {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0 || (sorted[1] && sorted[1][1] === sorted[0]![1])) return null;
  return sorted[0]![0];
}

const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "central-brain", "central_brain" and "Central Brain" all match the same term. */
const termRe = (term: string) =>
  new RegExp(`(?<![\\w-])${escapeRe(term.toLowerCase()).replace(/[-_ ]/g, '[-_ ]')}(?![\\w-])`, 'g');

function goalText(db: BrainDb, goalId: string): string {
  const g = getGoal(db, goalId);
  const reqs = db.select({ d: goalRequirements.description }).from(goalRequirements)
    .where(eq(goalRequirements.goalId, goalId)).all().map(r => r.d);
  return [g.title, g.objective, ...reqs].join('\n');
}

function inferOne(db: BrainDb, goalId: string, all: Project[]): InferredLink | null {
  const g = getGoal(db, goalId);
  const text = goalText(db, goalId);

  // 1. Project folders named in the contract (absolute or ~/ form) — the strongest signal. A folder
  //    matches only on a path boundary ("/x/foo" does not match "/x/foo-repo"). A nested root beats
  //    its ancestor; two unrelated roots are a tie and give no link.
  const home = os.homedir();
  const hits: { p: Project; root: string }[] = [];
  for (const p of all) {
    if (!p.rootPath) continue;
    const root = resolveRoot(p.rootPath);
    const forms = [root, root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : null].filter(Boolean) as string[];
    if (forms.some(f => new RegExp(`(?<![\\w./~-])${escapeRe(f)}(?![\\w-]|\\.\\w)`).test(text))) hits.push({ p, root });
  }
  const leaves = hits.filter(h => !hits.some(o => o !== h && within(o.root, h.root) && o.root !== h.root));
  if (leaves.length === 1) return { goalId, projectId: leaves[0]!.p.id, reason: 'path' };
  if (leaves.length > 1) return null;

  // 2. Project-scoped Brain records written for this goal.
  const scoped = [
    ...db.select({ s: observations.scopeId }).from(observations)
      .where(and(eq(observations.goalId, goalId), like(observations.scopeId, 'project:%'))).all(),
    ...db.select({ s: decisions.scopeId }).from(decisions)
      .where(and(eq(decisions.goalId, goalId), like(decisions.scopeId, 'project:%'))).all(),
  ];
  const known = new Set(all.map(p => p.id));
  const byRecords = new Map<string, number>();
  for (const r of scoped) { const id = r.s!.slice('project:'.length); if (known.has(id)) bump(byRecords, id); }
  const rec = winner(byRecords);
  if (rec) return { goalId, projectId: rec, reason: 'records' };

  // 3. Folder a UI worker ran in.
  const run = db.select({ cwd: workerRuns.cwd }).from(workerRuns).where(eq(workerRuns.goalId, goalId)).limit(1).get();
  const runProj = run ? projectForPath(db, run.cwd) : null;
  if (runProj) return { goalId, projectId: runProj.id, reason: 'worker_cwd' };

  // 4. A project name in the TITLE (whole word; last path segment of the name, or the id). Body text is
  //    too noisy ("over-strict floor" is not the Floor project).
  const title = g.title.toLowerCase();
  const byName = new Map<string, number>();
  for (const p of all) {
    const terms = new Set([path.basename(p.name), p.id].filter(t => t.length >= 4));
    let hits = 0;
    for (const t of terms) hits = Math.max(hits, (title.match(termRe(t)) ?? []).length);
    if (hits) bump(byName, p.id, hits);
  }
  const name = winner(byName);
  return name ? { goalId, projectId: name, reason: 'name' } : null;
}

/** Link every goal that has no project to its inferred project. Never touches goals that already have one. */
export function inferGoalProjects(db: BrainDb, o: { dryRun?: boolean } = {}): { linked: InferredLink[]; unassigned: string[] } {
  const all = listProjects(db);
  const linkedIds = new Set(db.select({ g: goalProjects.goalId }).from(goalProjects).all().map(r => r.g));
  const candidates = db.select({ id: goals.id }).from(goals).where(isNotNull(goals.id)).all()
    .map(g => g.id).filter(id => !linkedIds.has(id));
  const linked: InferredLink[] = [];
  const unassigned: string[] = [];
  for (const id of candidates) {
    const hit = inferOne(db, id, all);
    if (hit) linked.push(hit); else unassigned.push(id);
  }
  if (!o.dryRun) {
    db.transaction((tx) => {
      for (const l of linked) tx.insert(goalProjects).values({ goalId: l.goalId, projectId: l.projectId }).onConflictDoNothing().run();
    });
  }
  return { linked, unassigned };
}

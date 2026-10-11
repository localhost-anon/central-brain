import type { IncomingMessage, ServerResponse } from 'node:http';
import { desc, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { approvals as approvalsTable, failures } from '../db/schema.js';
import type { Embedder } from '../services/embedder.js';
import { listDecisions } from '../services/decisions.js';
import { createGoal, getGoal, listGoals, listRequirements, openMaterialQuestions } from '../services/goals.js';
import { hybridSearch } from '../services/hybrid-search.js';
import { buildIntakeReport } from '../services/intake.js';
import { getProject, listProjects } from '../services/projects.js';
import { goalProject, goalProjectMap, resolveRoot, setGoalProject } from '../services/goal-project.js';
import { answerQuestion, dismissQuestion, getQuestion, listQuestions } from '../services/questions.js';
import { search } from '../services/search.js';
import { listVerifications } from '../services/verification.js';
import { activeRunForGoal, listEvents, listRuns, pendingApprovals } from '../services/workers.js';
import type { WorkerControl } from '../workers/manager.js';

export interface ApiContext {
  db: BrainDb; workers: WorkerControl; embedder: () => Embedder; defaultCwd: string;
  announce(goalId: string): void;
}

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new HttpError(413, 'Body too large'); }
  if (!raw) return {};
  try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } catch { /* fallthrough */ }
  throw new HttpError(400, 'Body must be a JSON object');
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  return v.trim();
};

function goalOr404(db: BrainDb, id: string) {
  try { return getGoal(db, id); } catch { throw new HttpError(404, `Goal not found: ${id}`); }
}

export function goalSummaries(db: BrainDb) {
  const projects = goalProjectMap(db);
  return listGoals(db).map(g => {
    const crit = listRequirements(db, g.id).filter(r => r.requirementType === 'success_criterion' && r.priority === 'required');
    const run = activeRunForGoal(db, g.id) ?? listRuns(db, g.id)[0];
    return {
      id: g.id, title: g.title, status: g.status, riskLevel: g.riskLevel, updatedAt: g.updatedAt,
      project: projects.get(g.id) ?? null,
      criteria: { passed: crit.filter(r => r.status === 'PASSED').length, total: crit.length },
      openQuestions: TERMINAL.includes(g.status) ? 0 : openMaterialQuestions(db, g.id).length,
      pendingApprovals: pendingApprovals(db, g.id).length,
      run: run ? { id: run.id, status: run.status, cwd: run.cwd } : null,
    };
  });
}

export function goalDetail(db: BrainDb, id: string) {
  const goal = goalOr404(db, id);
  const questions = listQuestions(db, id);
  const decisions = listDecisions(db, { goalId: id });
  const fails = db.select().from(failures).where(eq(failures.goalId, id)).orderBy(desc(failures.id)).all();
  const verifications = listVerifications(db, { goalId: id });
  const runs = listRuns(db, id);
  const events = runs[0] ? listEvents(db, runs[0].id, { limit: 200 }) : [];
  const approvals = db.select().from(approvalsTable).where(eq(approvalsTable.goalId, id)).orderBy(desc(approvalsTable.id)).all();
  const t: { ts: string; kind: string; text: string }[] = [
    { ts: goal.createdAt, kind: 'goal', text: 'Goal created' },
    ...(goal.lockedAt ? [{ ts: goal.lockedAt, kind: 'goal', text: 'Contract locked' }] : []),
    ...(goal.startedAt ? [{ ts: goal.startedAt, kind: 'goal', text: 'Execution started' }] : []),
    ...(goal.completedAt ? [{ ts: goal.completedAt, kind: 'goal', text: 'Goal completed' }] : []),
    ...questions.map(q => ({ ts: q.createdAt, kind: 'question', text: `Asked: ${q.question}` })),
    ...questions.filter(q => q.answeredAt).map(q => ({ ts: q.answeredAt!, kind: 'answer', text: `Answered: ${q.answer}` })),
    ...decisions.map(d => ({ ts: d.createdAt, kind: 'decision', text: d.decision })),
    ...fails.map(f => ({ ts: f.createdAt, kind: 'failure', text: f.errorMessage ?? 'Failure' })),
    ...verifications.map(v => ({ ts: v.createdAt, kind: v.passed ? 'verified' : 'verify-failed', text: v.actualResult ?? v.command ?? 'Verification' })),
    ...events.map(e => ({ ts: e.ts, kind: `worker-${e.kind}`, text: e.summary })),
  ];
  t.sort((a, b) => a.ts.localeCompare(b.ts));
  return {
    goal, project: goalProject(db, id), requirements: listRequirements(db, id), questions, approvals, decisions, failures: fails,
    verifications, runs, events, timeline: t,
    openQuestions: TERMINAL.includes(goal.status) ? [] : openMaterialQuestions(db, id).map(q => q.id),
  };
}

export function needsYou(db: BrainDb) {
  const goals = listGoals(db).filter(g => !TERMINAL.includes(g.status));
  const questions = goals.flatMap(g => openMaterialQuestions(db, g.id).map(q => ({ ...q, goalTitle: g.title })));
  const approvals = pendingApprovals(db).map(a => ({ ...a, goalTitle: a.goalId ? goalOr404(db, a.goalId).title : '' }));
  return { questions, approvals, count: questions.length + approvals.length };
}

async function searchGoalIds(ctx: ApiContext, q: string): Promise<Set<string>> {
  try {
    return new Set((await hybridSearch(ctx.db, ctx.embedder(), q, { types: ['goal'], limit: 50 })).map(r => r.id));
  } catch {
    return new Set(search(ctx.db, q, { types: ['goal'], limit: 50 }).map(r => r.id));
  }
}

export async function handleApi(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;
  const m = (re: RegExp) => p.match(re);
  try {
    if (req.method === 'GET' && p === '/api/goals') {
      let rows = goalSummaries(ctx.db);
      const status = url.searchParams.get('status');
      if (status) rows = rows.filter(r => r.status === status);
      // ?project=<id> or ?project=unassigned (goals with no project).
      const project = url.searchParams.get('project');
      if (project) rows = rows.filter(r => (project === 'unassigned' ? r.project === null : r.project?.id === project));
      const q = url.searchParams.get('q')?.trim();
      if (q) { const ids = await searchGoalIds(ctx, q); rows = rows.filter(r => ids.has(r.id)); }
      send(res, 200, rows); return true;
    }
    if (req.method === 'GET' && p === '/api/projects') { send(res, 200, listProjects(ctx.db)); return true; }
    if (req.method === 'GET' && p === '/api/needs-you') { send(res, 200, needsYou(ctx.db)); return true; }
    let g = m(/^\/api\/goals\/([^/]+)$/);
    if (req.method === 'GET' && g) {
      let id: string;
      try { id = decodeURIComponent(g[1]!); } catch { throw new HttpError(404, 'Goal not found'); }
      send(res, 200, goalDetail(ctx.db, id)); return true;
    }
    if (req.method === 'POST' && p === '/api/goals') {
      const b = await readJson(req);
      const title = str(b.title, 'title');
      const objective = str(b.objective, 'objective');
      let cwd = ctx.defaultCwd;
      if (typeof b.projectId === 'string' && b.projectId) {
        const proj = listProjects(ctx.db).find(x => x.id === b.projectId);
        if (!proj) throw new HttpError(400, `Unknown project: ${b.projectId}`);
        if (proj.rootPath) cwd = resolveRoot(proj.rootPath);
      }
      const goal = createGoal(ctx.db, { title, objective });
      if (typeof b.projectId === 'string' && b.projectId) setGoalProject(ctx.db, goal.id, b.projectId);
      await buildIntakeReport(ctx.db, ctx.embedder(), goal.id);
      // The goal is already committed: a worker launch failure must not surface as a failed
      // create (the UI would retry and duplicate the goal), so report it alongside the 201.
      let run: unknown = null;
      let workerError: string | undefined;
      if (b.startWorker !== false) {
        try { run = ctx.workers.start(goal.id, { cwd }); } catch (e) { workerError = (e as Error).message; }
      }
      ctx.announce(goal.id);
      send(res, 201, workerError === undefined
        ? { goal: getGoal(ctx.db, goal.id), run }
        : { goal: getGoal(ctx.db, goal.id), run: null, workerError });
      return true;
    }
    let q = m(/^\/api\/questions\/(\d+)\/(answer|dismiss)$/);
    if (req.method === 'POST' && q) {
      const b = await readJson(req);
      const id = Number(q[1]);
      const goalId = getQuestion(ctx.db, id).goalId;
      const out = q[2] === 'answer'
        ? answerQuestion(ctx.db, id, str(b.answer, 'answer'), { as: typeof b.as === 'string' && b.as ? b.as : undefined })
        : dismissQuestion(ctx.db, id, str(b.reason, 'reason'));
      ctx.workers.answersUpdated(goalId);
      ctx.announce(goalId);
      send(res, 200, out); return true;
    }
    let a = m(/^\/api\/approvals\/(\d+)$/);
    if (req.method === 'POST' && a) {
      const b = await readJson(req);
      if (b.decision !== 'allow' && b.decision !== 'deny') throw new HttpError(400, 'decision must be allow or deny');
      const out = ctx.workers.decide(Number(a[1]), b.decision, typeof b.note === 'string' && b.note ? b.note : undefined);
      if (out.goalId) ctx.announce(out.goalId);
      send(res, 200, out); return true;
    }
    g = m(/^\/api\/goals\/([^/]+)\/project$/);
    if (req.method === 'POST' && g) {
      const b = await readJson(req);
      const goal = goalOr404(ctx.db, g[1]!);
      if (b.projectId !== null && typeof b.projectId !== 'string') throw new HttpError(400, 'projectId must be a project id or null');
      if (typeof b.projectId === 'string') { try { getProject(ctx.db, b.projectId); } catch { throw new HttpError(400, `Unknown project: ${b.projectId}`); } }
      const project = setGoalProject(ctx.db, goal.id, b.projectId === '' ? null : b.projectId);
      ctx.announce(goal.id);
      send(res, 200, { goalId: goal.id, project }); return true;
    }
    g = m(/^\/api\/goals\/([^/]+)\/worker$/);
    if (req.method === 'POST' && g) {
      const b = await readJson(req);
      const goal = goalOr404(ctx.db, g[1]!);
      // Workers run in the goal's project folder when it has one.
      const root = (() => { const pr = goalProject(ctx.db, goal.id); const r = pr ? getProject(ctx.db, pr.id).rootPath : null; return r ? resolveRoot(r) : null; })();
      let out: unknown;
      if (b.action === 'start') out = ctx.workers.start(goal.id, root ? { cwd: root } : {});
      else if (b.action === 'resume') out = ctx.workers.resume(goal.id);
      else if (b.action === 'stop') {
        const run = activeRunForGoal(ctx.db, goal.id);
        if (!run) throw new HttpError(409, 'No active worker for this goal');
        out = ctx.workers.stop(run.id);
      } else throw new HttpError(400, 'action must be start, stop or resume');
      ctx.announce(goal.id);
      send(res, 200, out); return true;
    }
    send(res, 404, { error: 'Not found' }); return true;
  } catch (e) {
    const err = e as Error;
    const status = e instanceof HttpError ? e.status : /not found/i.test(err.message) ? 404 : 400;
    send(res, status, { error: err.message }); return true;
  }
}

import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal, addRequirement } from '../src/services/goals.js';
import { addProject } from '../src/services/projects.js';
import { addDecision, addObservation } from '../src/services/decisions.js';
import { linkGoalProject } from '../src/services/principles.js';
import {
  goalProject, setGoalProject, projectForPath, inferGoalProjects, linkGoalToCwd,
} from '../src/services/goal-project.js';

function seed() {
  const db = createTestDb();
  const market = addProject(db, { name: 'market', rootPath: '/home/u/Projects/market' });
  const brain = addProject(db, { name: 'central-brain', rootPath: '/home/u/Projects/central-brain' });
  const sh = addProject(db, { name: 'Selfhosting', rootPath: '/home/u/Projects/Selfhosting' });
  const echo = addProject(db, { name: 'Selfhosting/echo-app', rootPath: '/home/u/Projects/Selfhosting/echo-app' });
  return { db, market, brain, sh, echo };
}

describe('projectForPath', () => {
  it('picks the longest registered root that prefixes the path, on a path-segment boundary', () => {
    const { db, sh, echo, brain } = seed();
    expect(projectForPath(db, '/home/u/Projects/Selfhosting/echo-app/api')?.id).toBe(echo.id);
    expect(projectForPath(db, '/home/u/Projects/Selfhosting')?.id).toBe(sh.id);
    expect(projectForPath(db, '/home/u/Projects/central-brain/.claude/worktrees/x')?.id).toBe(brain.id);
    expect(projectForPath(db, '/home/u/Projects/marketing')).toBeNull(); // not a prefix on a boundary
    expect(projectForPath(db, '/tmp')).toBeNull();
  });
});

describe('goalProject / setGoalProject', () => {
  it('returns the first link and replaces all links when set; null clears', () => {
    const { db, market, brain } = seed();
    const g = createGoal(db, { title: 't', objective: 'o' });
    expect(goalProject(db, g.id)).toBeNull();
    linkGoalProject(db, g.id, market.id);
    linkGoalProject(db, g.id, brain.id);
    expect(goalProject(db, g.id)).toEqual({ id: market.id, name: 'market' });
    setGoalProject(db, g.id, brain.id);
    expect(goalProject(db, g.id)).toEqual({ id: brain.id, name: 'central-brain' });
    setGoalProject(db, g.id, null);
    expect(goalProject(db, g.id)).toBeNull();
    expect(() => setGoalProject(db, g.id, 'nope')).toThrow(/Project not found/);
  });
});

describe('linkGoalToCwd (criterion 257)', () => {
  it('links a new goal to the project of the creating folder; explicit project wins; unregistered folder stays unassigned', () => {
    const { db, market, brain } = seed();
    const a = createGoal(db, { title: 'a', objective: 'o' });
    expect(linkGoalToCwd(db, a.id, { cwd: '/home/u/Projects/market/tradingview' })).toEqual({ id: market.id, name: 'market' });
    const b = createGoal(db, { title: 'b', objective: 'o' });
    expect(linkGoalToCwd(db, b.id, { cwd: '/home/u/Projects/market', project: 'central-brain' })).toEqual({ id: brain.id, name: 'central-brain' });
    const c = createGoal(db, { title: 'c', objective: 'o' });
    expect(linkGoalToCwd(db, c.id, { cwd: '/home/u/Projects/AI_TOOLS/ai_mobile_os' })).toBeNull();
    expect(goalProject(db, c.id)).toBeNull();
  });
});

describe('inferGoalProjects', () => {
  it('uses scoped records first, then contract paths, then names; never overwrites; skips ties', () => {
    const { db, market, brain, sh, echo } = seed();
    const linked = createGoal(db, { title: 'already', objective: 'o' });
    setGoalProject(db, linked.id, sh.id);
    addObservation(db, { goalId: linked.id, observation: 'x', scopeType: 'PROJECT', scopeId: `project:${market.id}` });

    const byRecords = createGoal(db, { title: 'records', objective: 'o' });
    addDecision(db, { goalId: byRecords.id, decision: 'd', scopeType: 'PROJECT', scopeId: `project:${market.id}` });
    addObservation(db, { goalId: byRecords.id, observation: 'o', scopeType: 'PROJECT', scopeId: `project:${market.id}` });

    const byPath = createGoal(db, { title: 'path', objective: 'o' });
    addRequirement(db, byPath.id, { type: 'scope', description: 'Edit /home/u/Projects/Selfhosting/echo-app/api/main.py' });

    const byName = createGoal(db, { title: 'Central Brain web UI: central-brain sidebar', objective: 'o' });

    const tie = createGoal(db, { title: 'market and central-brain both', objective: 'o' });

    const none = createGoal(db, { title: 'Nothing here', objective: 'o' });

    const dry = inferGoalProjects(db, { dryRun: true });
    expect(dry.linked.map(l => [l.goalId, l.projectId]).sort()).toEqual([
      [byRecords.id, market.id], [byPath.id, echo.id], [byName.id, brain.id],
    ].sort());
    expect(goalProject(db, byRecords.id)).toBeNull(); // dry run writes nothing
    expect(dry.unassigned).toEqual(expect.arrayContaining([tie.id, none.id]));

    const res = inferGoalProjects(db);
    expect(res.linked).toHaveLength(3);
    expect(goalProject(db, linked.id)?.id).toBe(sh.id); // untouched
    expect(goalProject(db, byPath.id)?.id).toBe(echo.id);
    expect(inferGoalProjects(db).linked).toHaveLength(0); // idempotent
  });
});

describe('goal create surfaces auto-link from the working folder (criterion 257)', () => {
  it('MCP brain_goal_create links to the project of the session folder; project overrides', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { buildServer } = await import('../src/mcp/server.js');
    const db = createTestDb();
    const here = addProject(db, { name: 'here', rootPath: process.cwd() });
    const other = addProject(db, { name: 'other', rootPath: '/elsewhere' });
    const server = buildServer(db);
    const client = new Client({ name: 't', version: '0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name: 'brain_goal_create', arguments: args })) as any).content[0].text);
    const a = await call({ title: 'a', objective: 'o' });
    expect(a.project).toEqual({ id: here.id, name: 'here' });
    expect(goalProject(db, a.id)?.id).toBe(here.id);
    const b = await call({ title: 'b', objective: 'o', project: 'other' });
    expect(b.project).toEqual({ id: other.id, name: 'other' });
    await client.close();
  });

  it('CLI goal create links to the project of the current folder', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cwd-'));
    const proj = path.join(tmp, 'proj'); fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
    const env = { ...process.env, BRAIN_DB: path.join(tmp, 'b.db') };
    const cli = (cwd: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath,
      [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), path.join(process.cwd(), 'src/cli/index.ts'), ...args],
      { env, cwd, encoding: 'utf8' }));
    cli(tmp, 'project', 'add', 'proj', '--path', fs.realpathSync(proj));
    const g = cli(fs.realpathSync(path.join(proj, 'sub')), 'goal', 'create', 'x', '-o', 'y');
    expect(g.project).toEqual({ id: 'proj', name: 'proj' });
    expect(cli(tmp, 'goal', 'set-project', g.id, 'none')).toBeNull();
  }, 60000);
});

describe('review fixes', () => {
  it('projectForPath expands a ~ root_path and compares resolved lengths', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const db = createTestDb();
    const p = addProject(db, { name: 'tilde', rootPath: '~/Projects/tilde' });
    expect(projectForPath(db, path.join(os.homedir(), 'Projects/tilde/src'))?.id).toBe(p.id);
  });

  it('inference matches a contract path only on a boundary and leaves unrelated roots unassigned', () => {
    const { db, market, brain } = seed();
    const sibling = createGoal(db, { title: 'sib', objective: 'Edit /home/u/Projects/marketing/x and /home/u/Projects/market-old/y' });
    const both = createGoal(db, { title: 'both', objective: 'Touch /home/u/Projects/market/a and /home/u/Projects/central-brain/b' });
    const sentence = createGoal(db, { title: 'end', objective: 'Work in /home/u/Projects/market.' });
    const nested = createGoal(db, { title: 'other tree', objective: 'Copy /backup/home/u/Projects/market/x' });
    const dry = inferGoalProjects(db, { dryRun: true });
    const byGoal = new Map(dry.linked.map(l => [l.goalId, l.projectId]));
    expect(byGoal.has(sibling.id)).toBe(false);
    expect(byGoal.has(both.id)).toBe(false);
    expect(byGoal.get(sentence.id)).toBe(market.id);
    expect(byGoal.has(nested.id)).toBe(false);
    void brain;
  });

  it('MCP brain_goal_create with an unknown project fails and creates no goal', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { buildServer } = await import('../src/mcp/server.js');
    const { listGoals } = await import('../src/services/goals.js');
    const db = createTestDb();
    const server = buildServer(db);
    const client = new Client({ name: 't', version: '0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = (await client.callTool({ name: 'brain_goal_create', arguments: { title: 'x', objective: 'o', project: 'typo' } })) as any;
    expect(res.isError).toBe(true);
    expect(listGoals(db)).toHaveLength(0);
    await client.close();
  });
});

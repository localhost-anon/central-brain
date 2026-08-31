# Central Brain Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add workspace scanners, failure tracking with reusable solutions, verification runs that drive requirement status, and goal resume — then scan the real `~/Projects` workspace so the Brain knows the user's world (ARCHITECTURE.md §78, tracked as GOAL-2026-0002 in brain.db).

**Architecture:** Four new services (`scanner`, `failures`, `verification`, `resume`) in the established pattern — pure functions over `BrainDb` — wired into the existing Commander CLI and MCP server. No schema changes: every table these services need (failures, failure_solutions, verification_runs) shipped in Milestone 1. Scanner reads only manifest files, never source (§55).

**Tech Stack:** unchanged — TypeScript ESM (NodeNext), better-sqlite3 + Drizzle, Commander, @modelcontextprotocol/sdk, vitest.

**Spec:** `ARCHITECTURE.md` v0.2 — §54–55 (discovery/repo understanding), §31–32 (failures/solutions), §35 + §64 (verification → requirement status), §66 (failure reuse), §72 (resume), §78 (phase scope).

## Global Constraints

- ESM only; relative imports carry `.js` extensions.
- Repo root `$HOME/Projects/central-brain`; suite currently 45/45 green at commit `45c0a7a`; every task keeps it green (`npx tsc --noEmit` + full `npx vitest run` before each commit).
- Tests use `createTestDb()` from `tests/helpers.js` and `fs.mkdtempSync(path.join(os.tmpdir(), ...))` fixture dirs — never the repo, never `~/.central-brain`, never `~/Projects` (the real scan happens only in the final task).
- Scanner stores metadata and derived knowledge only — never file contents (§55). Scan-seeded knowledge rows use `sourceType: 'scan'`, scope `project:<id>`, and are idempotent across re-scans (verify if unchanged, supersede if changed, per §28).
- Reference fields use §16.1 prefixed IDs (`project:x`, `goal:GOAL-…`).
- Timestamps via `new Date().toISOString()`.
- Statuses/types are runtime-whitelisted (Milestone 1 convention): reuse existing validators; new enums follow the same throw style (`Invalid …: <value>`).
- Semantic search, AST/file indexing, watchers: explicitly OUT of scope (Phase 3+).
- Commit after every task; every commit message ends with `Goal: GOAL-2026-0002` and `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` on separate lines.
- Existing service signatures this plan consumes (do not modify): `slugify(name)`, `addProject/getProject/addRepo/listRepos`, `addKnowledge/verifyKnowledge/supersedeKnowledge` (supersede throws on non-active), `setRequirementStatus(db, id, status, reason?)`, `listRequirements(db, goalId)`, `getGoal/currentGoal`, `listWorkUnits/readyWorkUnits`, `listDecisions`, `search(db, q, {types, limit})`, `recommendModel`.

---

### Task 1: Scanner — detection & metadata (pure functions)

**Files:**
- Create: `src/services/scanner.ts` (detection half)
- Test: `tests/scanner.test.ts`

**Interfaces:**
- Consumes: `node:fs`, `node:path` only
- Produces (from `src/services/scanner.js`):
  - `interface ProjectInfo { name: string; path: string; markers: string[]; hasGit: boolean; language?: string; framework?: string; packageManager?: string }` (`name` = path relative to the scan root, e.g. `Selfhosting/echo-app`)
  - `detectProject(dir: string): Omit<ProjectInfo, 'name'> | null` — null when no markers
  - `discoverProjects(rootDir: string): ProjectInfo[]` — one level deep, plus one extra level inside marker-less "sub-workspace" dirs; skips dot-dirs and `node_modules/dist/build/.venv/venv/__pycache__`

- [ ] **Step 1: Write failing tests**

`tests/scanner.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProject, discoverProjects } from '../src/services/scanner.js';

let root: string;

function mk(rel: string, content = ''): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-scan-'));
  // TS/node app with git, npm lockfile, react
  mk('node-app/package.json', JSON.stringify({ name: 'node-app', dependencies: { react: '^18.0.0' } }));
  mk('node-app/tsconfig.json', '{}');
  mk('node-app/package-lock.json', '{}');
  fs.mkdirSync(path.join(root, 'node-app', '.git'), { recursive: true });
  // python app
  mk('py-app/pyproject.toml', '[project]\nname = "py-app"');
  // sub-workspace: no markers itself, contains a go project
  mk('workspace/sub-go/go.mod', 'module example.com/sub');
  // plain dir with no markers anywhere
  fs.mkdirSync(path.join(root, 'plain-dir', 'stuff'), { recursive: true });
  // noise that must be skipped
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
});

describe('scanner detection', () => {
  it('detects a node project with metadata', () => {
    const info = detectProject(path.join(root, 'node-app'))!;
    expect(info.hasGit).toBe(true);
    expect(info.language).toBe('typescript');
    expect(info.framework).toBe('react');
    expect(info.packageManager).toBe('npm');
    expect(info.markers).toContain('package.json');
  });

  it('detects python and returns null for marker-less dirs', () => {
    expect(detectProject(path.join(root, 'py-app'))!.language).toBe('python');
    expect(detectProject(path.join(root, 'plain-dir'))).toBeNull();
    expect(detectProject(path.join(root, 'does-not-exist'))).toBeNull();
  });

  it('discovers top-level and sub-workspace projects, skipping noise', () => {
    const names = discoverProjects(root).map(p => p.name).sort();
    expect(names).toEqual(['node-app', 'py-app', 'workspace/sub-go']);
    const go = discoverProjects(root).find(p => p.name === 'workspace/sub-go')!;
    expect(go.language).toBe('go');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/scanner.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/scanner.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface ProjectInfo {
  name: string;
  path: string;
  markers: string[];
  hasGit: boolean;
  language?: string;
  framework?: string;
  packageManager?: string;
}

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt',
  'go.mod', 'Cargo.toml', 'docker-compose.yml', 'Dockerfile'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__']);
const FRAMEWORK_DEPS = ['next', '@nestjs/core', 'react', 'vue', 'express', 'fastify', 'commander'];

export function detectProject(dir: string): Omit<ProjectInfo, 'name'> | null {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const markers = MARKERS.filter(m => entries.includes(m));
  if (markers.length === 0) return null;
  const info: Omit<ProjectInfo, 'name'> = { path: dir, markers, hasGit: markers.includes('.git') };
  if (entries.includes('package.json')) {
    info.language = entries.includes('tsconfig.json') ? 'typescript' : 'javascript';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
      const fw = FRAMEWORK_DEPS.find(f => f in deps);
      info.framework = fw === '@nestjs/core' ? 'nestjs' : fw;
    } catch { /* unreadable manifest: metadata stays unset */ }
    info.packageManager = entries.includes('pnpm-lock.yaml') ? 'pnpm'
      : entries.includes('yarn.lock') ? 'yarn'
      : entries.includes('package-lock.json') ? 'npm' : undefined;
  } else if (entries.includes('pyproject.toml') || entries.includes('requirements.txt')) {
    info.language = 'python';
  } else if (entries.includes('go.mod')) {
    info.language = 'go';
  } else if (entries.includes('Cargo.toml')) {
    info.language = 'rust';
  }
  return info;
}

function childDirs(dir: string): string[] {
  return fs.readdirSync(dir).filter(e => {
    if (SKIP.has(e) || e.startsWith('.')) return false;
    try { return fs.statSync(path.join(dir, e)).isDirectory(); } catch { return false; }
  });
}

export function discoverProjects(rootDir: string): ProjectInfo[] {
  const found: ProjectInfo[] = [];
  for (const entry of childDirs(rootDir)) {
    const dir = path.join(rootDir, entry);
    const info = detectProject(dir);
    if (info) {
      found.push({ name: entry, ...info });
      continue;
    }
    // marker-less dir: treat as sub-workspace, descend exactly one more level
    for (const child of childDirs(dir)) {
      const cinfo = detectProject(path.join(dir, child));
      if (cinfo) found.push({ name: `${entry}/${child}`, ...cinfo });
    }
  }
  return found;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/scanner.test.ts` — Expected: 3 PASS. Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/scanner.ts tests/scanner.test.ts
git commit -m "feat: project detection and workspace discovery (scanner, pure half)

Goal: GOAL-2026-0002

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Scanner — registration & idempotent knowledge seeding

**Files:**
- Modify: `src/services/scanner.ts` (append the DB half)
- Test: `tests/scanner-db.test.ts`

**Interfaces:**
- Consumes: Task 1's `discoverProjects`; `slugify`; `addProject/getProject/addRepo`; `addKnowledge/verifyKnowledge/supersedeKnowledge`; `projects`, `repositories`, `knowledge` tables
- Produces (appended to `src/services/scanner.js`):
  - `interface ScanResult { registered: number; updated: number; projects: string[] }`
  - `scanProjects(db: BrainDb, rootDir: string): ScanResult` — registers new projects (id = `slugify(relative name)`), updates `rootPath`/`updatedAt` on known ones, adds a repo row when `.git` present (id = project id), and seeds one active `knowledge` row per known fact (categories `language`, `framework`, `package-manager`; `scopeType 'PROJECT'`, `scopeId 'project:<id>'`, `sourceType 'scan'`). Re-scan: unchanged fact → `verifyKnowledge`; changed fact → `supersedeKnowledge`; no duplicates ever.

- [ ] **Step 1: Write failing tests**

`tests/scanner-db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers.js';
import { scanProjects } from '../src/services/scanner.js';
import { listProjects, listRepos } from '../src/services/projects.js';
import { listKnowledge } from '../src/services/knowledge.js';

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-scandb-'));
  const app = path.join(root, 'my-app');
  fs.mkdirSync(path.join(app, '.git'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'),
    JSON.stringify({ name: 'my-app', dependencies: { express: '^4.0.0' } }));
  fs.writeFileSync(path.join(app, 'package-lock.json'), '{}');
  return root;
}

describe('scanProjects', () => {
  it('registers projects, repos, and scan knowledge', () => {
    const db = createTestDb();
    const root = makeWorkspace();
    const res = scanProjects(db, root);
    expect(res.registered).toBe(1);
    expect(res.updated).toBe(0);
    expect(listProjects(db).map(p => p.id)).toEqual(['my-app']);
    expect(listRepos(db)).toHaveLength(1);
    const facts = listKnowledge(db, { scopeId: 'project:my-app' }).map(k => k.statement).sort();
    expect(facts).toEqual(['Framework: express', 'Language: javascript', 'Package manager: npm']);
  });

  it('re-scan is idempotent: verifies unchanged facts, no duplicates', () => {
    const db = createTestDb();
    const root = makeWorkspace();
    scanProjects(db, root);
    const res2 = scanProjects(db, root);
    expect(res2.registered).toBe(0);
    expect(res2.updated).toBe(1);
    const facts = listKnowledge(db, { scopeId: 'project:my-app' });
    expect(facts).toHaveLength(3);
    expect(facts.every(k => k.lastVerifiedAt !== null)).toBe(true);
  });

  it('supersedes a changed fact instead of duplicating', () => {
    const db = createTestDb();
    const root = makeWorkspace();
    scanProjects(db, root);
    // framework changes from express to fastify
    fs.writeFileSync(path.join(root, 'my-app', 'package.json'),
      JSON.stringify({ name: 'my-app', dependencies: { fastify: '^4.0.0' } }));
    scanProjects(db, root);
    const active = listKnowledge(db, { scopeId: 'project:my-app' });
    expect(active.find(k => k.category === 'framework')!.statement).toBe('Framework: fastify');
    expect(active).toHaveLength(3); // still exactly one active fact per category
    const all = listKnowledge(db, { scopeId: 'project:my-app', includeInactive: true });
    expect(all.find(k => k.statement === 'Framework: express')!.status).toBe('superseded');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/scanner-db.test.ts` — Expected: FAIL (`scanProjects` not exported).

- [ ] **Step 3: Implement (append to `src/services/scanner.ts`)**

Add these imports at the top (merging with existing):

```ts
import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { knowledge, projects, repositories } from '../db/schema.js';
import { slugify } from '../ids.js';
import { addKnowledge, supersedeKnowledge, verifyKnowledge } from './knowledge.js';
import { addProject, addRepo, getProject } from './projects.js';
```

Append:

```ts
export interface ScanResult { registered: number; updated: number; projects: string[] }

function seedFact(db: BrainDb, scopeId: string, category: string, statement: string): void {
  const existing = db.select().from(knowledge).where(and(
    eq(knowledge.scopeId, scopeId),
    eq(knowledge.category, category),
    eq(knowledge.sourceType, 'scan'),
    eq(knowledge.status, 'active'),
  )).get();
  if (!existing) {
    addKnowledge(db, { scopeType: 'PROJECT', scopeId, category, statement, sourceType: 'scan' });
  } else if (existing.statement === statement) {
    verifyKnowledge(db, existing.id);
  } else {
    supersedeKnowledge(db, existing.id, { statement, sourceType: 'scan' });
  }
}

export function scanProjects(db: BrainDb, rootDir: string): ScanResult {
  const infos = discoverProjects(rootDir);
  let registered = 0;
  let updated = 0;
  for (const p of infos) {
    const id = slugify(p.name);
    if (!id) continue; // unslugifiable name: skip rather than register an empty id
    let projectId: string;
    try {
      projectId = getProject(db, id).id;
      db.update(projects).set({ rootPath: p.path, updatedAt: new Date().toISOString() })
        .where(eq(projects.id, id)).run();
      updated++;
    } catch {
      projectId = addProject(db, { name: p.name, rootPath: p.path }).id;
      registered++;
    }
    if (p.hasGit && !db.select().from(repositories).where(eq(repositories.id, id)).get()) {
      addRepo(db, { name: p.name, projectId, path: p.path, language: p.language, framework: p.framework });
    }
    const scope = `project:${projectId}`;
    if (p.language) seedFact(db, scope, 'language', `Language: ${p.language}`);
    if (p.framework) seedFact(db, scope, 'framework', `Framework: ${p.framework}`);
    if (p.packageManager) seedFact(db, scope, 'package-manager', `Package manager: ${p.packageManager}`);
  }
  return { registered, updated, projects: infos.map(i => i.name) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/scanner-db.test.ts tests/scanner.test.ts` — Expected: 6 PASS. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/scanner.ts tests/scanner-db.test.ts
git commit -m "feat: workspace scan registers projects/repos and seeds idempotent knowledge

Goal: GOAL-2026-0002

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Failures service

**Files:**
- Create: `src/services/failures.ts`
- Test: `tests/failures.test.ts`

**Interfaces:**
- Consumes: `failures`, `failureSolutions` tables; `search` (type `'failure'`)
- Produces (from `src/services/failures.js`):
  - `addFailure(db, input: { errorMessage: string; goalId?: string; workUnitId?: string; failureType?: string; context?: string }): Failure`
  - `getFailure(db, id: number): Failure & { solutions: FailureSolution[] }` (throws if missing)
  - `searchFailures(db, query: string, opts?: { limit?: number }): SearchResult[]` — FTS over failures only
  - `resolveFailure(db, id: number): Failure` — sets `resolved: 1`, `resolvedAt`
  - `addSolution(db, failureId: number, input: { solution: string; successful?: boolean }): FailureSolution` — `successful: true` also resolves the failure (§65 loop ends with a working fix)
  - `Failure` / `FailureSolution` = `$inferSelect` of their tables

- [ ] **Step 1: Write failing tests**

`tests/failures.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { addFailure, getFailure, searchFailures, resolveFailure, addSolution } from '../src/services/failures.js';

describe('failures service', () => {
  it('records and retrieves failures with solutions', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'ECONNRESET talking to supabase', failureType: 'network' });
    expect(f.resolved).toBe(0);
    addSolution(db, f.id, { solution: 'Retry with backoff; check Kong gateway', successful: false });
    const full = getFailure(db, f.id);
    expect(full.solutions).toHaveLength(1);
    expect(full.resolved).toBe(0);
  });

  it('a successful solution resolves the failure', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'migration failed: duplicate column' });
    addSolution(db, f.id, { solution: 'Drop the partial migration table and re-run', successful: true });
    const full = getFailure(db, f.id);
    expect(full.resolved).toBe(1);
    expect(full.resolvedAt).toBeTruthy();
  });

  it('failure search hits FTS (§66 reuse loop)', () => {
    const db = createTestDb();
    addFailure(db, { errorMessage: 'ECONNRESET talking to supabase' });
    const hits = searchFailures(db, 'econnreset');
    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe('failure');
  });

  it('resolveFailure works directly and getFailure throws on missing id', () => {
    const db = createTestDb();
    const f = addFailure(db, { errorMessage: 'x' });
    expect(resolveFailure(db, f.id).resolved).toBe(1);
    expect(() => getFailure(db, 999)).toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/failures.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/failures.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { failures, failureSolutions } from '../db/schema.js';
import { search, type SearchResult } from './search.js';

export type Failure = typeof failures.$inferSelect;
export type FailureSolution = typeof failureSolutions.$inferSelect;

const now = () => new Date().toISOString();

export function addFailure(db: BrainDb, input: {
  errorMessage: string; goalId?: string; workUnitId?: string;
  failureType?: string; context?: string;
}): Failure {
  const res = db.insert(failures).values({
    errorMessage: input.errorMessage, goalId: input.goalId ?? null,
    workUnitId: input.workUnitId ?? null, failureType: input.failureType ?? null,
    context: input.context ?? null, createdAt: now(),
  }).run();
  return db.select().from(failures).where(eq(failures.id, Number(res.lastInsertRowid))).get()!;
}

export function getFailure(db: BrainDb, id: number): Failure & { solutions: FailureSolution[] } {
  const f = db.select().from(failures).where(eq(failures.id, id)).get();
  if (!f) throw new Error(`Failure not found: ${id}`);
  const solutions = db.select().from(failureSolutions)
    .where(eq(failureSolutions.failureId, id)).all();
  return { ...f, solutions };
}

export function searchFailures(db: BrainDb, query: string, opts: { limit?: number } = {}): SearchResult[] {
  return search(db, query, { types: ['failure'], limit: opts.limit });
}

export function resolveFailure(db: BrainDb, id: number): Failure {
  getFailure(db, id);
  db.update(failures).set({ resolved: 1, resolvedAt: now() }).where(eq(failures.id, id)).run();
  return db.select().from(failures).where(eq(failures.id, id)).get()!;
}

export function addSolution(db: BrainDb, failureId: number, input: {
  solution: string; successful?: boolean;
}): FailureSolution {
  getFailure(db, failureId);
  const res = db.insert(failureSolutions).values({
    failureId, solution: input.solution,
    successful: input.successful === undefined ? null : input.successful ? 1 : 0,
    createdAt: now(),
  }).run();
  if (input.successful) resolveFailure(db, failureId);
  return db.select().from(failureSolutions)
    .where(eq(failureSolutions.id, Number(res.lastInsertRowid))).get()!;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/failures.test.ts` — Expected: 4 PASS. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/failures.ts tests/failures.test.ts
git commit -m "feat: failure tracking with reusable solutions (§31-32, §66)

Goal: GOAL-2026-0002

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Verification service

**Files:**
- Create: `src/services/verification.ts`
- Test: `tests/verification.test.ts`

**Interfaces:**
- Consumes: `verificationRuns` table; `setRequirementStatus`, `listRequirements` from goals
- Produces (from `src/services/verification.js`):
  - `recordVerification(db, input: { passed: boolean; goalId?: string; workUnitId?: string; requirementId?: number; verificationType?: string; command?: string; expectedResult?: string; actualResult?: string }): VerificationRun` — when `requirementId` is set, the linked requirement moves to `PASSED`/`FAILED` accordingly (makes §64 mechanical)
  - `listVerifications(db, opts?: { goalId?: string }): VerificationRun[]`
  - `goalVerificationState(db, goalId: string): { requirements: (Requirement & { runs: VerificationRun[] })[]; allRequiredPassed: boolean }`
  - `VerificationRun` = `$inferSelect` of `verificationRuns`

- [ ] **Step 1: Write failing tests**

`tests/verification.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal, addRequirement, listRequirements } from '../src/services/goals.js';
import { recordVerification, listVerifications, goalVerificationState } from '../src/services/verification.js';

describe('verification service', () => {
  it('a passing run linked to a requirement marks it PASSED', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'tests pass' });
    recordVerification(db, {
      passed: true, goalId: g.id, requirementId: r.id,
      verificationType: 'unit_test', command: 'npx vitest run', actualResult: 'all green',
    });
    expect(listRequirements(db, g.id)[0].status).toBe('PASSED');
  });

  it('a failing run marks the requirement FAILED', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'build clean' });
    recordVerification(db, { passed: false, goalId: g.id, requirementId: r.id, command: 'npm run build' });
    expect(listRequirements(db, g.id)[0].status).toBe('FAILED');
  });

  it('goalVerificationState aggregates runs per requirement', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    const r1 = addRequirement(db, g.id, { type: 'success_criterion', description: 'a' });
    addRequirement(db, g.id, { type: 'success_criterion', description: 'b' });
    recordVerification(db, { passed: true, goalId: g.id, requirementId: r1.id });
    const state = goalVerificationState(db, g.id);
    expect(state.allRequiredPassed).toBe(false);
    expect(state.requirements.find(x => x.id === r1.id)!.runs).toHaveLength(1);
    expect(listVerifications(db, { goalId: g.id })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/verification.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/verification.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { verificationRuns } from '../db/schema.js';
import { listRequirements, setRequirementStatus, type Requirement } from './goals.js';

export type VerificationRun = typeof verificationRuns.$inferSelect;

const now = () => new Date().toISOString();

export function recordVerification(db: BrainDb, input: {
  passed: boolean; goalId?: string; workUnitId?: string; requirementId?: number;
  verificationType?: string; command?: string; expectedResult?: string; actualResult?: string;
}): VerificationRun {
  const res = db.insert(verificationRuns).values({
    passed: input.passed ? 1 : 0, goalId: input.goalId ?? null,
    workUnitId: input.workUnitId ?? null, requirementId: input.requirementId ?? null,
    verificationType: input.verificationType ?? null, command: input.command ?? null,
    expectedResult: input.expectedResult ?? null, actualResult: input.actualResult ?? null,
    createdAt: now(),
  }).run();
  if (input.requirementId !== undefined) {
    setRequirementStatus(db, input.requirementId, input.passed ? 'PASSED' : 'FAILED');
  }
  return db.select().from(verificationRuns)
    .where(eq(verificationRuns.id, Number(res.lastInsertRowid))).get()!;
}

export function listVerifications(db: BrainDb, opts: { goalId?: string } = {}): VerificationRun[] {
  const q = db.select().from(verificationRuns);
  return opts.goalId ? q.where(eq(verificationRuns.goalId, opts.goalId)).all() : q.all();
}

export function goalVerificationState(db: BrainDb, goalId: string): {
  requirements: (Requirement & { runs: VerificationRun[] })[];
  allRequiredPassed: boolean;
} {
  const runs = listVerifications(db, { goalId });
  const requirements = listRequirements(db, goalId).map(r => ({
    ...r, runs: runs.filter(v => v.requirementId === r.id),
  }));
  const allRequiredPassed = requirements
    .filter(r => r.requirementType === 'success_criterion' && r.priority === 'required')
    .every(r => ['PASSED', 'NOT_APPLICABLE'].includes(r.status));
  return { requirements, allRequiredPassed };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/verification.test.ts` — Expected: 3 PASS. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/verification.ts tests/verification.test.ts
git commit -m "feat: verification runs drive requirement status (§35, §64)

Goal: GOAL-2026-0002

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Resume service

**Files:**
- Create: `src/services/resume.ts`
- Test: `tests/resume.test.ts`

**Interfaces:**
- Consumes: goals (`getGoal`, `listRequirements`), work (`listWorkUnits`, `readyWorkUnits`), decisions (`listDecisions`), `failures` table, `goalVerificationState`
- Produces (from `src/services/resume.js`):
  - `interface ResumeState { goal: Goal; contract: unknown | null; completedWork: WorkUnit[]; pendingWork: WorkUnit[]; readyWork: WorkUnit[]; decisions: Decision[]; unresolvedFailures: Failure[]; requirements: Requirement[]; nextRecommendedAction: string }`
  - `resumeGoal(db, id: string): ResumeState` — `contract` = parsed `contractSnapshot` (null when unlocked); `nextRecommendedAction` rules:
    - status DRAFT → `"Clarify requirements and lock the goal contract"`
    - status LOCKED → `"Start the goal (brain goal start <id>)"`
    - status BLOCKED → `"Resolve the blocker (see latest observation), then restart"`
    - COMPLETED/FAILED/CANCELLED → `"Goal is <status>; nothing to resume"`
    - EXECUTING/PLANNING/VERIFYING: ready work → `"Work on <first ready id>: <title>"`; no pending work and all required criteria passed → `"All criteria passed — complete the goal"`; no pending work, criteria unmet → `"Verify remaining success criteria"`; pending but none ready → `"No ready work: resolve dependencies or blocked work units"`

- [ ] **Step 1: Write failing tests**

`tests/resume.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { createGoal, addRequirement, lockGoal, startGoal } from '../src/services/goals.js';
import { createWorkUnit, updateWorkUnit } from '../src/services/work.js';
import { addFailure } from '../src/services/failures.js';
import { recordVerification } from '../src/services/verification.js';
import { resumeGoal } from '../src/services/resume.js';

describe('goal resume (§72)', () => {
  it('assembles full state and points at the next ready work unit', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Ship feature', objective: 'o' });
    const r = addRequirement(db, g.id, { type: 'success_criterion', description: 'works' });
    lockGoal(db, g.id);
    startGoal(db, g.id);
    const a = createWorkUnit(db, { goalId: g.id, title: 'Backend' });
    const b = createWorkUnit(db, { goalId: g.id, title: 'Frontend', dependsOn: [a.id] });
    updateWorkUnit(db, a.id, { status: 'COMPLETED' });
    addFailure(db, { errorMessage: 'flaky test', goalId: g.id });
    const state = resumeGoal(db, g.id);
    expect(state.contract).not.toBeNull();
    expect(state.completedWork.map(w => w.id)).toEqual([a.id]);
    expect(state.readyWork.map(w => w.id)).toEqual([b.id]);
    expect(state.unresolvedFailures).toHaveLength(1);
    expect(state.nextRecommendedAction).toBe(`Work on ${b.id}: Frontend`);
    // finish everything: recommendation flips to completion
    updateWorkUnit(db, b.id, { status: 'COMPLETED' });
    recordVerification(db, { passed: true, goalId: g.id, requirementId: r.id });
    expect(resumeGoal(db, g.id).nextRecommendedAction).toBe('All criteria passed — complete the goal');
  });

  it('gives lifecycle-appropriate recommendations', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 'Draft goal', objective: 'o' });
    expect(resumeGoal(db, g.id).nextRecommendedAction).toMatch(/lock the goal contract/i);
    lockGoal(db, g.id);
    expect(resumeGoal(db, g.id).nextRecommendedAction).toMatch(/start the goal/i);
    expect(resumeGoal(db, g.id).contract).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/resume.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/resume.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { failures } from '../db/schema.js';
import { getGoal, listRequirements, type Goal, type Requirement } from './goals.js';
import { listDecisions, type Decision } from './decisions.js';
import { listWorkUnits, readyWorkUnits, type WorkUnit } from './work.js';
import { goalVerificationState } from './verification.js';
import type { Failure } from './failures.js';

export interface ResumeState {
  goal: Goal;
  contract: unknown | null;
  completedWork: WorkUnit[];
  pendingWork: WorkUnit[];
  readyWork: WorkUnit[];
  decisions: Decision[];
  unresolvedFailures: Failure[];
  requirements: Requirement[];
  nextRecommendedAction: string;
}

function recommend(goal: Goal, ready: WorkUnit[], pending: WorkUnit[], allPassed: boolean): string {
  switch (goal.status) {
    case 'DRAFT': return 'Clarify requirements and lock the goal contract';
    case 'LOCKED': return `Start the goal (brain goal start ${goal.id})`;
    case 'BLOCKED': return 'Resolve the blocker (see latest observation), then restart';
    case 'COMPLETED':
    case 'FAILED':
    case 'CANCELLED': return `Goal is ${goal.status}; nothing to resume`;
    default: {
      if (ready.length > 0) return `Work on ${ready[0].id}: ${ready[0].title}`;
      if (pending.length === 0 && allPassed) return 'All criteria passed — complete the goal';
      if (pending.length === 0) return 'Verify remaining success criteria';
      return 'No ready work: resolve dependencies or blocked work units';
    }
  }
}

export function resumeGoal(db: BrainDb, id: string): ResumeState {
  const goal = getGoal(db, id);
  const all = listWorkUnits(db, id);
  const completedWork = all.filter(w => ['COMPLETED', 'SKIPPED'].includes(w.status));
  const pendingWork = all.filter(w => !['COMPLETED', 'SKIPPED'].includes(w.status));
  const readyWork = readyWorkUnits(db, id);
  const unresolvedFailures = db.select().from(failures)
    .where(and(eq(failures.goalId, id), eq(failures.resolved, 0))).all();
  const { allRequiredPassed } = goalVerificationState(db, id);
  return {
    goal,
    contract: goal.contractSnapshot ? JSON.parse(goal.contractSnapshot) : null,
    completedWork,
    pendingWork,
    readyWork,
    decisions: listDecisions(db, { goalId: id }),
    unresolvedFailures,
    requirements: listRequirements(db, id),
    nextRecommendedAction: recommend(goal, readyWork, pendingWork, allRequiredPassed),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/resume.test.ts` — Expected: 2 PASS. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/resume.ts tests/resume.test.ts
git commit -m "feat: goal resume with next-action recommendation (§72)

Goal: GOAL-2026-0002

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: CLI wiring

**Files:**
- Modify: `src/cli/index.ts`
- Test: extend `tests/cli.test.ts`

**Interfaces:**
- Consumes: all four new services
- Produces CLI commands: `project scan <dir>`, `failure add <errorMessage>` (`-g/--goal`, `--type`, `--context`), `failure search <q>`, `failure show <id>`, `failure resolve <id>`, `failure solution <failureId> <solution>` (`--successful`), `verify add` (`--goal`, `--requirement <id>`, `--type`, `--command`, `--expected`, `--actual`, `--passed`/`--failed` — exactly one required), `verify goal <goalId>`, `goal resume <id>` — all printing pretty JSON via the existing `out()`/`run()` helpers.

- [ ] **Step 1: Add the commands**

In `src/cli/index.ts`, add imports after the existing service imports:

```ts
import { scanProjects } from '../services/scanner.js';
import * as fail from '../services/failures.js';
import { recordVerification, goalVerificationState } from '../services/verification.js';
import { resumeGoal } from '../services/resume.js';
```

Add to the existing `proj` command group (after `proj.command('show ...')`):

```ts
proj.command('scan <dir>').description('Discover and register projects under a directory (§54)')
  .action((dir) => run(() => out(scanProjects(db(), dir))));
```

Add to the existing `goal` command group (after `goal.command('complete ...')`):

```ts
goal.command('resume <id>').description('Full resume state + next recommended action (§72)')
  .action((id) => run(() => out(resumeGoal(db(), id))));
```

Add new top-level groups before `// ---- model routing ----`:

```ts
// ---- failures ----
const failCmd = program.command('failure');
failCmd.command('add <errorMessage>').option('-g, --goal <goalId>')
  .option('--type <failureType>').option('--context <text>').option('--work-unit <id>')
  .action((errorMessage, o) => run(() => out(fail.addFailure(db(), {
    errorMessage, goalId: o.goal, failureType: o.type, context: o.context, workUnitId: o.workUnit,
  }))));
failCmd.command('search <query>').option('-n, --limit <n>')
  .action((query, o) => run(() => out(fail.searchFailures(db(), query, {
    limit: o.limit ? Number(o.limit) : undefined,
  }))));
failCmd.command('show <id>').action((id) => run(() => out(fail.getFailure(db(), Number(id)))));
failCmd.command('resolve <id>').action((id) => run(() => out(fail.resolveFailure(db(), Number(id)))));
failCmd.command('solution <failureId> <solution>').option('--successful')
  .action((failureId, solution, o) => run(() => out(fail.addSolution(db(), Number(failureId), {
    solution, successful: o.successful,
  }))));

// ---- verification ----
const verifyCmd = program.command('verify');
verifyCmd.command('add').requiredOption('-g, --goal <goalId>')
  .option('-r, --requirement <id>').option('--type <verificationType>')
  .option('--command <cmd>').option('--expected <text>').option('--actual <text>')
  .option('--passed').option('--failed')
  .action((o) => run(() => {
    if (o.passed === o.failed) throw new Error('Specify exactly one of --passed or --failed');
    out(recordVerification(db(), {
      passed: Boolean(o.passed), goalId: o.goal,
      requirementId: o.requirement ? Number(o.requirement) : undefined,
      verificationType: o.type, command: o.command,
      expectedResult: o.expected, actualResult: o.actual,
    }));
  }));
verifyCmd.command('goal <goalId>').action((goalId) => run(() => out(goalVerificationState(db(), goalId))));
```

(Note: `o.passed === o.failed` is true when both are undefined or both set — the guard covers both misuses.)

- [ ] **Step 2: Extend the e2e test**

Append to the describe block in `tests/cli.test.ts` (vitest 4 options-second-arg style, matching the file's existing tests):

```ts
  it('phase 2: scan, failure loop, verification, resume', { timeout: 120000 }, () => {
    // scan a fixture workspace
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-e2e-scan-'));
    fs.mkdirSync(path.join(ws, 'demo-api', '.git'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'demo-api', 'package.json'),
      JSON.stringify({ name: 'demo-api', dependencies: { express: '^4.0.0' } }));
    const scan = brain('project', 'scan', ws);
    expect(scan.registered).toBe(1);

    // failure loop
    const g = brain('goal', 'create', 'Phase2 e2e goal');
    const f = brain('failure', 'add', 'ETIMEDOUT calling qdrant', '-g', g.id, '--type', 'network');
    brain('failure', 'solution', String(f.id), 'increase timeout to 30s', '--successful');
    expect(brain('failure', 'show', String(f.id)).resolved).toBe(1);
    expect(brain('failure', 'search', 'etimedout').length).toBe(1);

    // verification drives requirement status; resume recommends completion
    const r = brain('goal', 'requirement', 'add', g.id, 'e2e criterion');
    brain('goal', 'lock', g.id);
    brain('goal', 'start', g.id);
    brain('verify', 'add', '-g', g.id, '-r', String(r.id), '--passed', '--command', 'true');
    const state = brain('goal', 'resume', g.id);
    expect(state.requirements[0].status).toBe('PASSED');
    expect(state.nextRecommendedAction).toBe('All criteria passed — complete the goal');
  });
```

(`fs`, `os`, `path` are already imported in this test file.)

- [ ] **Step 3: Run the new test, then the full suite**

Run: `npx vitest run tests/cli.test.ts` — Expected: 3 PASS. Then `npx vitest run` — all green; `npx tsc --noEmit` — clean.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts tests/cli.test.ts
git commit -m "feat: CLI for scan, failures, verification, resume

Goal: GOAL-2026-0002

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: MCP wiring

**Files:**
- Modify: `src/mcp/server.ts`
- Test: extend `tests/mcp.test.ts`

**Interfaces:**
- Consumes: the four new services
- Produces 8 new MCP tools (40 total), registered via the existing `tool()` helper before `return server;`:

- [ ] **Step 1: Add the tools**

Imports (add after existing service imports in `src/mcp/server.ts`):

```ts
import { scanProjects } from '../services/scanner.js';
import * as fail from '../services/failures.js';
import { goalVerificationState, recordVerification } from '../services/verification.js';
import { resumeGoal } from '../services/resume.js';
```

Tools (insert before `return server;`):

```ts
  // phase 2: scanner, failures, verification, resume
  tool('brain_project_scan', 'Discover and register projects under a directory (§54)', {
    dir: z.string(),
  }, (a) => scanProjects(db, a.dir));
  tool('brain_failure_record', 'Record a failure (§31)', {
    errorMessage: z.string(), goalId: z.string().optional(), workUnitId: z.string().optional(),
    failureType: z.string().optional(), context: z.string().optional(),
  }, (a) => fail.addFailure(db, a));
  tool('brain_failure_search', 'Have I seen this error before? FTS over failures (§66)', {
    query: z.string(), limit: z.number().optional(),
  }, (a) => fail.searchFailures(db, a.query, a));
  tool('brain_failure_resolve', 'Mark a failure resolved', { id: z.number() },
    (a) => fail.resolveFailure(db, a.id));
  tool('brain_failure_solution_add', 'Attach a solution to a failure; successful:true also resolves it', {
    failureId: z.number(), solution: z.string(), successful: z.boolean().optional(),
  }, (a) => fail.addSolution(db, a.failureId, a));
  tool('brain_verification_record', 'Record a verification run; linked requirement moves to PASSED/FAILED (§35)', {
    passed: z.boolean(), goalId: z.string().optional(), workUnitId: z.string().optional(),
    requirementId: z.number().optional(), verificationType: z.string().optional(),
    command: z.string().optional(), expectedResult: z.string().optional(),
    actualResult: z.string().optional(),
  }, (a) => recordVerification(db, a));
  tool('brain_verification_state', 'Requirements with their verification runs for a goal', {
    goalId: z.string(),
  }, (a) => goalVerificationState(db, a.goalId));
  tool('brain_goal_resume', 'Full resume state + next recommended action (§72)', {
    id: z.string(),
  }, (a) => resumeGoal(db, a.id));
```

- [ ] **Step 2: Extend the tests**

In `tests/mcp.test.ts`: add `'brain_project_scan', 'brain_failure_search', 'brain_goal_resume'` to the tool-surface array, and append one behavior test to the describe block:

```ts
  it('records failures and resumes goals via tools', async () => {
    const client = await connect();
    const g = text(await client.callTool({
      name: 'brain_goal_create', arguments: { title: 'T', objective: 'O' },
    }));
    await client.callTool({
      name: 'brain_failure_record',
      arguments: { errorMessage: 'EADDRINUSE port 8020', goalId: g.id },
    });
    const hits = text(await client.callTool({
      name: 'brain_failure_search', arguments: { query: 'eaddrinuse' },
    }));
    expect(hits).toHaveLength(1);
    const state = text(await client.callTool({ name: 'brain_goal_resume', arguments: { id: g.id } }));
    expect(state.unresolvedFailures).toHaveLength(1);
    expect(state.nextRecommendedAction).toMatch(/lock the goal contract/i);
  });
```

- [ ] **Step 3: Run tests, full suite, build**

Run: `npx vitest run tests/mcp.test.ts` — Expected: 4 PASS. `npx vitest run` — all green. `npx tsc --noEmit` — clean. `npm run build` (the live MCP registration points at dist/).

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.ts tests/mcp.test.ts
git commit -m "feat: MCP tools for scan, failures, verification, resume

Goal: GOAL-2026-0002

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Live scan, dogfooded verification, completion

**Files:**
- Modify: `README.md` (add Phase 2 commands)
- No src changes — this task runs the system for real.

**Interfaces:**
- Consumes: everything; the real DB at `~/.central-brain/brain.db` (GOAL-2026-0002 exists there, DRAFT, 6 requirements)

- [ ] **Step 1: Rebuild and lock the goal**

```bash
npm run build
node dist/cli/index.js goal lock GOAL-2026-0002
node dist/cli/index.js goal start GOAL-2026-0002
```

- [ ] **Step 2: Scan the real workspace**

```bash
node dist/cli/index.js project scan $HOME/Projects | tail -20
node dist/cli/index.js project list | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('projects:',JSON.parse(s).length))"
```

Expected: ~15–25 projects registered (including nested ones like `selfhosting-echo-app`), each with scan-seeded knowledge. Run the scan **twice** and confirm the second run reports `registered: 0` (idempotency in production).

- [ ] **Step 3: Verify each success criterion via the new verification path (dogfood §35)**

Get requirement ids via `node dist/cli/index.js goal show GOAL-2026-0002`, then for each (values from the actual runs — never record a verification you didn't perform; if one fails, fix before proceeding):

```bash
B="node dist/cli/index.js"
$B verify add -g GOAL-2026-0002 -r <id1> --type e2e --command "vitest scanner suites" --actual "scanner detects+registers with metadata" --passed
$B verify add -g GOAL-2026-0002 -r <id2> --type manual --command "brain project scan ~/Projects" --actual "<N> projects registered, rescan idempotent" --passed
$B verify add -g GOAL-2026-0002 -r <id3> --type e2e --command "failure loop in cli+mcp tests" --actual "add/search/resolve/solution green" --passed
$B verify add -g GOAL-2026-0002 -r <id4> --type unit_test --command "npx vitest run tests/verification.test.ts" --actual "requirement status driven by runs" --passed
$B verify add -g GOAL-2026-0002 -r <id5> --type e2e --command "brain goal resume" --actual "contract+work+failures+next action returned" --passed
$B verify add -g GOAL-2026-0002 -r <id6> --type suite --command "npx vitest run" --actual "all green; no semantic search code present" --passed
```

- [ ] **Step 4: Complete via the mechanical path and back up**

```bash
$B verify goal GOAL-2026-0002   # expect allRequiredPassed: true
$B goal complete GOAL-2026-0002
$B backup
$B learning add "Workspace scan is idempotent; re-run brain project scan ~/Projects after adding projects" -s GLOBAL
```

- [ ] **Step 5: Update README and commit**

Append to the command list in `README.md`:

```markdown
- Scan: `brain project scan ~/Projects` (re-run anytime; idempotent)
- Failures: `brain failure add|search|show|resolve|solution` (the §66 reuse loop)
- Verification: `brain verify add|goal` (passing runs drive requirement status)
- Resume: `brain goal resume GOAL-…` (contract, work state, next action)
```

```bash
git add README.md
git commit -m "docs: phase 2 command surface

Goal: GOAL-2026-0002

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification (whole-phase)

- `npx vitest run` all green; `npx tsc --noEmit` clean
- Real `~/Projects` scan populated the Brain; second scan idempotent
- GOAL-2026-0002 COMPLETED through the verification path (not `--force`)
- `brain goal resume GOAL-2026-0001` returns sensible state for a completed goal
- Backup exists post-completion

## Spec coverage note

§78 also lists "automatic context resolution" — already delivered by Milestone 1 (budgeted context engine + SessionStart hook injection, §37.1/§52.1). No further work required this phase; `goal resume` (Task 5) is the remaining resolution surface §78 adds.

## Out of scope (later phases)

- Semantic/hybrid search, claude-mem import (Phase 3)
- AST/file/symbol indexing (§56–58), scheduled/auto re-scans, goal intake automation (Phases 4+)

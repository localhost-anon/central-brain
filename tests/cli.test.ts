import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cli-'));
const env = { ...process.env, BRAIN_DB: path.join(tmp, 'brain.db') };

function brain(...args: string[]): any {
  const stdout = execFileSync('npx', ['tsx', 'src/cli/index.ts', ...args], { env, encoding: 'utf8' });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

describe('brain CLI end-to-end', () => {
  beforeAll(() => { brain('init'); });

  it('runs the §89 initial-deliverable flow', { timeout: 120000 }, () => {
    const p = brain('project', 'add', 'central-brain', '--path', process.cwd());
    expect(p.id).toBe('central-brain');

    const g = brain('goal', 'create', 'Implement project scanning', '-o', 'Brain can scan ~/Projects');
    expect(g.status).toBe('DRAFT');

    const r = brain('goal', 'requirement', 'add', g.id, 'scanner detects package.json projects', '--verify', 'test');
    brain('goal', 'requirement', 'add', g.id, 'test scope', '-t', 'scope');
    brain('goal', 'set', g.id, '--risk', 'LOW');
    brain('goal', 'lock', g.id);
    const wu = brain('work', 'create', g.id, 'Write scanner', '--serves', String(r.id));
    brain('goal', 'start', g.id);

    expect(wu.id).toMatch(/^WU-/);

    brain('decision', 'add', 'Use fast-glob for scanning', '-g', g.id, '-r', 'simplest');
    brain('knowledge', 'add', 'Projects live under ~/Projects', '-s', 'GLOBAL');
    brain('learning', 'add', 'Scanning node_modules wastes minutes; always exclude it');

    const ctx = brain('context', 'get', '-g', g.id);
    expect(ctx.goal.id).toBe(g.id);
    expect(ctx.requirements.length).toBe(2);
    expect(ctx.knowledge.length).toBeGreaterThan(0);

    const hits = brain('knowledge', 'search', 'projects');
    expect(hits.length).toBeGreaterThan(0);

    const rec = brain('model', 'recommend', '-c', 'trivial');
    expect(rec.model).toBe('haiku');

    brain('work', 'update', wu.id, '--status', 'COMPLETED');
    brain('goal', 'requirement', 'status', String(r.id), 'PASSED');
    const done = brain('goal', 'complete', g.id);
    expect(done.status).toBe('COMPLETED');
  });

  it('fails loudly when completing with unmet criteria', { timeout: 120000 }, () => {
    const g = brain('goal', 'create', 'Another goal');
    brain('goal', 'requirement', 'add', g.id, 'never verified', '--verify', 'test');
    brain('goal', 'requirement', 'add', g.id, 'test scope', '-t', 'scope');
    brain('goal', 'set', g.id, '--risk', 'LOW');
    brain('goal', 'lock', g.id);
    expect(() => brain('goal', 'complete', g.id)).toThrow();
  });

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
    const r = brain('goal', 'requirement', 'add', g.id, 'e2e criterion', '--verify', 'test');
    brain('goal', 'requirement', 'add', g.id, 'test scope', '-t', 'scope');
    brain('goal', 'set', g.id, '--risk', 'LOW');
    brain('goal', 'lock', g.id);
    const w2 = brain('work', 'create', g.id, 'Do e2e', '--serves', String(r.id));
    brain('goal', 'start', g.id);
    brain('work', 'update', w2.id, '--status', 'COMPLETED');
    brain('verify', 'add', '-g', g.id, '-r', String(r.id), '--passed', '--command', 'true');
    const state = brain('goal', 'resume', g.id);
    expect(state.requirements[0].status).toBe('PASSED');
    expect(state.nextRecommendedAction).toBe('All criteria passed — complete the goal');
  });

  it('phase 3: import + reindex + hybrid search e2e', { timeout: 300000 }, () => {
    const src = path.join(tmp, 'claude-mem.db');
    const s = new Database(src);
    s.exec(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY, project TEXT, type TEXT, title TEXT, text TEXT,
      created_at TEXT, created_at_epoch INTEGER)`);
    s.prepare('INSERT INTO observations (id, project, type, title, text, created_at_epoch) VALUES (?,?,?,?,?,?)')
      .run(1, 'central-brain', 'decision', 'Chose SQLite', 'zero infrastructure wins', 1756500000000);
    s.close();
    expect(brain('import', 'claude-mem', src).imported).toBe(1);
    expect(brain('import', 'claude-mem', src).imported).toBe(0); // idempotent

    brain('knowledge', 'add', 'TrueNAS box runs Seafile document sync service', '-s', 'GLOBAL');
    const re = brain('embed', 'reindex');
    expect(re.embedded).toBeGreaterThan(0);
    const hits = brain('knowledge', 'search', 'network storage appliance for syncing files');
    expect(hits.some((h: any) => h.text.includes('Seafile'))).toBe(true);
  });
  it('phase 4: intake → answer batch → lock e2e', { timeout: 300000 }, () => {
    const g = brain('goal', 'create', 'Add SSO', '-o', 'Users sign in with Microsoft');
    const r1 = brain('goal', 'intake', g.id);
    expect(r1.ready).toBe(false);
    expect(r1.openQuestions).toHaveLength(5);
    expect(() => brain('goal', 'lock', g.id)).toThrow();
    const qs = brain('goal', 'question', 'list', g.id, '--open');
    const byKey = (k: string) => qs.find((q: any) => q.checkKey === k).id;
    brain('goal', 'question', 'answer', String(byKey('missing:scope')), 'auth service and login UI', '--as', 'scope');
    brain('goal', 'question', 'answer', String(byKey('missing:success_criterion')), 'Microsoft login works end to end', '--as', 'success_criterion', '--verify', 'test');
    brain('goal', 'question', 'answer', String(byKey('missing:risk_level')), 'HIGH');
    brain('goal', 'question', 'answer', String(byKey('review:behaviour')), 'User chose: existing password users are migrated on next login', '--as', 'constraint');
    brain('goal', 'question', 'answer', String(byKey('review:coverage')), 'n/a: all categories — e2e test');
    brain('goal', 'set', g.id, '--risk', 'HIGH');
    const extra = brain('goal', 'question', 'add', g.id, 'Keep password login?');
    brain('goal', 'question', 'dismiss', String(extra.id), 'covered by existing policy');
    const r2 = brain('goal', 'intake', g.id);
    expect(r2.ready).toBe(true);
    expect(r2.nextAction).toBe('ready to lock');
    const locked = brain('goal', 'lock', g.id);
    expect(locked.status).toBe('LOCKED');
    expect(JSON.parse(locked.contractSnapshot).answeredQuestions.length).toBeGreaterThanOrEqual(3);
  });
});

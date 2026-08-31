import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
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

    const r = brain('goal', 'requirement', 'add', g.id, 'scanner detects package.json projects');
    brain('goal', 'lock', g.id);
    brain('goal', 'start', g.id);

    const wu = brain('work', 'create', g.id, 'Write scanner');
    expect(wu.id).toMatch(/^WU-/);

    brain('decision', 'add', 'Use fast-glob for scanning', '-g', g.id, '-r', 'simplest');
    brain('knowledge', 'add', 'Projects live under ~/Projects', '-s', 'GLOBAL');
    brain('learning', 'add', 'Scanning node_modules wastes minutes; always exclude it');

    const ctx = brain('context', 'get', '-g', g.id);
    expect(ctx.goal.id).toBe(g.id);
    expect(ctx.requirements.length).toBe(1);
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
    brain('goal', 'requirement', 'add', g.id, 'never verified');
    brain('goal', 'lock', g.id);
    expect(() => brain('goal', 'complete', g.id)).toThrow();
  });
});

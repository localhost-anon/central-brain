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

  it('slug collisions are skipped loudly and the scan continues', () => {
    const db = createTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-scandb-'));
    for (const rel of ['a/b-c', 'a-b/c']) {
      const d = path.join(root, rel);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), '{}');
    }
    const res = scanProjects(db, root);
    expect(res.registered).toBe(1);
    expect(res.collisions).toHaveLength(1);
    expect(res.errors).toHaveLength(0);
    expect(listProjects(db)).toHaveLength(1);
  });

  it('reports registered projects whose directory vanished', () => {
    const db = createTestDb();
    const root = makeWorkspace();
    scanProjects(db, root);
    fs.rmSync(path.join(root, 'my-app'), { recursive: true, force: true });
    const res = scanProjects(db, root);
    expect(res.missing).toHaveLength(1);
    expect(res.missing[0]).toContain('my-app');
  });
});

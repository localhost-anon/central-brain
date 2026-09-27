import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers.js';
import { importClaudeMem } from '../src/services/import-claude-mem.js';
import { addProject } from '../src/services/projects.js';
import { observations } from '../src/db/schema.js';

function makeSourceDb(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cmimport-')), 'claude-mem.db');
  const s = new Database(p);
  s.exec(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY, project TEXT, type TEXT, title TEXT, text TEXT,
    created_at TEXT, created_at_epoch INTEGER)`);
  const ins = s.prepare('INSERT INTO observations (id, project, type, title, text, created_at_epoch) VALUES (?,?,?,?,?,?)');
  ins.run(1, 'central-brain', 'decision', 'Chose SQLite', 'zero infrastructure wins', 1756500000000);
  ins.run(2, 'unknown-proj', 'bugfix', 'Fixed timezone bug', 'UTC conversion at boundary', 1756500001000);
  ins.run(3, 'central-brain', 'discovery', null, 'FTS5 supports external content tables', 1756500002000);
  s.close();
  return p;
}

/** Source shaped like the live claude-mem schema: content lives in `narrative`, `text` is empty. */
function makeNarrativeSourceDb(rows: Array<[number, string, string | null, string]>): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cmimport-')), 'claude-mem.db');
  const s = new Database(p);
  s.exec(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY, project TEXT, type TEXT, title TEXT, subtitle TEXT,
    narrative TEXT, text TEXT, facts TEXT, created_at TEXT, created_at_epoch INTEGER)`);
  const ins = s.prepare(`INSERT INTO observations (id, project, type, title, narrative, text, created_at_epoch)
    VALUES (?,?,?,?,?,'',?)`);
  for (const [id, project, title, narrative] of rows) ins.run(id, project, 'discovery', title, narrative, 1756500000000 + id);
  s.close();
  return p;
}

describe('claude-mem import', () => {
  it('imports with project scoping and source refs; re-run is idempotent', () => {
    const db = createTestDb();
    addProject(db, { name: 'central-brain' });
    const src = makeSourceDb();
    const r1 = importClaudeMem(db, src);
    expect(r1).toEqual({ imported: 3, skipped: 0, projectScoped: 2 });
    const rows = db.select().from(observations).all();
    expect(rows).toHaveLength(3);
    const scoped = rows.filter(r => r.scopeId === 'project:central-brain');
    expect(scoped).toHaveLength(2);
    expect(rows.every(r => r.sourceRef?.startsWith('claude-mem:'))).toBe(true);
    expect(rows.find(r => r.sourceRef === 'claude-mem:1')!.observation).toBe('Chose SQLite: zero infrastructure wins');
    expect(rows.find(r => r.sourceRef === 'claude-mem:3')!.observation).toBe('FTS5 supports external content tables');
    const r2 = importClaudeMem(db, src);
    expect(r2).toEqual({ imported: 0, skipped: 3, projectScoped: 0 });
    expect(db.select().from(observations).all()).toHaveLength(3);
  });

  it('throws when the source db does not exist', () => {
    const db = createTestDb();
    expect(() => importClaudeMem(db, '/nonexistent/claude-mem.db')).toThrow();
  });

  it('uses narrative as the body when the source has a narrative column and text is empty', () => {
    const db = createTestDb();
    const src = makeNarrativeSourceDb([[7, 'whatever', 'Title here', 'The narrative body']]);
    const r = importClaudeMem(db, src);
    expect(r).toEqual({ imported: 1, skipped: 0, projectScoped: 0 });
    const row = db.select().from(observations).all()[0]!;
    expect(row.observation).toBe('Title here: The narrative body');
    expect(row.confidence).toBe(0.6);
    expect(row.scopeType).toBe('GLOBAL');
    expect(row.scopeId).toBeNull();
    expect(row.createdAt).toBe(new Date(1756500000007).toISOString());
  });

  it('scopes a bare claude-mem project name to a registered project by last path segment', () => {
    const db = createTestDb();
    const p = addProject(db, { name: 'AI_TOOLS/OpenAlice' });
    expect(p.id).toBe('ai-tools-openalice');
    const src = makeNarrativeSourceDb([[1, 'OpenAlice', 'T', 'N']]);
    const r = importClaudeMem(db, src);
    expect(r.projectScoped).toBe(1);
    const row = db.select().from(observations).all()[0]!;
    expect(row.scopeType).toBe('PROJECT');
    expect(row.scopeId).toBe('project:ai-tools-openalice');
  });

  it('scopes by rootPath basename when the name does not match', () => {
    const db = createTestDb();
    addProject(db, { name: 'Some Label', rootPath: '/Users/x/Projects/Kronos' });
    const src = makeNarrativeSourceDb([[1, 'Kronos', 'T', 'N']]);
    importClaudeMem(db, src);
    expect(db.select().from(observations).all()[0]!.scopeId).toBe('project:some-label');
  });

  it('falls back to GLOBAL when the last segment is ambiguous across projects', () => {
    const db = createTestDb();
    addProject(db, { name: 'AI_TOOLS/dograh' });
    addProject(db, { name: 'Selfhosting/dograh' });
    const src = makeNarrativeSourceDb([[1, 'dograh', 'T', 'N']]);
    const r = importClaudeMem(db, src);
    expect(r.projectScoped).toBe(0);
    const row = db.select().from(observations).all()[0]!;
    expect(row.scopeType).toBe('GLOBAL');
    expect(row.scopeId).toBeNull();
  });
});

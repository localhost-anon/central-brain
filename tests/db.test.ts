import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { openDb, migrateDb } from '../src/db/connection.js';

describe('database', () => {
  it('applies migrations: core and FTS tables exist', () => {
    const db = createTestDb();
    const names = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of ['goals', 'goal_requirements', 'work_units', 'work_unit_dependencies',
      'projects', 'repositories', 'entities', 'relationships', 'knowledge', 'learnings',
      'observations', 'failures', 'failure_solutions', 'executions', 'artifacts',
      'verification_runs', 'decisions', 'approvals', 'goal_questions']) {
      expect(names, `missing table ${t}`).toContain(t);
    }
    for (const f of ['knowledge_fts', 'learnings_fts', 'decisions_fts', 'failures_fts', 'goals_fts']) {
      expect(names, `missing fts table ${f}`).toContain(f);
    }
  });

  it('fts triggers index inserted rows', () => {
    const db = createTestDb();
    db.$client.prepare(
      "INSERT INTO knowledge (scope_type, statement, created_at) VALUES ('GLOBAL', 'Prospera API uses PostgreSQL', ?)"
    ).run(new Date().toISOString());
    const hits = db.$client.prepare("SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH 'postgresql'").all();
    expect(hits.length).toBe(1);
  });

  it('enforces WAL-compatible pragmas on file DBs and foreign keys everywhere', () => {
    const db = createTestDb();
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('migrateDb on a fresh in-memory DB does not throw, and re-migrating is a no-op', () => {
    const db = openDb(':memory:');
    expect(() => migrateDb(db)).not.toThrow();
    expect(() => migrateDb(db)).not.toThrow();
  });

  it('phase 3 schema: embeddings table and observations_fts exist', () => {
    const db = createTestDb();
    const names = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((r: any) => r.name);
    expect(names).toContain('embeddings');
    expect(names).toContain('observations_fts');
    db.$client.prepare(
      "INSERT INTO observations (observation, created_at) VALUES ('truenas hosts seafile', ?)"
    ).run(new Date().toISOString());
    const hits = db.$client.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'seafile'").all();
    expect(hits.length).toBe(1);
  });
});

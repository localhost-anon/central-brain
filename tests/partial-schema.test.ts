import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDb, migrateDb, pendingMigrations, packageRoot, snapshotDir, SCHEMA_NOTICE } from '../src/db/connection.js';
import { getContext } from '../src/services/context.js';

/** Build a file-backed DB with only migrations 0000..0004 applied (the real pre-0005 schema). */
function preUpgradeDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-partial-'));
  const folder = path.join(dir, 'drizzle');
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
  const src = path.join(packageRoot(), 'drizzle');
  const journal = JSON.parse(fs.readFileSync(path.join(src, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 4);
  for (const e of journal.entries) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
  fs.writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const dbPath = path.join(dir, 'brain.db');
  const db = openDb(dbPath);
  migrate(db, { migrationsFolder: folder });
  db.$client.prepare("INSERT INTO goals (id, title, objective, status, created_at, updated_at) VALUES ('GOAL-2026-0001','t','o','EXECUTING',datetime('now'),datetime('now'))").run();
  db.$client.close();
  return { dir, dbPath };
}

describe('pre-0005 schema (C1)', () => {
  it('getContext returns the schema notice instead of throwing', () => {
    const { dbPath } = preUpgradeDb();
    const db = openDb(dbPath);
    expect(pendingMigrations(db)).toBe(1);
    const ctx = getContext(db) as any;
    expect(ctx.schemaPending).toBe(true);
    expect(ctx.notice).toBe(SCHEMA_NOTICE);
    db.$client.close();
  });

  it('`context get` CLI returns the notice and leaves the DB unmigrated', { timeout: 60000 }, () => {
    const { dbPath } = preUpgradeDb();
    const out = JSON.parse(execFileSync('npx', ['tsx', 'src/cli/index.ts', 'context', 'get', '--current'],
      { env: { ...process.env, BRAIN_DB: dbPath }, encoding: 'utf8' }));
    expect(out.schemaPending).toBe(true);
    expect(out.notice).toMatch(/brain migrate/);
    expect(pendingMigrations(openDb(dbPath))).toBe(1);
  });
});

describe('pending migrations by hash (C2)', () => {
  it('a foreign applied row does not mask an unapplied journal entry; migrateDb snapshots first', () => {
    const { dbPath } = preUpgradeDb();
    const db = openDb(dbPath);
    // A migration from an unmerged branch: applied, but not in our journal. Timestamp before 0005.
    db.$client.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('f0reign', 1790541302429)").run();
    expect(pendingMigrations(db)).toBe(1);
    const backups = snapshotDir(db);
    expect(fs.existsSync(backups)).toBe(false);
    migrateDb(db);
    expect(fs.readdirSync(backups).filter(f => f.endsWith('.db'))).toHaveLength(1);
    expect(pendingMigrations(db)).toBe(0);
    db.$client.close();
  });
});

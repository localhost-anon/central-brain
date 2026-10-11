import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDb, migrateDb, packageRoot, pendingMigrations } from '../src/db/connection.js';

/**
 * 0006 (web-ui) keeps an older journal `when` than 0005, so drizzle skips it on a DB whose
 * newest applied row is 0005. migrateDb must still apply it (criterion 238).
 */
function dbWithout0006(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-gap-'));
  const folder = path.join(dir, 'drizzle');
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
  const src = path.join(packageRoot(), 'drizzle');
  const journal = JSON.parse(fs.readFileSync(path.join(src, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 5);
  for (const e of journal.entries) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
  fs.writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const dbPath = path.join(dir, 'brain.db');
  const db = openDb(dbPath);
  migrate(db, { migrationsFolder: folder });
  db.$client.close();
  return dbPath;
}

const tables = (db: ReturnType<typeof openDb>) =>
  (db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);

describe('migrateDb applies journal entries drizzle skipped', () => {
  it('a DB at 0005 without 0006 gets 0006, and a rerun is a no-op', () => {
    const db = openDb(dbWithout0006());
    expect(tables(db)).not.toContain('worker_runs');
    expect(pendingMigrations(db)).toBe(1);
    const backups = path.join(path.dirname(db.$client.name), 'backups');
    migrateDb(db);
    expect(fs.readdirSync(backups).length).toBe(1); // snapshot taken before the gap was applied
    expect(tables(db)).toEqual(expect.arrayContaining(['worker_runs', 'worker_events']));
    expect((db.$client.prepare('PRAGMA table_info(approvals)').all() as { name: string }[]).map(c => c.name)).toContain('run_id');
    expect(pendingMigrations(db)).toBe(0);
    const rows = (db.$client.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number }).n;
    migrateDb(db);
    expect((db.$client.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number }).n).toBe(rows);
  });
});

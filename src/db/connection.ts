import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDb } from './backup.js';
import * as schema from './schema.js';

export type BrainDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function resolveDbPath(): string {
  return process.env.BRAIN_DB ?? path.join(os.homedir(), '.central-brain', 'brain.db');
}

export function packageRoot(): string {
  // src/db/connection.ts -> repo root (works from dist/db/connection.js too)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function migrationsFolder(): string {
  return path.join(packageRoot(), 'drizzle');
}

export function appliedMigrations(db: BrainDb): number {
  try {
    return (db.$client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
  } catch (err) {
    // Fresh DB: migrations table does not exist yet. Anything else must surface, or a passive
    // path could run migrateDb on an existing DB without taking a snapshot first.
    if (err instanceof Error && err.message.includes('no such table')) return 0;
    throw err;
  }
}

function appliedHashes(db: BrainDb): Set<string> {
  try {
    const rows = db.$client.prepare('SELECT hash FROM __drizzle_migrations').all() as { hash: string }[];
    return new Set(rows.map(r => r.hash));
  } catch (err) {
    if (err instanceof Error && err.message.includes('no such table')) return new Set();
    throw err;
  }
}

/**
 * Journal entries whose SQL (by sha256, as drizzle records it) is not in __drizzle_migrations.
 * Counting by hash rather than row count means an applied migration from another branch
 * cannot mask one of ours that is still pending.
 */
interface JournalMigration { tag: string; when: number; sql: string; hash: string }

function journalMigrations(): JournalMigration[] {
  const folder = migrationsFolder();
  const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as
    { entries: { tag: string; when: number }[] };
  return journal.entries.map(e => {
    const sql = fs.readFileSync(path.join(folder, `${e.tag}.sql`)).toString();
    return { tag: e.tag, when: e.when, sql, hash: crypto.createHash('sha256').update(sql).digest('hex') };
  });
}

/** Journal migrations whose SQL hash is not recorded in __drizzle_migrations (drizzle stores sha256 of the file). */
function unappliedMigrations(db: BrainDb): JournalMigration[] {
  const applied = appliedHashes(db);
  return journalMigrations().filter(m => !applied.has(m.hash));
}

export function pendingMigrations(db: BrainDb): number {
  return unappliedMigrations(db).length;
}

export const SCHEMA_NOTICE = 'Brain schema update pending — run `brain migrate`';

export function snapshotDir(db: BrainDb): string {
  return path.join(path.dirname(db.$client.name), 'backups');
}

export function openDb(dbPath: string = resolveDbPath()): BrainDb {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema }) as BrainDb;
}

export function migrateDb(db: BrainDb): void {
  const applied = appliedMigrations(db);
  if (applied > 0 && pendingMigrations(db) > 0 && db.$client.name !== ':memory:') {
    backupDb(db, snapshotDir(db));
  }
  migrate(db, { migrationsFolder: migrationsFolder() });
  // drizzle skips any migration whose journal `when` is older than the newest applied row. A branch
  // migration merged with an older timestamp (0006, web-ui) would never apply; apply such gaps here.
  const gaps = unappliedMigrations(db);
  if (gaps.length === 0) return;
  db.$client.transaction(() => {
    for (const m of gaps) {
      for (const stmt of m.sql.split('--> statement-breakpoint')) if (stmt.trim()) db.$client.exec(stmt);
      db.$client.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(m.hash, m.when);
    }
  })();
}

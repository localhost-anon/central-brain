import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
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
  } catch {
    return 0; // fresh DB: migrations table does not exist yet
  }
}

export function pendingMigrations(db: BrainDb): number {
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder(), 'meta', '_journal.json'), 'utf8'));
  return Math.max(0, journal.entries.length - appliedMigrations(db));
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
}

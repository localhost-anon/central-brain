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
  const folder = path.join(packageRoot(), 'drizzle');
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8'));
    const total = journal.entries.length;
    const applied = (db.$client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
    if (applied > 0 && applied < total && db.$client.name !== ':memory:') {
      backupDb(db);
    }
  } catch {
    // fresh DB (no migrations table yet) or unreadable journal: nothing to protect
  }
  migrate(db, { migrationsFolder: folder });
}

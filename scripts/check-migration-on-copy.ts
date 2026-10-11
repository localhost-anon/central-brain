// Usage: npx tsx scripts/check-migration-on-copy.ts [path-to-brain.db]
// Copies the DB to a temp dir, migrates the COPY, and asserts every goal keeps its id, status and
// rules_version. A DB from before rules versions existed counts as version 0 (the column default).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, migrateDb, pendingMigrations } from '../src/db/connection.js';

type Row = { id: string; status: string; rules_version: number };

function goalsOf(db: Database.Database): Row[] {
  const hasVersion = (db.prepare('PRAGMA table_info(goals)').all() as { name: string }[]).some(c => c.name === 'rules_version');
  return db.prepare(`SELECT id, status, ${hasVersion ? 'rules_version' : '0 AS rules_version'} FROM goals ORDER BY id`).all() as Row[];
}

const src = process.argv[2] ?? path.join(os.homedir(), '.central-brain', 'brain.db');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-copy-'));
const copy = path.join(dir, 'brain.db');
new Database(src, { readonly: true }).backup(copy).then(() => {
  const raw = new Database(copy);
  const before = goalsOf(raw);
  raw.close();
  const db = openDb(copy);
  const pendingBefore = pendingMigrations(db);
  migrateDb(db);
  const after = goalsOf(db.$client);
  const changed = after.filter((g, i) => JSON.stringify(g) !== JSON.stringify(before[i]));
  const ok = after.length === before.length && changed.length === 0;
  console.log(JSON.stringify({ copy, goals: after.length, pendingBefore, pendingAfter: pendingMigrations(db), unchanged: ok, changed }));
  process.exit(ok ? 0 : 1);
});

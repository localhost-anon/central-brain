// Usage: npx tsx scripts/check-migration-on-copy.ts [path-to-brain.db]
// Copies the DB to a temp dir, migrates the COPY, and asserts goals are unchanged and grandfathered.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, migrateDb } from '../src/db/connection.js';

const src = process.argv[2] ?? path.join(os.homedir(), '.central-brain', 'brain.db');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-copy-'));
const copy = path.join(dir, 'brain.db');
new Database(src, { readonly: true }).backup(copy).then(() => {
  const before = new Database(copy).prepare('SELECT id, status FROM goals ORDER BY id').all() as { id: string; status: string }[];
  const db = openDb(copy); migrateDb(db);
  const after = db.$client.prepare('SELECT id, status, rules_version FROM goals ORDER BY id').all() as { id: string; status: string; rules_version: number }[];
  const ok = after.length === before.length
    && after.every((g, i) => g.id === before[i]!.id && g.status === before[i]!.status && g.rules_version === 0);
  console.log(JSON.stringify({ copy, goals: after.length, unchanged: ok }));
  process.exit(ok ? 0 : 1);
});

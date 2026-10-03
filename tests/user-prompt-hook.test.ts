import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrateDb, packageRoot } from '../src/db/connection.js';
import { createGoal, lockGoal } from '../src/services/goals.js';
import { makeLockable } from './helpers.js';

const hook = path.join(packageRoot(), 'hooks', 'user-prompt.sh');
const has = (bin: string) => { try { execFileSync('which', [bin]); return true; } catch { return false; } };

function runHook(dbPath: string, env: Record<string, string> = {}): string {
  const out = execFileSync('bash', [hook], {
    input: JSON.stringify({ prompt: 'fix the bug' }), encoding: 'utf8',
    env: { ...process.env, BRAIN_DB: dbPath, ...env },
  });
  return JSON.parse(out).hookSpecificOutput.additionalContext as string;
}

describe.skipIf(!has('sqlite3') || !has('jq'))('user-prompt hook active goal', () => {
  it('skips stale goals (BRAIN_STALE_DAYS) like `goal current`', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-hook-')), 'brain.db');
    const db = openDb(dbPath);
    migrateDb(db);
    const fresh = createGoal(db, { title: 'fresh one', objective: 'o' });
    makeLockable(db, fresh.id); lockGoal(db, fresh.id);
    const stale = createGoal(db, { title: 'stale one', objective: 'o' });
    makeLockable(db, stale.id); lockGoal(db, stale.id);
    // Stale goal is the most recently updated by the old ordering, but 30 days old.
    db.$client.prepare('UPDATE goals SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 30 * 86_400_000).toISOString(), stale.id);
    db.$client.prepare('UPDATE goals SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 31 * 86_400_000).toISOString(), fresh.id);
    db.$client.close();

    // Default 7 days: both stale → no active goal.
    expect(runHook(dbPath)).toContain('No active Brain goal.');
    // 30.5 days: only the 30-day-old goal is live.
    const ctx = runHook(dbPath, { BRAIN_STALE_DAYS: '30.5' });
    expect(ctx).toContain(`Active Brain goal: ${stale.id} (LOCKED): stale one`);
    // Garbage falls back to 7 days, and the hook still succeeds.
    expect(runHook(dbPath, { BRAIN_STALE_DAYS: 'abc' })).toContain('No active Brain goal.');
  });
});

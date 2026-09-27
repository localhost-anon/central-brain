import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrateDb, pendingMigrations } from '../src/db/connection.js';
import { createTestDb } from './helpers.js';
import { createGoal } from '../src/services/goals.js';
import { addQuestion } from '../src/services/questions.js';
import { getContext } from '../src/services/context.js';

function cli(dbPath: string, ...args: string[]): any {
  const out = execFileSync('npx', ['tsx', 'src/cli/index.ts', ...args],
    { env: { ...process.env, BRAIN_DB: dbPath }, encoding: 'utf8' });
  return JSON.parse(out);
}

describe('migration guard', () => {
  it('passive context get does not migrate an existing DB with pending migrations', { timeout: 60000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-guard-'));
    const dbPath = path.join(dir, 'brain.db');
    const db = openDb(dbPath);
    migrateDb(db);
    // drizzle leaves __drizzle_migrations.id NULL in SQLite; target the last row by rowid.
    db.$client.prepare('DELETE FROM __drizzle_migrations WHERE rowid = (SELECT max(rowid) FROM __drizzle_migrations)').run();
    expect(pendingMigrations(db)).toBe(1); // precondition: guard test is not vacuous
    db.$client.close();
    const ctx = cli(dbPath, 'context', 'get');
    expect(ctx.schemaPending).toBe(true);
    expect(ctx.notice).toMatch(/brain migrate/);
    expect(pendingMigrations(openDb(dbPath))).toBe(1); // still unmigrated
  });

  it('passive context get initialises a brand-new DB (Review Focus 4)', { timeout: 60000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-guard-'));
    const ctx = cli(path.join(dir, 'brain.db'), 'context', 'get');
    expect(ctx.schemaPending).toBe(false);
    expect(ctx.goal).toBeNull();
  });

  it('brain migrate applies pending migrations on a fresh DB', { timeout: 60000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-guard-'));
    const res = cli(path.join(dir, 'brain.db'), 'migrate');
    expect(res.pending).toBe(0);
    expect(res.applied).toBeGreaterThan(0);
  });

  it('context reports open material questions for the goal', () => {
    const db = createTestDb();
    const g = createGoal(db, { title: 't', objective: 'o' });
    addQuestion(db, g.id, { question: 'Q?' });
    addQuestion(db, g.id, { question: 'detail?', materiality: 'detail' });
    expect(getContext(db, { goalId: g.id }).openMaterialQuestions).toBe(1);
  });
});

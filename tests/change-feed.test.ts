import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrateDb } from '../src/db/connection.js';
import { createGoal } from '../src/services/goals.js';
import { addDecision } from '../src/services/decisions.js';
import { ChangeFeed } from '../src/web/change-feed.js';

describe('change feed', () => {
  it('reports goals changed by another connection, once per change', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-feed-')), 'brain.db');
    const a = openDb(file); migrateDb(a);
    const b = openDb(file);
    const g1 = createGoal(b, { title: 'one', objective: 'o' });
    const g2 = createGoal(b, { title: 'two', objective: 'o' });
    const feed = new ChangeFeed(a);
    const seen: string[] = [];
    feed.on('goal-changed', (id: string) => seen.push(id));
    expect(feed.poll()).toEqual([]);                    // first poll = baseline
    addDecision(b, { goalId: g2.id, decision: 'use SSE' });
    expect(feed.poll()).toEqual([g2.id]);
    expect(feed.poll()).toEqual([]);                    // nothing new
    b.$client.prepare("UPDATE goals SET status = 'BLOCKED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), g1.id);
    expect(feed.poll()).toEqual([g1.id]);
    expect(seen).toEqual([g2.id, g1.id]);
    const g3 = createGoal(b, { title: 'three', objective: 'o' });
    expect(feed.poll()).toEqual([g3.id]);               // new goals are reported too
  });
});

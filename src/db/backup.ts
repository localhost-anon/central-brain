import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrainDb } from './connection.js';

export function backupDb(
  db: BrainDb,
  destDir: string = path.join(os.homedir(), '.central-brain', 'backups'),
): string {
  fs.mkdirSync(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(destDir, `brain-${stamp}.db`);
  db.$client.prepare('VACUUM INTO ?').run(dest);
  const snapshots = fs.readdirSync(destDir)
    .filter(f => f.startsWith('brain-') && f.endsWith('.db')).sort().reverse();
  for (const old of snapshots.slice(10)) fs.rmSync(path.join(destDir, old));
  return dest;
}

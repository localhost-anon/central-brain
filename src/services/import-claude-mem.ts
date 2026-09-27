import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import type { BrainDb } from '../db/connection.js';
import { observations } from '../db/schema.js';
import { slugify } from '../ids.js';
import { listProjects } from './projects.js';

export interface ImportResult { imported: number; skipped: number; projectScoped: number }

interface SourceRow {
  id: number; project: string | null; type: string | null;
  title: string | null; narrative: string | null; text: string | null;
  created_at: string | null; created_at_epoch: number | null;
}

function toIso(r: SourceRow): string {
  if (r.created_at_epoch) return new Date(r.created_at_epoch).toISOString();
  if (r.created_at) {
    const t = Date.parse(r.created_at);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Builds a resolver from a claude-mem project name to a Brain project id.
 * Exact id match wins; otherwise the slug of the last '/'-segment of a project's
 * name (or its rootPath basename) matches when exactly one project claims it.
 */
function projectResolver(db: BrainDb): (project: string | null) => string | null {
  const ids = new Set<string>();
  const bySegment = new Map<string, Set<string>>();
  for (const p of listProjects(db)) {
    ids.add(p.id);
    const keys = [slugify(p.name.split('/').pop() ?? '')];
    if (p.rootPath) keys.push(slugify(path.basename(p.rootPath)));
    for (const k of keys) {
      if (!k) continue;
      if (!bySegment.has(k)) bySegment.set(k, new Set());
      bySegment.get(k)!.add(p.id);
    }
  }
  return (project) => {
    const slug = project ? slugify(project) : '';
    if (!slug) return null;
    if (ids.has(slug)) return slug;
    const candidates = bySegment.get(slug);
    return candidates && candidates.size === 1 ? [...candidates][0]! : null;
  };
}

export function importClaudeMem(
  db: BrainDb,
  sourcePath: string = path.join(os.homedir(), '.claude-mem', 'claude-mem.db'),
): ImportResult {
  const src = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const cols = new Set((src.prepare('PRAGMA table_info(observations)').all() as { name: string }[]).map(c => c.name));
    const narrativeCol = cols.has('narrative') ? 'narrative' : 'NULL AS narrative';
    const rows = src.prepare(
      `SELECT id, project, type, title, ${narrativeCol}, text, created_at, created_at_epoch FROM observations`,
    ).all() as SourceRow[];
    const existing = new Set(
      db.select({ ref: observations.sourceRef }).from(observations).all()
        .map(r => r.ref).filter((r): r is string => r !== null));
    const resolveProject = projectResolver(db);
    let imported = 0, skipped = 0, projectScoped = 0;
    db.transaction((tx) => {
      for (const r of rows) {
        const ref = `claude-mem:${r.id}`;
        if (existing.has(ref)) { skipped++; continue; }
        const body = r.narrative || r.text;
        const text = [r.title, body].filter(Boolean).join(': ').slice(0, 2000);
        if (!text) { skipped++; continue; }
        const projectId = resolveProject(r.project);
        if (projectId) projectScoped++;
        tx.insert(observations).values({
          observation: text,
          scopeType: projectId ? 'PROJECT' : 'GLOBAL',
          scopeId: projectId ? `project:${projectId}` : null,
          sourceRef: ref, confidence: 0.6, createdAt: toIso(r),
        }).run();
        imported++;
      }
    });
    return { imported, skipped, projectScoped };
  } finally {
    src.close();
  }
}

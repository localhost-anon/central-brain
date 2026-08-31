import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { knowledge, projects, repositories } from '../db/schema.js';
import { slugify } from '../ids.js';
import { addKnowledge, supersedeKnowledge, verifyKnowledge } from './knowledge.js';
import { addProject, addRepo, getProject } from './projects.js';

export interface ProjectInfo {
  name: string;
  path: string;
  markers: string[];
  hasGit: boolean;
  language?: string;
  framework?: string;
  packageManager?: string;
}

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt',
  'go.mod', 'Cargo.toml', 'docker-compose.yml', 'Dockerfile'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__']);
const FRAMEWORK_DEPS = ['next', '@nestjs/core', 'react', 'vue', 'express', 'fastify', 'commander'];

export function detectProject(dir: string): Omit<ProjectInfo, 'name'> | null {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const markers = MARKERS.filter(m => entries.includes(m));
  if (markers.length === 0) return null;
  const info: Omit<ProjectInfo, 'name'> = { path: dir, markers, hasGit: markers.includes('.git') };
  if (entries.includes('package.json')) {
    info.language = entries.includes('tsconfig.json') ? 'typescript' : 'javascript';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
      const fw = FRAMEWORK_DEPS.find(f => f in deps);
      info.framework = fw === '@nestjs/core' ? 'nestjs' : fw;
    } catch { /* unreadable manifest: metadata stays unset */ }
    info.packageManager = entries.includes('pnpm-lock.yaml') ? 'pnpm'
      : entries.includes('yarn.lock') ? 'yarn'
      : entries.includes('package-lock.json') ? 'npm' : undefined;
  } else if (entries.includes('pyproject.toml') || entries.includes('requirements.txt')) {
    info.language = 'python';
  } else if (entries.includes('go.mod')) {
    info.language = 'go';
  } else if (entries.includes('Cargo.toml')) {
    info.language = 'rust';
  }
  return info;
}

function childDirs(dir: string): string[] {
  return fs.readdirSync(dir).filter(e => {
    if (SKIP.has(e) || e.startsWith('.')) return false;
    try { return fs.statSync(path.join(dir, e)).isDirectory(); } catch { return false; }
  });
}

export function discoverProjects(rootDir: string): ProjectInfo[] {
  const found: ProjectInfo[] = [];
  for (const entry of childDirs(rootDir)) {
    const dir = path.join(rootDir, entry);
    const info = detectProject(dir);
    if (info) {
      found.push({ name: entry, ...info });
      continue;
    }
    // marker-less dir: treat as sub-workspace, descend exactly one more level
    for (const child of childDirs(dir)) {
      const cinfo = detectProject(path.join(dir, child));
      if (cinfo) found.push({ name: `${entry}/${child}`, ...cinfo });
    }
  }
  return found;
}

export interface ScanResult {
  registered: number;
  updated: number;
  projects: string[];
  collisions: string[];
  errors: string[];
}

function seedFact(db: BrainDb, scopeId: string, category: string, statement: string): void {
  const existing = db.select().from(knowledge).where(and(
    eq(knowledge.scopeId, scopeId),
    eq(knowledge.category, category),
    eq(knowledge.sourceType, 'scan'),
    eq(knowledge.status, 'active'),
  )).get();
  if (!existing) {
    addKnowledge(db, { scopeType: 'PROJECT', scopeId, category, statement, sourceType: 'scan' });
  } else if (existing.statement === statement) {
    verifyKnowledge(db, existing.id);
  } else {
    supersedeKnowledge(db, existing.id, { statement, sourceType: 'scan' });
  }
}

export function scanProjects(db: BrainDb, rootDir: string): ScanResult {
  const infos = discoverProjects(rootDir);
  let registered = 0;
  let updated = 0;
  const collisions: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const p of infos) {
    const id = slugify(p.name);
    if (!id) continue; // unslugifiable name: skip rather than register an empty id
    if (seen.has(id)) {
      collisions.push(`${p.name} -> ${id} (already claimed this run)`);
      continue;
    }
    seen.add(id);
    try {
      let existing;
      try { existing = getProject(db, id); } catch { existing = undefined; }
      let projectId: string;
      if (existing) {
        if (existing.name !== p.name) {
          collisions.push(`${p.name} -> ${id} (held by ${existing.name})`);
          continue;
        }
        db.update(projects).set({ rootPath: p.path, updatedAt: new Date().toISOString() })
          .where(eq(projects.id, id)).run();
        projectId = existing.id;
        updated++;
      } else {
        projectId = addProject(db, { name: p.name, rootPath: p.path }).id;
        registered++;
      }
      if (p.hasGit && !db.select().from(repositories).where(eq(repositories.id, id)).get()) {
        addRepo(db, { name: p.name, projectId, path: p.path, language: p.language, framework: p.framework });
      }
      const scope = `project:${projectId}`;
      if (p.language) seedFact(db, scope, 'language', `Language: ${p.language}`);
      if (p.framework) seedFact(db, scope, 'framework', `Framework: ${p.framework}`);
      if (p.packageManager) seedFact(db, scope, 'package-manager', `Package manager: ${p.packageManager}`);
    } catch (e) {
      errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  return { registered, updated, projects: infos.map(i => i.name), collisions, errors };
}

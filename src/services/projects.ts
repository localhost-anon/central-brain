import { eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { projects, repositories } from '../db/schema.js';
import { slugify } from '../ids.js';

export type Project = typeof projects.$inferSelect;
export type Repo = typeof repositories.$inferSelect;

const now = () => new Date().toISOString();

export function addProject(db: BrainDb, input: { name: string; rootPath?: string; description?: string }): Project {
  const id = slugify(input.name);
  if (db.select().from(projects).where(eq(projects.id, id)).get()) {
    throw new Error(`Project already exists: ${id}`);
  }
  const ts = now();
  db.insert(projects).values({
    id, name: input.name, rootPath: input.rootPath ?? null,
    description: input.description ?? null, createdAt: ts, updatedAt: ts,
  }).run();
  return getProject(db, id);
}

export function getProject(db: BrainDb, idOrName: string): Project {
  const p = db.select().from(projects).where(eq(projects.id, idOrName)).get()
    ?? db.select().from(projects).where(eq(projects.name, idOrName)).get()
    ?? db.select().from(projects).where(eq(projects.id, slugify(idOrName))).get();
  if (!p) throw new Error(`Project not found: ${idOrName}`);
  return p;
}

export function listProjects(db: BrainDb): Project[] {
  return db.select().from(projects).all();
}

export function addRepo(db: BrainDb, input: {
  name: string; projectId?: string; path?: string; remoteUrl?: string;
  defaultBranch?: string; language?: string; framework?: string;
}): Repo {
  if (input.projectId) getProject(db, input.projectId);
  const id = slugify(input.name);
  if (db.select().from(repositories).where(eq(repositories.id, id)).get()) {
    throw new Error(`Repository already exists: ${id}`);
  }
  db.insert(repositories).values({
    id, name: input.name, projectId: input.projectId ?? null,
    path: input.path ?? null, remoteUrl: input.remoteUrl ?? null,
    defaultBranch: input.defaultBranch ?? null, language: input.language ?? null,
    framework: input.framework ?? null, createdAt: now(),
  }).run();
  return db.select().from(repositories).where(eq(repositories.id, id)).get()!;
}

export function listRepos(db: BrainDb, projectId?: string): Repo[] {
  const q = db.select().from(repositories);
  return projectId ? q.where(eq(repositories.projectId, projectId)).all() : q.all();
}

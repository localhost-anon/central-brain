import { and, eq } from 'drizzle-orm';
import type { BrainDb } from '../db/connection.js';
import { knowledge, learnings } from '../db/schema.js';
import { parsePrefixedId } from '../ids.js';

export type Knowledge = typeof knowledge.$inferSelect;
export type Learning = typeof learnings.$inferSelect;

const now = () => new Date().toISOString();

function assertScope(scopeId?: string): void {
  if (scopeId) parsePrefixedId(scopeId); // throws with "prefixed" guidance if invalid
}

export function addKnowledge(db: BrainDb, input: {
  scopeType: string; scopeId?: string; category?: string; statement: string;
  confidence?: number; sourceType?: string; sourceReference?: string;
}): Knowledge {
  assertScope(input.scopeId);
  const res = db.insert(knowledge).values({
    scopeType: input.scopeType, scopeId: input.scopeId ?? null,
    category: input.category ?? null, statement: input.statement,
    confidence: input.confidence ?? 1.0, sourceType: input.sourceType ?? null,
    sourceReference: input.sourceReference ?? null, createdAt: now(),
  }).run();
  return getKnowledge(db, Number(res.lastInsertRowid));
}

export function getKnowledge(db: BrainDb, id: number): Knowledge {
  const k = db.select().from(knowledge).where(eq(knowledge.id, id)).get();
  if (!k) throw new Error(`Knowledge not found: ${id}`);
  return k;
}

export function verifyKnowledge(db: BrainDb, id: number): Knowledge {
  getKnowledge(db, id);
  db.update(knowledge).set({ lastVerifiedAt: now() }).where(eq(knowledge.id, id)).run();
  return getKnowledge(db, id);
}

export function invalidateKnowledge(db: BrainDb, id: number): Knowledge {
  getKnowledge(db, id);
  db.update(knowledge).set({ status: 'invalid' }).where(eq(knowledge.id, id)).run();
  return getKnowledge(db, id);
}

export function supersedeKnowledge(db: BrainDb, oldId: number, input: {
  statement: string; confidence?: number; sourceType?: string; sourceReference?: string;
}): Knowledge {
  const old = getKnowledge(db, oldId);
  if (old.status !== 'active') throw new Error(`Cannot supersede non-active knowledge ${oldId} (status: ${old.status})`);
  const neu = addKnowledge(db, {
    scopeType: old.scopeType, scopeId: old.scopeId ?? undefined,
    category: old.category ?? undefined, statement: input.statement,
    confidence: input.confidence, sourceType: input.sourceType,
    sourceReference: input.sourceReference,
  });
  db.update(knowledge).set({ status: 'superseded', supersededBy: neu.id })
    .where(eq(knowledge.id, oldId)).run();
  return neu;
}

export function listKnowledge(db: BrainDb, opts: {
  scopeType?: string; scopeId?: string; includeInactive?: boolean;
} = {}): Knowledge[] {
  const conds = [];
  if (!opts.includeInactive) conds.push(eq(knowledge.status, 'active'));
  if (opts.scopeType) conds.push(eq(knowledge.scopeType, opts.scopeType));
  if (opts.scopeId) conds.push(eq(knowledge.scopeId, opts.scopeId));
  const q = db.select().from(knowledge);
  return conds.length ? q.where(and(...conds)).all() : q.all();
}

export function addLearning(db: BrainDb, input: {
  learning: string; scopeType?: string; scopeId?: string; trigger?: string;
}): Learning {
  assertScope(input.scopeId);
  const res = db.insert(learnings).values({
    learning: input.learning, scopeType: input.scopeType ?? null,
    scopeId: input.scopeId ?? null, trigger: input.trigger ?? null, createdAt: now(),
  }).run();
  return db.select().from(learnings).where(eq(learnings.id, Number(res.lastInsertRowid))).get()!;
}

export function markLearningUseful(db: BrainDb, id: number): Learning {
  const l = db.select().from(learnings).where(eq(learnings.id, id)).get();
  if (!l) throw new Error(`Learning not found: ${id}`);
  db.update(learnings).set({ timesUsed: l.timesUsed + 1, lastUsedAt: now() })
    .where(eq(learnings.id, id)).run();
  return db.select().from(learnings).where(eq(learnings.id, id)).get()!;
}

export function listLearnings(db: BrainDb, opts: { scopeType?: string; scopeId?: string } = {}): Learning[] {
  const conds = [];
  if (opts.scopeType) conds.push(eq(learnings.scopeType, opts.scopeType));
  if (opts.scopeId) conds.push(eq(learnings.scopeId, opts.scopeId));
  const q = db.select().from(learnings);
  return conds.length ? q.where(and(...conds)).all() : q.all();
}

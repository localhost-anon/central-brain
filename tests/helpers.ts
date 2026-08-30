import { openDb, migrateDb, type BrainDb } from '../src/db/connection.js';

export function createTestDb(): BrainDb {
  const db = openDb(':memory:');
  migrateDb(db);
  return db;
}

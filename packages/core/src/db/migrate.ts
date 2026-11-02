import type { Database } from './database.js';
import { migrations } from './migrations.js';

/** Schema version this build expects. */
export const SCHEMA_VERSION = migrations.length;

/**
 * Apply pending migrations, each in its own transaction. Refuses to open a
 * database written by a newer build (rather than corrupting it).
 */
export async function migrate(db: Database): Promise<void> {
  await db.exec('PRAGMA foreign_keys = ON');
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  const current = Number(row?.user_version ?? 0);
  if (current > migrations.length) {
    throw new Error(`Database schema v${current} is newer than this Overtone build (v${migrations.length}). Update Overtone.`);
  }
  for (let v = current; v < migrations.length; v++) {
    await db.transaction(async (tx) => {
      await tx.exec(migrations[v]!);
      await tx.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

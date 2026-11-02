import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createDatabase, migrations, syncHandleDriver, type Database as CoreDatabase } from '@overtone/core';
import Database from 'better-sqlite3';

/** The raw better-sqlite3 handle (used directly by server-only code: auth). */
export type Db = Database.Database;

/** Open (and migrate) the database. Pass ':memory:' for tests. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Apply core's migrations synchronously (same list and PRAGMA user_version
 * bookkeeping as core's async `migrate()`, which the other drivers use).
 */
export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > migrations.length) {
    throw new Error(`Database schema v${current} is newer than this Overtone build (v${migrations.length}). Upgrade Overtone.`);
  }
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/**
 * Core's async Database over the same connection. better-sqlite3 is
 * synchronous, so each statement completes before control returns; core's
 * wrapper serializes its own transactions.
 */
export function coreDatabase(db: Db): CoreDatabase {
  return createDatabase(syncHandleDriver(db as never));
}

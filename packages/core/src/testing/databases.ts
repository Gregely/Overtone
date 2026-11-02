/**
 * Test databases: every core test that touches SQL runs against each driver
 * that ships (better-sqlite3 on the server, sql.js in the browser). The
 * Android driver (Capacitor SQLite) can only run on a device; it shares the
 * same Database wrapper and migrations.
 */
import Sqlite from 'better-sqlite3';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { createDatabase, syncHandleDriver, type Database } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { sqlJsDriver } from '../db/sqljs.js';

let sqlJs: Promise<SqlJsStatic> | undefined;

export interface TestDatabaseFactory {
  name: string;
  open(): Promise<Database>;
}

export const TEST_DATABASES: readonly TestDatabaseFactory[] = [
  {
    name: 'better-sqlite3',
    async open() {
      const db = createDatabase(syncHandleDriver(new Sqlite(':memory:')));
      await migrate(db);
      return db;
    },
  },
  {
    name: 'sql.js',
    async open() {
      sqlJs ??= initSqlJs();
      const db = createDatabase(sqlJsDriver(await sqlJs));
      await migrate(db);
      return db;
    },
  },
];

/** Default for tests that don't care about the driver. */
export const openTestDatabase = (): Promise<Database> => TEST_DATABASES[0]!.open();

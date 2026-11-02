/**
 * Database driver over @capacitor-community/sqlite (Android). Uses the raw
 * plugin API with transaction=false everywhere: core's Database wrapper
 * issues BEGIN/COMMIT itself and serializes all access.
 *
 * Plugin behaviours this relies on (checked in its Android source, v8.1.1):
 *  - `run` strips RETURNING and emulates it with the last insert id, so core
 *    never uses RETURNING (see core/db/migrations.ts);
 *  - DELETE is rewritten into a soft delete only for tables with
 *    `sql_deleted` + `last_modified` columns, which our schema doesn't have.
 */
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import type { SqlDriver, SqlParams } from '@overtone/core';

export async function capacitorSqliteDriver(database: string): Promise<SqlDriver> {

  await CapacitorSQLite.createConnection({ database, version: 1, encrypted: false, mode: 'no-encryption', readonly: false }).catch((err: Error) => {
    // A connection survives a WebView reload; reuse it.
    if (!/already exists/i.test(err.message)) throw err;
  });
  await CapacitorSQLite.open({ database, readonly: false });
  const values = (params: SqlParams | undefined) => [...(params ?? [])].map((v) => (typeof v === 'bigint' ? Number(v) : v));
  return {
    name: 'capacitor-sqlite',
    async run(statement, params) {
      const r = await CapacitorSQLite.run({ database, statement, values: values(params), transaction: false, readonly: false });
      return { changes: r.changes?.changes ?? 0, lastInsertRowid: r.changes?.lastId ?? 0 };
    },
    async get<T>(statement: string, params?: SqlParams) {
      const r = await CapacitorSQLite.query({ database, statement, values: values(params), readonly: false });
      return (r.values?.[0] as T | undefined) ?? undefined;
    },
    async all<T>(statement: string, params?: SqlParams) {
      const r = await CapacitorSQLite.query({ database, statement, values: values(params), readonly: false });
      return (r.values ?? []) as T[];
    },
    async exec(statements) {
      await CapacitorSQLite.execute({ database, statements, transaction: false, readonly: false });
    },
    async close() {
      await CapacitorSQLite.closeConnection({ database, readonly: false }).catch(() => undefined);
    },
  };
}

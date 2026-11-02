/**
 * A small async SQL interface that every Overtone database driver
 * implements: better-sqlite3 (server), Capacitor SQLite (Android standalone)
 * and sql.js (browser standalone + tests).
 *
 * Drivers only execute statements. `createDatabase()` adds what the domain
 * code relies on: one statement or transaction at a time (a single
 * connection is shared by everything), `undefined` → NULL, and transactions
 * that roll back on error.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = readonly unknown[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** What domain code uses: the database itself, or an open transaction. */
export interface SqlExecutor {
  run(sql: string, params?: SqlParams): Promise<RunResult>;
  get<T>(sql: string, params?: SqlParams): Promise<T | undefined>;
  all<T>(sql: string, params?: SqlParams): Promise<T[]>;
  /** One or more statements without parameters (DDL, PRAGMA). */
  exec(sql: string): Promise<void>;
}

export interface Database extends SqlExecutor {
  /** Driver name, for diagnostics ("better-sqlite3", "capacitor-sqlite", "sql.js"). */
  readonly driver: string;
  /**
   * Run `fn` inside BEGIN … COMMIT (ROLLBACK if it throws). Other callers
   * wait until it finishes. Inside `fn`, use only `tx`: calling the outer
   * database from inside a transaction would wait for itself.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** The minimal surface a driver provides. All methods may be sync-backed. */
export interface SqlDriver extends SqlExecutor {
  readonly name: string;
  close(): Promise<void>;
}

const normalize = (params: SqlParams | undefined): SqlValue[] =>
  (params ?? []).map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v as SqlValue;
  });

/** Wrap a driver with serialization and transactions. */
export function createDatabase(driver: SqlDriver): Database {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;

  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = () => {
      if (closed) throw new Error('Database is closed');
      return fn();
    };
    const p = tail.then(run, run);
    tail = p.catch(() => undefined);
    return p;
  };

  const direct: SqlExecutor = {
    run: (sql, params) => driver.run(sql, normalize(params)),
    get: <T>(sql: string, params?: SqlParams) => driver.get<T>(sql, normalize(params)),
    all: <T>(sql: string, params?: SqlParams) => driver.all<T>(sql, normalize(params)),
    exec: (sql) => driver.exec(sql),
  };

  return {
    driver: driver.name,
    run: (sql, params) => exclusive(() => direct.run(sql, params)),
    get: <T>(sql: string, params?: SqlParams) => exclusive(() => direct.get<T>(sql, params)),
    all: <T>(sql: string, params?: SqlParams) => exclusive(() => direct.all<T>(sql, params)),
    exec: (sql) => exclusive(() => direct.exec(sql)),
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      exclusive(async () => {
        await driver.exec('BEGIN');
        try {
          const result = await fn(direct);
          await driver.exec('COMMIT');
          return result;
        } catch (err) {
          await driver.exec('ROLLBACK').catch(() => undefined);
          throw err;
        }
      }),
    close: () =>
      exclusive(async () => {
        closed = true;
        await driver.close();
      }).catch((err) => {
        if (!closed) throw err;
      }),
  };
}

/**
 * Structural type for a synchronous SQLite handle such as better-sqlite3's
 * `Database`. Core never imports better-sqlite3; the server passes its handle.
 */
export interface SyncSqliteHandle {
  prepare(sql: string): {
    readonly reader: boolean;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  close(): unknown;
}

/** Driver over a synchronous handle (better-sqlite3), with a statement cache. */
export function syncHandleDriver(handle: SyncSqliteHandle, name = 'better-sqlite3'): SqlDriver {
  const cache = new Map<string, ReturnType<SyncSqliteHandle['prepare']>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = handle.prepare(sql);
      if (cache.size > 500) cache.clear();
      cache.set(sql, s);
    }
    return s;
  };
  return {
    name,
    async run(sql, params) {
      const r = stmt(sql).run(...(params ?? []));
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    },
    async get<T>(sql: string, params?: SqlParams) {
      return stmt(sql).get(...(params ?? [])) as T | undefined;
    },
    async all<T>(sql: string, params?: SqlParams) {
      return stmt(sql).all(...(params ?? [])) as T[];
    },
    async exec(sql) {
      handle.exec(sql);
    },
    async close() {
      cache.clear();
      handle.close();
    },
  };
}

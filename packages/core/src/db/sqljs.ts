/**
 * sql.js (SQLite compiled to WebAssembly) driver. Used for core tests and for
 * standalone mode in a plain browser (where there's no native SQLite).
 *
 * The whole database lives in memory; pass `persist` to save a snapshot
 * (e.g. to IndexedDB) after writes. Writes from the last `persistDelayMs`
 * can be lost if the page is closed abruptly (a save started while the page
 * unloads isn't guaranteed to finish). Android uses a real SQLite file
 * instead, so this only affects the browser (development/testing) build.
 */
import type { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import type { SqlDriver, SqlParams } from './database.js';

export interface SqlJsDriverOptions {
  /** Existing database bytes (a previous snapshot). */
  data?: Uint8Array | null;
  /** Called (throttled) after writes with a full snapshot of the database. */
  persist?: (bytes: Uint8Array) => Promise<void> | void;
  persistDelayMs?: number;
}

export function sqlJsDriver(SQL: SqlJsStatic, opts: SqlJsDriverOptions = {}): SqlDriver & { export(): Uint8Array; flush(): Promise<void> } {
  const db: SqlJsDatabase = opts.data ? new SQL.Database(opts.data) : new SQL.Database();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inTx = false;
  let dirtySinceSave = false;
  let saving: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!opts.persist || !dirtySinceSave) return saving;
    if (inTx) {
      // Never snapshot half a transaction; COMMIT/ROLLBACK schedules the save again.
      return saving;
    }
    dirtySinceSave = false;
    const bytes = db.export();
    saving = saving.then(() => opts.persist!(bytes)).catch(() => {
      dirtySinceSave = true;
    });
    return saving;
  };
  /**
   * Throttled, not debounced: the first unsaved write schedules a save within
   * `persistDelayMs`, however busy the database is (background matching
   * writes every second, which would starve a debounce forever).
   */
  const dirty = () => {
    if (!opts.persist) return;
    dirtySinceSave = true;
    if (inTx || timer) return;
    timer = setTimeout(() => void flush(), opts.persistDelayMs ?? 250);
  };

  const query = <T>(sql: string, params: SqlParams | undefined): T[] => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind((params ?? []) as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  };

  return {
    name: 'sql.js',
    async run(sql, params) {
      db.run(sql, (params ?? []) as never);
      const changes = db.getRowsModified();
      const id = db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0];
      dirty();
      return { changes, lastInsertRowid: Number(id ?? 0) };
    },
    async get<T>(sql: string, params?: SqlParams) {
      return query<T>(sql, params)[0];
    },
    async all<T>(sql: string, params?: SqlParams) {
      return query<T>(sql, params);
    },
    async exec(sql) {
      const verb = sql.trim().toUpperCase();
      if (verb === 'BEGIN') inTx = true;
      db.exec(sql);
      if (verb === 'COMMIT' || verb === 'ROLLBACK') inTx = false;
      if (verb === 'ROLLBACK' ? dirtySinceSave : !/^(SELECT|PRAGMA\s+\w+\s*$)/.test(verb)) dirty();
    },
    async close() {
      await flush();
      db.close();
    },
    export: () => db.export(),
    /** Save now (e.g. when the page is being hidden or unloaded). */
    flush,
  };
}

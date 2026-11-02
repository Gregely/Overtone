import { describe, expect, it } from 'vitest';
import { TEST_DATABASES } from '../testing/databases.js';
import { createDatabase, type SqlDriver } from './database.js';
import { migrate, SCHEMA_VERSION } from './migrate.js';

describe.each(TEST_DATABASES)('Database ($name)', (factory) => {
  it('migrates to the current schema with foreign keys on', async () => {
    const db = await factory.open();
    expect((await db.get<{ user_version: number }>('PRAGMA user_version'))?.user_version).toBe(SCHEMA_VERSION);
    expect((await db.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys).toBe(1);
    // Migrating again is a no-op.
    await migrate(db);
    expect((await db.get<{ user_version: number }>('PRAGMA user_version'))?.user_version).toBe(SCHEMA_VERSION);
  });

  it('refuses a database from a newer build', async () => {
    const db = await factory.open();
    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    await expect(migrate(db)).rejects.toThrow(/newer than this Overtone build/);
  });

  it('runs, reads and reports changes / insert ids; undefined and booleans bind', async () => {
    const db = await factory.open();
    const r = await db.run(`INSERT INTO app_settings (key, value_json) VALUES (?, ?)`, ['a', JSON.stringify(true)]);
    expect(r.changes).toBe(1);
    await db.run(`INSERT INTO sources (id, provider_id, name, enabled, created_at, last_error) VALUES (?, ?, ?, ?, ?, ?)`, ['s', 'p', 'S', true, 1, undefined]);
    expect(await db.get('SELECT enabled, last_error FROM sources WHERE id = ?', ['s'])).toEqual({ enabled: 1, last_error: null });
    const ins = await db.run(`INSERT INTO artists (key, name, sort_name, search_text, created_at) VALUES ('k', 'n', 'n', 'n', 0)`);
    expect(ins.lastInsertRowid).toBeGreaterThan(0);
    expect(await db.all('SELECT key FROM artists')).toEqual([{ key: 'k' }]);
    expect(await db.get('SELECT key FROM artists WHERE id = -1')).toBeUndefined();
  });

  it('rolls back a failed transaction and keeps going', async () => {
    const db = await factory.open();
    await expect(
      db.transaction(async (tx) => {
        await tx.run(`INSERT INTO app_settings (key, value_json) VALUES ('x', '1')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.get(`SELECT * FROM app_settings WHERE key = 'x'`)).toBeUndefined();
    await db.transaction((tx) => tx.run(`INSERT INTO app_settings (key, value_json) VALUES ('y', '1')`));
    expect(await db.get(`SELECT key FROM app_settings WHERE key = 'y'`)).toEqual({ key: 'y' });
  });

  it('enforces foreign keys (cascade deletes)', async () => {
    const db = await factory.open();
    await db.run(`INSERT INTO sources (id, provider_id, name, created_at) VALUES ('s', 'p', 'S', 0)`);
    await db.run(`INSERT INTO provider_state (source_id, key, value_json) VALUES ('s', 'k', '1')`);
    await db.run(`DELETE FROM sources WHERE id = 's'`);
    expect(await db.all('SELECT * FROM provider_state')).toEqual([]);
  });
});

describe('createDatabase', () => {
  it('serializes statements around a transaction (no interleaving on the shared connection)', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const driver: SqlDriver = {
      name: 'fake',
      run: async (sql) => (log.push(sql), { changes: 0, lastInsertRowid: 0 }),
      get: async () => undefined,
      all: async () => [],
      exec: async (sql) => void log.push(sql),
      close: async () => undefined,
    };
    const db = createDatabase(driver);
    const tx = db.transaction(async (t) => {
      await t.run('A');
      await gate; // e.g. an await inside the transaction
      await t.run('B');
    });
    const outside = db.run('OUTSIDE');
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(['BEGIN', 'A']);
    release();
    await Promise.all([tx, outside]);
    expect(log).toEqual(['BEGIN', 'A', 'B', 'COMMIT', 'OUTSIDE']);
  });
});

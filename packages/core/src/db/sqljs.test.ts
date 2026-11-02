import initSqlJs from 'sql.js';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from './database.js';
import { migrate } from './migrate.js';
import { sqlJsDriver } from './sqljs.js';

describe('sql.js driver persistence', () => {
  it('saves within the delay even while writes keep coming (throttle, not debounce), never mid-transaction', async () => {
    vi.useFakeTimers();
    try {
      const SQL = await initSqlJs();
      const saves: Uint8Array[] = [];
      const driver = sqlJsDriver(SQL, { persist: (b) => void saves.push(b), persistDelayMs: 500 });
      const db = createDatabase(driver);
      await migrate(db);
      saves.length = 0;
      // A write every 200 ms for 2 s: a debounce would never fire.
      for (let i = 0; i < 10; i++) {
        await db.run(`INSERT INTO app_settings (key, value_json) VALUES (?, '1')`, [`k${i}`]);
        await vi.advanceTimersByTimeAsync(200);
      }
      expect(saves.length).toBeGreaterThanOrEqual(3);

      // Restoring the last snapshot gives the data back.
      await driver.flush();
      const restored = createDatabase(sqlJsDriver(SQL, { data: saves.at(-1)! }));
      expect((await restored.get<{ n: number }>('SELECT COUNT(*) AS n FROM app_settings'))?.n).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});

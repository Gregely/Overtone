import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { DEFAULT_DISCOVERY_PREFERENCES } from '@overtone/shared';
import { createDatabase, syncHandleDriver } from './db/database.js';
import { migrate } from './db/migrate.js';
import { PreferencesService, sanitizePreferences } from './preferences.js';

describe('sanitizePreferences', () => {
  it('returns defaults for empty input', () => {
    expect(sanitizePreferences(undefined)).toEqual(DEFAULT_DISCOVERY_PREFERENCES);
    expect(sanitizePreferences(null)).toEqual(DEFAULT_DISCOVERY_PREFERENCES);
  });

  it('keeps valid values', () => {
    expect(
      sanitizePreferences({ preferredFormat: 'mp3', minBitrateKbps: 320, preferredProvider: 'ad', rememberLastProvider: false, prioritizeCached: false, hideUncached: true, searchScope: 'album' }),
    ).toEqual({ ...DEFAULT_DISCOVERY_PREFERENCES, preferredFormat: 'mp3', minBitrateKbps: 320, preferredProvider: 'ad', rememberLastProvider: false, prioritizeCached: false, hideUncached: true, searchScope: 'album' });
  });

  it('falls back to defaults for invalid values', () => {
    expect(sanitizePreferences({ preferredFormat: 'wav', minBitrateKbps: 'high', searchScope: 'nope', rememberLastProvider: 'yes' })).toMatchObject({
      preferredFormat: 'any',
      minBitrateKbps: null,
      searchScope: 'auto',
      rememberLastProvider: true,
    });
  });

  it('caps the bitrate', () => {
    expect(sanitizePreferences({ minBitrateKbps: 99999 }).minBitrateKbps).toBe(1000);
  });
});

describe('PreferencesService', () => {
  it('persists per user and returns defaults when unset', async () => {
    const db = createDatabase(syncHandleDriver(new Sqlite(':memory:')));
    await migrate(db);
    const svc = new PreferencesService(db);

    expect(await svc.get(1)).toEqual(DEFAULT_DISCOVERY_PREFERENCES);

    await svc.set(1, { ...DEFAULT_DISCOVERY_PREFERENCES, preferredFormat: 'flac', prioritizeCached: false });
    expect(await svc.get(1)).toMatchObject({ preferredFormat: 'flac', prioritizeCached: false });

    // Preferences never leak between users.
    expect(await svc.get(2)).toEqual(DEFAULT_DISCOVERY_PREFERENCES);
  });

  it('recovers from a corrupt stored value', async () => {
    const db = createDatabase(syncHandleDriver(new Sqlite(':memory:')));
    await migrate(db);
    await db.run(`INSERT INTO app_settings (key, value_json) VALUES ('prefs:1', '{not json')`);
    const svc = new PreferencesService(db);
    expect(await svc.get(1)).toEqual(DEFAULT_DISCOVERY_PREFERENCES);
  });
});

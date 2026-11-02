/**
 * Discovery preferences, persisted per user in `app_settings` (key `prefs:<id>`)
 * so each user keeps their own and preferences never leak between users.
 * Standalone mode uses its single local user (id 1).
 */
import { DEFAULT_DISCOVERY_PREFERENCES, type DiscoveryPreferencesDto } from '@overtone/shared';
import type { Database } from './db/database.js';

const key = (userId: number) => `prefs:${userId}`;

export class PreferencesService {
  constructor(private readonly db: Database) {}

  async get(userId: number): Promise<DiscoveryPreferencesDto> {
    const row = await this.db.get<{ value_json: string }>('SELECT value_json FROM app_settings WHERE key = ?', [key(userId)]);
    if (!row) return { ...DEFAULT_DISCOVERY_PREFERENCES };
    try {
      return sanitizePreferences(JSON.parse(row.value_json));
    } catch {
      return { ...DEFAULT_DISCOVERY_PREFERENCES };
    }
  }

  async set(userId: number, prefs: DiscoveryPreferencesDto): Promise<DiscoveryPreferencesDto> {
    const clean = sanitizePreferences(prefs);
    await this.db.run('INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json', [
      key(userId),
      JSON.stringify(clean),
    ]);
    return clean;
  }
}

/** Validate/normalize user input, falling back to defaults for anything invalid. */
export function sanitizePreferences(input: unknown): DiscoveryPreferencesDto {
  const d = DEFAULT_DISCOVERY_PREFERENCES;
  const p = (input ?? {}) as Record<string, unknown>;
  const pick = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const bitrate = typeof p.minBitrateKbps === 'number' && Number.isFinite(p.minBitrateKbps) ? Math.min(1000, Math.max(0, Math.floor(p.minBitrateKbps))) : null;
  return {
    preferredFormat: pick(p.preferredFormat, ['any', 'flac', 'mp3'] as const, d.preferredFormat),
    minBitrateKbps: bitrate,
    preferredProvider: typeof p.preferredProvider === 'string' ? p.preferredProvider.slice(0, 64) : d.preferredProvider,
    rememberLastProvider: typeof p.rememberLastProvider === 'boolean' ? p.rememberLastProvider : d.rememberLastProvider,
    prioritizeCached: typeof p.prioritizeCached === 'boolean' ? p.prioritizeCached : d.prioritizeCached,
    hideUncached: typeof p.hideUncached === 'boolean' ? p.hideUncached : d.hideUncached,
    searchScope: pick(p.searchScope, ['auto', 'track', 'album'] as const, d.searchScope),
  };
}

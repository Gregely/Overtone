import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Auto-created LocalFolder source on first boot, if the directory exists. */
  musicDir: string | null;
  /** 32-byte master key. Never log. */
  secretKey: Buffer;
  corsOrigins: string[];
  mbContact: string;
  multiUser: boolean;
  scanIntervalMinutes: number;
  /** Built web app to serve at / (stage 3). */
  webDir: string | null;
  logLevel: string;
  trustProxy: boolean;
  version: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Capacitor (Android: https://localhost, iOS: capacitor://localhost) and local dev servers. */
export const DEFAULT_CORS_ORIGINS = ['https://localhost', 'http://localhost', 'capacitor://localhost'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env, version = '0.0.0'): Config {
  const dataDir = path.resolve(env.OVERTONE_DATA_DIR || './data');
  return {
    host: env.OVERTONE_HOST || '0.0.0.0',
    port: intEnv(env, 'OVERTONE_PORT', 4800, 1, 65535),
    dataDir,
    musicDir: env.OVERTONE_MUSIC_DIR === '' ? null : path.resolve(env.OVERTONE_MUSIC_DIR || '/music'),
    secretKey: parseSecretKey(env),
    corsOrigins: [
      ...DEFAULT_CORS_ORIGINS,
      ...(env.OVERTONE_CORS_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ],
    mbContact: env.OVERTONE_MB_CONTACT || 'https://github.com/gregely/overtone',
    multiUser: boolEnv(env, 'OVERTONE_MULTI_USER', false),
    scanIntervalMinutes: intEnv(env, 'OVERTONE_SCAN_INTERVAL_MINUTES', 360, 0, 7 * 24 * 60),
    webDir: env.OVERTONE_WEB_DIR ? path.resolve(env.OVERTONE_WEB_DIR) : null,
    logLevel: env.OVERTONE_LOG_LEVEL || 'info',
    trustProxy: boolEnv(env, 'OVERTONE_TRUST_PROXY', false),
    version,
  };
}

/**
 * OVERTONE_SECRET_KEY (or OVERTONE_SECRET_KEY_FILE, for Docker secrets) must
 * decode to exactly 32 bytes, as base64 or hex.
 */
export function parseSecretKey(env: NodeJS.ProcessEnv): Buffer {
  let raw = env.OVERTONE_SECRET_KEY;
  if (!raw && env.OVERTONE_SECRET_KEY_FILE) raw = readFileSync(env.OVERTONE_SECRET_KEY_FILE, 'utf8');
  raw = raw?.trim();
  if (!raw) {
    throw new ConfigError(
      'OVERTONE_SECRET_KEY is not set. Generate one with `openssl rand -base64 32` and put it in your .env file.',
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new ConfigError('OVERTONE_SECRET_KEY must be 32 bytes, base64 or hex encoded (`openssl rand -base64 32`).');
  }
  return key;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name]?.toLowerCase();
  if (v === undefined || v === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

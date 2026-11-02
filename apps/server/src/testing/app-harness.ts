/** Spin up a full app (in-memory DB, fake MusicBrainz, fake outbound fetch) for route tests. */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { buildApp } from '../app.js';
import { DEFAULT_CORS_ORIGINS, type Config } from '../config.js';
import { openDatabase } from '../db/index.js';
import { ProviderRegistry, type MusicBrainzApi, type ProviderPlugin } from '@overtone/core';
import { builtinPlugins } from '../providers/index.js';
import { FakeMusicBrainz } from './fake-musicbrainz.js';

export interface HarnessOptions {
  plugins?: ProviderPlugin[];
  mb?: MusicBrainzApi;
  fetch?: typeof fetch;
  config?: Partial<Config>;
  skipSetup?: boolean;
  now?: () => number;
}

export async function createHarness(opts: HarnessOptions = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'overtone-app-'));
  const logLines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    musicDir: null,
    secretKey: randomBytes(32),
    corsOrigins: DEFAULT_CORS_ORIGINS,
    mbContact: 'test@example.com',
    multiUser: false,
    scanIntervalMinutes: 0,
    webDir: null,
    logLevel: 'debug',
    trustProxy: false,
    version: 'test',
    premiumizeClientId: null,
    x1337BaseUrl: null,
    ...opts.config,
  };
  const registry = new ProviderRegistry();
  for (const p of [...builtinPlugins, ...(opts.plugins ?? [])]) registry.register(p);
  const { app, services } = await buildApp({
    config,
    logger: { level: 'debug', stream },
    db: openDatabase(':memory:'),
    registry,
    mb: opts.mb ?? new FakeMusicBrainz([]),
    ...(opts.now ? { now: opts.now } : {}),
    fetch: opts.fetch ?? (async (u) => {
      throw new Error(`unexpected fetch ${String(u)}`);
    }),
  });
  await app.ready();

  let auth = { authorization: '' };
  if (!opts.skipSetup) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'password1' } });
    auth = { authorization: `Bearer ${res.json().accessToken}` };
  }

  return {
    app,
    services,
    config,
    auth,
    logs: () => logLines.join(''),
    async close() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

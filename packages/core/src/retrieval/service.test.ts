import { describe, expect, it } from 'vitest';
import type { DebridAddResult, DebridTorrentStatus } from '../providers/debrid/types.js';
import type { DebridProviderInfo, DebridService } from '../providers/debrid/service.js';
import { ProviderError } from '../providers/errors.js';
import type { Database } from '../db/database.js';
import { openTestDatabase } from '../testing/databases.js';
import { fakeClock } from '../testing/fake-clock.js';
import { silentLogger } from '../logging.js';
import { RetrievalService } from './service.js';

const HASH = 'a'.repeat(40);
const MAGNET = `magnet:?xt=urn:btih:${HASH}`;

interface FakeState {
  providers: DebridProviderInfo[];
  add: (sourceId: string, magnet: string) => Promise<DebridAddResult>;
  status: (sourceId: string, id: string) => Promise<DebridTorrentStatus>;
  addCalls: Array<{ sourceId: string; magnet: string }>;
  statusCalls: Array<{ sourceId: string; id: string }>;
}

function makeDebrid(overrides: Partial<FakeState> = {}): { state: FakeState; debrid: DebridService } {
  const state: FakeState = {
    providers: [{ sourceId: 'ad', name: 'AllDebrid', providerId: 'alldebrid', retrieval: true }],
    add: async () => ({ id: 'remote-1', status: 'queued' }),
    status: async () => ({ status: 'processing', progress: null }),
    addCalls: [],
    statusCalls: [],
    ...overrides,
  };
  const debrid = {
    listProviders: async () => state.providers,
    addMagnet: async (sourceId: string, magnet: string) => {
      state.addCalls.push({ sourceId, magnet });
      return state.add(sourceId, magnet);
    },
    getStatus: async (sourceId: string, id: string) => {
      state.statusCalls.push({ sourceId, id });
      return state.status(sourceId, id);
    },
  } as unknown as DebridService;
  return { state, debrid };
}

async function setup(overrides: Partial<FakeState> = {}) {
  const db: Database = await openTestDatabase();
  const { state, debrid } = makeDebrid(overrides);
  const clock = fakeClock();
  const service = new RetrievalService({ db, debrid, clock, logger: silentLogger });
  return { db, state, clock, service };
}

const input = { providerId: 'ad', magnet: MAGNET, title: 'Test Album', artist: 'Test Artist' };

describe('RetrievalService', () => {
  it('creates a job, submits the magnet and records the provider id', async () => {
    const { db, state, service } = await setup();
    const res = await service.create(1, input);

    expect(res.duplicate).toBe(false);
    expect(res.job).toMatchObject({
      providerId: 'ad',
      providerName: 'AllDebrid',
      status: 'processing',
      infohash: HASH,
      title: 'Test Album',
      artist: 'Test Artist',
    });
    expect(state.addCalls).toEqual([{ sourceId: 'ad', magnet: MAGNET }]);

    const rows = await db.all('SELECT * FROM retrieval_jobs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ remote_id: 'remote-1', status: 'processing', user_id: 1 });
  });

  it('returns an existing active job instead of resubmitting (duplicate prevention)', async () => {
    const { state, service } = await setup();
    await service.create(1, input);
    const second = await service.create(1, input);

    expect(second.duplicate).toBe(true);
    expect(second.job.status).toBe('processing');
    expect(state.addCalls).toHaveLength(1); // magnet submitted exactly once
  });

  it('marks an ambiguous submission failure as failed, without resubmitting', async () => {
    const { state, service } = await setup();
    state.add = async () => {
      throw new ProviderError('unavailable', 'network');
    };
    const res = await service.create(1, input);

    expect(res.job.status).toBe('failed');
    expect(res.job.error).toMatch(/outcome is unknown/i);
    // Recovering does not resubmit.
    await service.recover();
    expect(state.addCalls).toHaveLength(1);
  });

  it('marks a definitive submission failure with the provider message', async () => {
    const { state, service } = await setup();
    state.add = async () => {
      throw new ProviderError('auth', 'AllDebrid rejected the API key');
    };
    const res = await service.create(1, input);
    expect(res.job.status).toBe('failed');
    expect(res.job.error).toContain('rejected the API key');
  });

  it('polls to completion', async () => {
    const { state, service } = await setup();
    const created = await service.create(1, input);
    state.status = async () => ({ status: 'finished' });
    await service.tick();

    const job = await service.get(1, created.job.id);
    expect(job!.status).toBe('complete');
    expect(job!.completedAt).toBeTruthy();
  });

  it('records a provider error as failed', async () => {
    const { state, service } = await setup();
    const created = await service.create(1, input);
    state.status = async () => ({ status: 'error', message: 'TorBox could not download the torrent' });
    await service.tick();

    const job = await service.get(1, created.job.id);
    expect(job!.status).toBe('failed');
    expect(job!.error).toContain('could not download');
  });

  it('leaves the job processing on a transient poll failure', async () => {
    const { state, service } = await setup();
    const created = await service.create(1, input);
    state.status = async () => {
      throw new ProviderError('unavailable', 'network');
    };
    await service.tick();

    const job = await service.get(1, created.job.id);
    expect(job!.status).toBe('processing');
  });

  it('recovers interrupted queued jobs as failed (never resubmits)', async () => {
    const { db, state, service } = await setup();
    const now = 1_700_000_000_000;
    await db.run(
      "INSERT INTO retrieval_jobs (id, user_id, provider_id, provider_name, infohash, magnet, status, created_at, updated_at) VALUES ('j1', 1, 'ad', 'AllDebrid', ?, ?, 'queued', ?, ?)",
      [HASH, MAGNET, now, now],
    );

    await service.recover();

    const job = await service.get(1, 'j1');
    expect(job!.status).toBe('failed');
    expect(job!.error).toMatch(/interrupted/i);
    expect(state.addCalls).toHaveLength(0); // no resubmission on recovery
  });

  it('resumes polling processing jobs on recovery', async () => {
    const { db, state, service } = await setup();
    await db.run(
      "INSERT INTO retrieval_jobs (id, user_id, provider_id, provider_name, infohash, magnet, remote_id, status, created_at, updated_at) VALUES ('j2', 1, 'ad', 'AllDebrid', ?, ?, 'remote-x', 'processing', ?, ?)",
      [HASH, MAGNET, 1_700_000_000_000, 1_700_000_000_000],
    );
    state.status = async () => ({ status: 'finished' });

    await service.recover();

    const job = await service.get(1, 'j2');
    expect(job!.status).toBe('complete');
    expect(state.statusCalls.map((c) => c.id)).toContain('remote-x');
  });

  it('cancels an active job', async () => {
    const { service } = await setup();
    const created = await service.create(1, input);
    const canceled = await service.cancel(1, created.job.id);
    expect(canceled.status).toBe('canceled');
  });

  it('retries a failed job by resubmitting', async () => {
    const { state, service } = await setup();
    state.add = async () => {
      throw new ProviderError('unavailable', 'network');
    };
    const created = await service.create(1, input);
    expect(created.job.status).toBe('failed');

    state.add = async () => ({ id: 'remote-2', status: 'queued' });
    const retried = await service.retry(1, created.job.id);

    expect(retried.status).toBe('processing');
    expect(state.addCalls).toHaveLength(2);
  });

  it('rejects retrying a non-failed job', async () => {
    const { service } = await setup();
    const created = await service.create(1, input);
    await expect(service.retry(1, created.job.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('scopes jobs to the owning user', async () => {
    const { service } = await setup();
    const created = await service.create(1, input);
    await expect(service.get(2, created.job.id)).resolves.toBeUndefined();
    await expect(service.cancel(2, created.job.id)).rejects.toMatchObject({ statusCode: 404 });
    const list = await service.list(2);
    expect(list).toEqual([]);
  });
});

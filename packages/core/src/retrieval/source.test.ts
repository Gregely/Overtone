import { describe, expect, it } from 'vitest';
import type { DebridService } from '../providers/debrid/service.js';
import type { SourceFile } from '../providers/types.js';
import type { RetrievalService } from './service.js';
import { RetrievalSourceProvider } from './source.js';

const signal = new AbortController().signal;
const NOW = 1_700_000_000_000;

function makeRetrieval() {
  return {
    async completedJobs() {
      return [
        { id: 'job1', providerId: 'ad', remoteId: 'remote-1', title: 'Album', artist: 'Artist', album: 'Album' },
        { id: 'job2', providerId: 'tb', remoteId: 'remote-2', title: 'Broken', artist: null, album: null },
      ];
    },
    async getRow(id: string) {
      return id === 'job1' ? { id: 'job1', provider_id: 'ad', remote_id: 'remote-1' } : undefined;
    },
  } as unknown as RetrievalService;
}

function makeDebrid() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  return {
    calls,
    debrid: {
      async listJobFiles(sourceId: string, remoteId: string) {
        calls.push({ fn: 'listJobFiles', args: [sourceId, remoteId] });
        if (remoteId === 'remote-2') throw new Error('boom');
        return [
          { id: '0', name: '01 - One.flac', path: 'Album/01 - One.flac', size: 100 },
          { id: '1', name: 'folder.jpg', path: 'Album/folder.jpg', size: 5 },
          { id: '2', name: '02 - Two.mp3', path: 'Album/02 - Two.mp3', size: 200 },
        ];
      },
      async resolveJobFile(sourceId: string, remoteId: string, fileId: string) {
        calls.push({ fn: 'resolveJobFile', args: [sourceId, remoteId, fileId] });
        return { url: `https://cdn.example/${remoteId}/${fileId}`, expiresAt: new Date(NOW + 3600_000) };
      },
    } as unknown as DebridService,
  };
}

async function collect(it: AsyncIterable<SourceFile>): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for await (const f of it) out.push(f);
  return out;
}

describe('RetrievalSourceProvider', () => {
  it('lists only the audio files of completed jobs, with job-scoped ids', async () => {
    const { debrid } = makeDebrid();
    const provider = new RetrievalSourceProvider(makeRetrieval(), debrid);

    const files = await collect(provider.listLibrary({ signal }));

    expect(files.map((f) => [f.id, f.name, f.size])).toEqual([
      ['j:job1:0', '01 - One.flac', 100],
      ['j:job1:2', '02 - Two.mp3', 200],
    ]);
    // Non-audio (folder.jpg) is excluded; the broken job is skipped, not fatal.
    expect(files.every((f) => !f.name.endsWith('.jpg'))).toBe(true);
    expect(files[0]).toMatchObject({ mimeType: 'audio/flac' });
  });

  it('resolves a job file through the job-scoped adapter method', async () => {
    const { debrid, calls } = makeDebrid();
    const provider = new RetrievalSourceProvider(makeRetrieval(), debrid);

    const stream = await provider.resolveStream('j:job1:0', { signal });

    expect(stream).toMatchObject({ url: 'https://cdn.example/remote-1/0', redirectSafe: false, expiresAt: new Date(NOW + 3600_000) });
    expect(calls).toContainEqual({ fn: 'resolveJobFile', args: ['ad', 'remote-1', '0'] });
  });

  it('rejects files from an unknown or malformed job id', async () => {
    const { debrid } = makeDebrid();
    const provider = new RetrievalSourceProvider(makeRetrieval(), debrid);

    await expect(provider.resolveStream('not-a-job-file', { signal })).rejects.toMatchObject({ code: 'not_found' });
    await expect(provider.resolveStream('j:missing:0', { signal })).rejects.toMatchObject({ code: 'not_found' });
  });
});

/**
 * The synthetic "retrieval" source: a hidden provider whose `listLibrary`
 * yields only the audio files of Overtone-created retrieval jobs (never a
 * whole debrid account), and whose `resolveStream` resolves one job file to a
 * direct link via the job-scoped adapter method.
 *
 * Files are identified as `j:<jobId>:<fileId>` so resolution can recover the
 * job (and thus the provider + remote id) without a full account scan, and the
 * library keeps a stable, deduplicable id per (job, file).
 */
import { audioMimeType, isAudioFile } from '@overtone/shared';
import { parseFilename } from '../metadata/matcher/filename.js';
import type { DebridService } from '../providers/debrid/service.js';
import { ProviderError } from '../providers/errors.js';
import type { ListOptions, ProviderPlugin, ResolveOptions, ResolvedStream, SourceFile, SourceProvider } from '../providers/types.js';
import { RETRIEVAL_SOURCE_ID, type RetrievalService } from './service.js';

const FILE_ID_RE = /^j:([^:]+):([\s\S]+)$/;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class RetrievalSourceProvider implements SourceProvider {
  constructor(
    private readonly retrieval: RetrievalService,
    private readonly debrid: DebridService,
  ) {}

  async *listLibrary(opts: ListOptions): AsyncIterable<SourceFile> {
    for (const job of await this.retrieval.completedJobs()) {
      opts.signal.throwIfAborted();
      let files;
      try {
        files = await this.debrid.listJobFiles(job.providerId, job.remoteId);
      } catch {
        continue; // one broken/removed job must not block the rest
      }
      for (const f of files) {
        opts.signal.throwIfAborted();
        if (!isAudioFile(f.name)) continue;
        const mime = audioMimeType(f.name);
        yield {
          id: `j:${job.id}:${f.id}`,
          name: f.name,
          path: f.path || `${job.title || job.album || 'Retrieved'}/${f.name}`,
          size: f.size,
          ...(mime ? { mimeType: mime } : {}),
          // Filename tags let the scanner skip the (slower) remote-tag probe.
          tags: parseFilename(f.path || f.name),
        };
      }
    }
  }

  async resolveStream(fileId: string, opts: ResolveOptions): Promise<ResolvedStream> {
    const m = FILE_ID_RE.exec(fileId);
    if (!m) throw new ProviderError('not_found', 'Unknown retrieved file');
    const [, jobId, innerId] = m;
    const job = await this.retrieval.getRow(jobId!);
    if (!job || !job.remote_id) throw new ProviderError('not_found', 'Retrieval job no longer exists');
    const link = await this.debrid.resolveJobFile(job.provider_id, job.remote_id, innerId!);
    return {
      url: link.url,
      redirectSafe: false, // debrid links carry credentials / are IP-bound
      expiresAt: link.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS),
      ...(link.headers ? { headers: link.headers } : {}),
      ...(link.mimeType ? { mimeType: link.mimeType } : {}),
      ...(link.size !== undefined ? { size: link.size } : {}),
    };
  }
}

export function createRetrievalPlugin(retrieval: RetrievalService, debrid: DebridService): ProviderPlugin {
  return {
    manifest: {
      id: RETRIEVAL_SOURCE_ID,
      name: 'Retrieved',
      description: 'Files retrieved through Overtone',
      category: 'debrid',
      hidden: true,
      configSchema: { fields: [] },
      capabilities: { redirectable: false },
    },
    create: () => new RetrievalSourceProvider(retrieval, debrid),
  };
}

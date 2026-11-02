import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { audioMimeType } from '@overtone/shared';
import { ProviderError, type BaseLogger, type ResolveCache, type ResolvedStream, type SourceFileRow, type SourceManager } from '@overtone/core';
import { parseRange } from './range.js';

/** Content types that are never audio: an error document from the source. */
const NOT_AUDIO = /^(text\/|application\/(json|xml|problem\+json|xhtml\+xml))/i;

/** Any upstream error except "range not satisfiable", or a non-audio body. */
function failed(res: Response): boolean {
  if (res.status === 416) return false;
  if (!res.ok) return true;
  return NOT_AUDIO.test(res.headers.get('content-type') ?? '');
}

/** Response headers relayed from upstream when proxying. Everything else is dropped. */
const RELAY_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

export interface StreamServiceDeps {
  sources: SourceManager;
  resolver: ResolveCache;
  logger: BaseLogger;
  /** Fetch used for proxying (injectable for tests). */
  fetch?: typeof fetch;
}

export class StreamService {
  constructor(private readonly d: StreamServiceDeps) {}

  async serve(file: SourceFileRow, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const source = await this.d.sources.require(file.source_id);
    const provider = await this.d.sources.instance(source.id);
    const signal = abortOnClose(reply);
    const resolve = (forceRefresh: boolean) =>
      this.d.resolver.resolve(source.id, provider, file.file_id, { signal, ...(forceRefresh ? { forceRefresh } : {}) });

    let stream = await resolve(false);
    const fallbackMime = stream.mimeType ?? file.mime ?? audioMimeType(file.name) ?? 'application/octet-stream';

    if (stream.url.startsWith('file:')) return this.#serveFile(stream, fallbackMime, req, reply);

    if (source.stream_mode === 'redirect' && stream.redirectSafe && !stream.headers) {
      return reply.code(302).header('cache-control', 'no-store').header('location', stream.url).send();
    }

    // A failed or non-audio response means the link died (expired, IP-bound,
    // revoked) or the source answered with an error document: resolve a fresh
    // link once and retry, then give up with a clear message.
    let upstream = await this.#fetchUpstream(stream, req, signal);
    if (failed(upstream)) {
      await upstream.body?.cancel();
      this.d.resolver.invalidate(source.id, file.file_id);
      stream = await resolve(true);
      upstream = await this.#fetchUpstream(stream, req, signal);
    }
    if (upstream.status === 416) {
      await upstream.body?.cancel();
      return reply.code(416).header('content-range', upstream.headers.get('content-range') ?? 'bytes */*').send();
    }
    if (failed(upstream) || !upstream.body) {
      await upstream.body?.cancel();
      this.d.resolver.invalidate(source.id, file.file_id);
      const status = upstream.status;
      const why = !upstream.ok
        ? `HTTP ${status}`
        : `an error page instead of audio (${upstream.headers.get('content-type')?.split(';')[0] ?? 'unknown type'})`;
      const code = status === 404 || status === 410 ? 'not_found' : status === 401 || status === 403 ? 'auth' : 'unavailable';
      throw new ProviderError(code, `"${source.name}" couldn't stream this file: it returned ${why}, even after getting a fresh link.`);
    }

    reply.code(upstream.status === 206 ? 206 : 200);
    for (const h of RELAY_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) reply.header(h, v);
    }
    const ct = upstream.headers.get('content-type');
    if (!ct || ct.startsWith('application/octet-stream') || ct.startsWith('binary/')) reply.header('content-type', fallbackMime);
    if (!upstream.headers.get('accept-ranges')) reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'private, no-transform');
    return reply.send(Readable.fromWeb(upstream.body as never));
  }

  async #fetchUpstream(stream: ResolvedStream, req: FastifyRequest, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { ...(stream.headers ?? {}) };
    if (typeof req.headers.range === 'string') headers.range = req.headers.range;
    if (typeof req.headers['if-range'] === 'string') headers['if-range'] = req.headers['if-range'];
    return (this.d.fetch ?? fetch)(stream.url, { headers, signal, redirect: 'follow' });
  }

  async #serveFile(stream: ResolvedStream, mime: string, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const filePath = fileURLToPath(stream.url);
    const s = await stat(filePath).catch(() => null);
    if (!s?.isFile()) throw new ProviderError('not_found', 'File not found');
    const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, s.size);
    reply
      .header('accept-ranges', 'bytes')
      .header('content-type', mime)
      .header('last-modified', s.mtime.toUTCString())
      .header('cache-control', 'private, max-age=3600');
    if (range === null) return reply.code(416).header('content-range', `bytes */${s.size}`).send();
    if (range === undefined) {
      reply.code(200).header('content-length', s.size);
      if (req.method === 'HEAD') return reply.send();
      return reply.send(createReadStream(filePath));
    }
    reply
      .code(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${s.size}`)
      .header('content-length', range.end - range.start + 1);
    if (req.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(filePath, { start: range.start, end: range.end }));
  }
}

/** Abort upstream work when the client disconnects (seeking creates many short requests). */
function abortOnClose(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  reply.raw.once('close', () => ac.abort());
  return ac.signal;
}

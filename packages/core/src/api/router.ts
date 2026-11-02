/**
 * In-process router for standalone mode: the same REST paths the server
 * exposes, dispatched straight to CoreApi. The web app's EmbeddedTransport
 * sends every request here instead of over the network, so the UI can't tell
 * the difference.
 *
 * Inputs are checked like the server's JSON schemas (types, ranges, unknown
 * body fields), so a request that fails on the server also fails here.
 * Standalone has a single local user and no login, so there are no auth
 * routes beyond `/api/me` and `/api/auth/status`.
 */
import type {
  AuthStatusDto,
  FileMatchRequestDto,
  LibraryImportRequestDto,
  MatchStatus,
  SourceWriteDto,
  StreamUrlsRequestDto,
  StreamUrlsResponseDto,
  CreateRetrievalJobRequestDto,
  DiscoverRequestDto,
  DiscoveryPreferencesDto,
  TorrentSourceWriteDto,
  UserDto,
} from '@overtone/shared';
import type { OvertoneCore } from '../core.js';
import { ApiError } from '../errors.js';
import type { ViewContext } from '../library/repo.js';
import { exportLibrary, importLibrary, libraryInfo } from '../library/backup.js';

export interface EmbeddedRequest {
  method: string;
  /** Path with optional query string, e.g. "/api/library/albums?q=x&limit=60". */
  path: string;
  body?: unknown;
}

export interface EmbeddedResponse {
  status: number;
  body: unknown;
}

export interface EmbeddedRouterOptions {
  version: string;
  /** Cover URL for a release (EmbeddedTransport turns these into image URLs). */
  coverUrl: ViewContext['coverUrl'];
  /** Database file size, for Settings › Library. */
  databaseBytes?: () => Promise<number | null>;
  /** Called after an import or reset (e.g. to restart background work). */
  onLibraryReplaced?: () => Promise<void>;
}

/** The single standalone user. Standalone has no accounts; this keeps the UI's admin features on. */
export const LOCAL_USER: UserDto = { id: 1, username: 'You', isAdmin: true };

type Handler = (p: { params: string[]; query: URLSearchParams; body: unknown }) => Promise<unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  status?: number;
}

const MATCH_STATUSES: readonly MatchStatus[] = ['pending', 'matched', 'needs_review', 'unmatched', 'manual'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createEmbeddedRouter(core: OvertoneCore, opts: EmbeddedRouterOptions) {
  const api = core.api;
  const view: ViewContext = { coverUrl: opts.coverUrl, categoryOf: api.categoryOf };
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, status?: number) => {
    const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    routes.push({ method, pattern, handler, ...(status ? { status } : {}) });
  };

  // ── app / "auth" ─────────────────────────────────────────────────────────
  add('GET', '/api/health', async () => ({ ok: true, version: opts.version }));
  add('GET', '/api/auth/status', async (): Promise<AuthStatusDto> => ({ setupRequired: false, multiUser: false, version: opts.version }));
  add('GET', '/api/me', async () => LOCAL_USER);

  // ── library ──────────────────────────────────────────────────────────────
  add('GET', '/api/library/home', async () => api.home(view));
  add('GET', '/api/library/artists', async ({ query }) => api.artists(pageQuery(query)));
  add('GET', '/api/library/artists/:id', async ({ params }) => api.artist(idParam(params[0]), view));
  add('GET', '/api/library/albums', async ({ query }) => api.albums(pageQuery(query), view));
  add('GET', '/api/library/albums/:id', async ({ params }) => api.album(idParam(params[0]), view));
  add('GET', '/api/library/tracks', async ({ query }) => api.tracks(pageQuery(query), view));
  add('GET', '/api/library/tracks/:id', async ({ params }) => api.track(idParam(params[0]), view));
  add('GET', '/api/search', async ({ query }) => api.search(str(query, 'q', 200) ?? '', view));

  add('POST', '/api/stream-urls', async ({ body }) => {
    const b = object<StreamUrlsRequestDto>(body, ['trackIds', 'preferSourceId', 'refresh'], ['trackIds']);
    return resolveStreams(core, intArray(b.trackIds, 'trackIds'), b.preferSourceId ? String(b.preferSourceId) : undefined, b.refresh ? intArray(b.refresh, 'refresh') : []);
  });

  // ── matching ─────────────────────────────────────────────────────────────
  add('GET', '/api/library/files', async ({ query }) => {
    const status = query.get('status') ?? undefined;
    if (status && !MATCH_STATUSES.includes(status as MatchStatus)) throw ApiError.badRequest('querystring/status must be equal to one of the allowed values');
    return api.listFiles({
      ...(status ? { status: status as MatchStatus } : {}),
      ...optional('sourceId', query.get('sourceId') ?? undefined),
      ...optional('trackId', int(query, 'trackId')),
      ...optional('offset', int(query, 'offset', 0)),
      ...optional('limit', int(query, 'limit', 1, 500)),
    });
  });
  add('GET', '/api/library/files/:id', async ({ params }) => api.file(idParam(params[0])));
  add('GET', '/api/library/files/:id/candidates', async ({ params, query }) =>
    api.candidates(idParam(params[0]), { ...optional('title', str(query, 'title', 300)), ...optional('artist', str(query, 'artist', 300)) }),
  );
  add('POST', '/api/library/files/:id/match', async ({ params, body }) => {
    const b = object<FileMatchRequestDto>(body, ['recordingMbid', 'releaseMbid'], ['recordingMbid']);
    if (!UUID.test(String(b.recordingMbid)) || (b.releaseMbid !== undefined && !UUID.test(String(b.releaseMbid)))) {
      throw ApiError.badRequest('body/recordingMbid must match format "uuid"');
    }
    return api.matchFile(idParam(params[0]), b);
  });
  add('POST', '/api/library/files/:id/rematch', async ({ params }) => api.rematch(idParam(params[0])));
  add('GET', '/api/match/releases', async ({ query }) => {
    const q = str(query, 'q', 300);
    if (!q) throw ApiError.badRequest("querystring must have required property 'q'");
    return api.releaseCandidates(q, str(query, 'artist', 300));
  });
  add('POST', '/api/library/albums/:id/match', async ({ params, body }) => {
    const b = object<{ releaseMbid: string }>(body, ['releaseMbid'], ['releaseMbid']);
    if (!UUID.test(String(b.releaseMbid))) throw ApiError.badRequest('body/releaseMbid must match format "uuid"');
    return api.matchAlbum(idParam(params[0]), b.releaseMbid, view);
  });

  // ── sources ──────────────────────────────────────────────────────────────
  const writeKeys = ['providerId', 'name', 'enabled', 'priority', 'streamMode', 'config', 'deviceLogin'];
  add('GET', '/api/providers', async () => api.providers());
  add('GET', '/api/sources', async () => api.listSources());
  add('GET', '/api/sources/:id', async ({ params }) => api.source(params[0]!));
  add('POST', '/api/sources', async ({ body }) => api.createSource(object<SourceWriteDto>(body, writeKeys, ['providerId']), LOCAL_USER.id), 201);
  add('PATCH', '/api/sources/:id', async ({ params, body }) => api.updateSource(params[0]!, object<SourceWriteDto>(body, writeKeys), LOCAL_USER.id));
  add('DELETE', '/api/sources/:id', async ({ params }) => api.deleteSource(params[0]!), 204);
  add('POST', '/api/providers/:providerId/test', async ({ params, body }) =>
    api.testProvider(params[0]!, object(body ?? {}, ['config', 'deviceLogin']), LOCAL_USER.id),
  );
  add('POST', '/api/providers/:providerId/device-login', async ({ params }) => api.startDeviceLogin(params[0]!, LOCAL_USER.id));
  add('GET', '/api/device-login/:flowId', async ({ params }) => api.pollDeviceLogin(params[0]!, LOCAL_USER.id));
  add('POST', '/api/sources/:id/test', async ({ params, body }) => api.testSource(params[0]!, object(body ?? {}, ['config', 'deviceLogin']), LOCAL_USER.id));
  add('POST', '/api/sources/:id/scan', async ({ params }) => api.scanSource(params[0]!), 202);
  add('POST', '/api/scan', async () => api.scanAll(), 202);
  add('GET', '/api/scan/status', async () => api.scanStatus());

  // ── torrent sources ("Find sources") ─────────────────────────────────────
  const torrentKeys = ['kind', 'name', 'enabled', 'url', 'apiKey', 'indexers'];
  add('GET', '/api/torrent-sources', async () => api.listTorrentSources());
  add('GET', '/api/torrent-sources/:id', async ({ params }) => api.torrentSource(params[0]!));
  add('POST', '/api/torrent-sources', async ({ body }) => api.createTorrentSource(object<TorrentSourceWriteDto>(body, torrentKeys, ['kind'])), 201);
  add('PATCH', '/api/torrent-sources/:id', async ({ params, body }) => api.updateTorrentSource(params[0]!, object<TorrentSourceWriteDto>(body, torrentKeys)));
  add('DELETE', '/api/torrent-sources/:id', async ({ params }) => api.deleteTorrentSource(params[0]!), 204);
  add('POST', '/api/torrent-sources/test', async ({ body }) => api.testTorrentSource(undefined, object<TorrentSourceWriteDto>(body, torrentKeys, ['kind'])));
  add('POST', '/api/torrent-sources/:id/test', async ({ params, body }) => api.testTorrentSource(params[0]!, object<TorrentSourceWriteDto>(body, torrentKeys)));

  add('POST', '/api/discover', async ({ body }) => api.discover(object<DiscoverRequestDto>(body, ['trackId', 'albumId', 'query', 'type', 'limit']), LOCAL_USER.id));

  // ── MusicBrainz catalogue ────────────────────────────────────────────────
  add('GET', '/api/catalogue/search', async ({ query }) => api.catalogueSearch(str(query, 'q', 200) ?? ''));
  add('GET', '/api/catalogue/artists/:mbid', async ({ params }) => api.catalogueArtist(params[0]!));
  add('GET', '/api/catalogue/releases/:mbid', async ({ params }) => api.catalogueRelease(params[0]!));
  add('POST', '/api/catalogue/play', async ({ body }) => api.playCatalogue(String((body as { releaseGroupMbid?: unknown })?.releaseGroupMbid ?? ''), LOCAL_USER.id));

  // ── discovery preferences ────────────────────────────────────────────────
  const PREF_KEYS = ['preferredFormat', 'minBitrateKbps', 'preferredProvider', 'rememberLastProvider', 'prioritizeCached', 'hideUncached', 'searchScope'];
  add('GET', '/api/preferences', async () => api.getPreferences(LOCAL_USER.id));
  add('PUT', '/api/preferences', async ({ body }) => api.setPreferences(LOCAL_USER.id, object<DiscoveryPreferencesDto>(body, PREF_KEYS)));

  // ── debrid retrieval jobs ("add to debrid") ──────────────────────────────
  add('GET', '/api/debrid/providers', async () => api.listDebridProviders());
  add('GET', '/api/retrieval/jobs', async () => api.listRetrievalJobs(LOCAL_USER.id));
  add('GET', '/api/retrieval/jobs/:id', async ({ params }) => api.getRetrievalJob(LOCAL_USER.id, params[0]!));
  add('GET', '/api/retrieval/jobs/:id/files', async ({ params }) => api.retrievalJobFiles(LOCAL_USER.id, params[0]!, view));
  add('POST', '/api/retrieval/jobs', async ({ body }) =>
    api.createRetrievalJob(LOCAL_USER.id, object<CreateRetrievalJobRequestDto>(body, ['providerId', 'magnet', 'title', 'artist', 'album', 'year', 'size'], ['providerId', 'magnet'])), 201);
  add('POST', '/api/retrieval/jobs/:id/cancel', async ({ params }) => api.cancelRetrievalJob(LOCAL_USER.id, params[0]!));
  add('POST', '/api/retrieval/jobs/:id/retry', async ({ params }) => api.retryRetrievalJob(LOCAL_USER.id, params[0]!));

  // ── standalone only: Settings › Library ──────────────────────────────────
  add('GET', '/api/library/info', async () => libraryInfo(core, opts.databaseBytes));
  add('POST', '/api/library/reset', async () => {
    await core.library.resetLibrary();
    await core.covers.forgetAll();
    await opts.onLibraryReplaced?.();
    return libraryInfo(core, opts.databaseBytes);
  });
  add('POST', '/api/library/export', async ({ body }) => {
    const b = object<{ passphrase?: string }>(body ?? {}, ['passphrase']);
    return exportLibrary(core, b.passphrase ? { passphrase: String(b.passphrase) } : {});
  });
  add('POST', '/api/library/import', async ({ body }) => {
    const b = object<LibraryImportRequestDto>(body, ['file', 'passphrase'], ['file']);
    const result = await importLibrary(core, b.file, b.passphrase ? { passphrase: String(b.passphrase) } : {});
    await opts.onLibraryReplaced?.();
    return result;
  });

  return async function handle(req: EmbeddedRequest): Promise<EmbeddedResponse> {
    const [pathname, search = ''] = req.path.split('?', 2) as [string, string?];
    const method = req.method.toUpperCase();
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = m.slice(1).map((p) => decodeURIComponent(p));
      const body = await r.handler({ params, query: new URLSearchParams(search), body: req.body });
      return { status: r.status ?? 200, body: r.status === 204 ? undefined : body };
    }
    if (pathMatched) throw new ApiError(405, 'method_not_allowed', `${method} is not supported here`);
    throw new ApiError(404, 'not_found', `No route for ${method} ${pathname}`);
  };
}

/**
 * Stream links in standalone mode: the provider's own link, resolved on this
 * device (through the shared ResolveCache) and handed to the player directly.
 * There's no proxy and no stream token. `refresh` lists tracks whose previous
 * link failed, which are resolved again instead of reused.
 */
export async function resolveStreams(core: OvertoneCore, trackIds: number[], preferSourceId?: string, refresh: number[] = []): Promise<StreamUrlsResponseDto> {
  const { picks, unavailable } = await core.api.pickSources(trackIds, preferSourceId);
  const out: StreamUrlsResponseDto = { items: [], unavailable: [...unavailable] };
  const again = new Set(refresh);
  for (const { trackId, pick } of picks) {
    try {
      const target = await core.library.streamTarget(pick.sourceFileId);
      if (!target) throw ApiError.notFound('Track file');
      const provider = await core.sources.instance(pick.sourceId);
      const forceRefresh = again.has(trackId);
      if (forceRefresh) core.resolver.invalidate(pick.sourceId, target.file.file_id);
      const stream = await core.resolver.resolve(pick.sourceId, provider, target.file.file_id, {
        signal: AbortSignal.timeout(30_000),
        ...(forceRefresh ? { forceRefresh } : {}),
      });
      out.items.push({
        trackId,
        url: stream.url,
        ...(stream.headers && Object.keys(stream.headers).length ? { headers: stream.headers } : {}),
        expiresAt: (stream.expiresAt ?? new Date(core.clock.now() + 10 * 60_000)).toISOString(),
        mimeType: stream.mimeType ?? pick.mime,
        source: { sourceId: pick.sourceId, sourceName: pick.sourceName, providerId: pick.providerId, category: core.api.categoryOf(pick.providerId) },
      });
    } catch (err) {
      // One broken source shouldn't fail the whole batch; the player skips it with a notice.
      if (trackIds.length === 1) throw err;
      out.unavailable.push(trackId);
    }
  }
  return out;
}

// ── input checks (mirroring the server's JSON schemas) ─────────────────────

function idParam(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw ApiError.badRequest('params/id must be >= 1');
  return n;
}

function int(q: URLSearchParams, key: string, min?: number, max?: number): number | undefined {
  const raw = q.get(key);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw ApiError.badRequest(`querystring/${key} must be integer`);
  if (min !== undefined && n < min) throw ApiError.badRequest(`querystring/${key} must be >= ${min}`);
  if (max !== undefined && n > max) throw ApiError.badRequest(`querystring/${key} must be <= ${max}`);
  return n;
}

function str(q: URLSearchParams, key: string, maxLength: number): string | undefined {
  const v = q.get(key);
  if (v === null) return undefined;
  if (v.length > maxLength) throw ApiError.badRequest(`querystring/${key} must NOT have more than ${maxLength} characters`);
  return v;
}

function pageQuery(q: URLSearchParams) {
  return {
    ...optional('offset', int(q, 'offset', 0)),
    ...optional('limit', int(q, 'limit', 1, 500)),
    ...optional('q', str(q, 'q', 200)),
    ...optional('sort', q.get('sort') ?? undefined),
    ...optional('artistId', int(q, 'artistId', 1)),
  };
}

function optional<K extends string, V>(key: K, v: V | undefined): Partial<Record<K, V>> {
  return v === undefined ? {} : ({ [key]: v } as Record<K, V>);
}

function object<T>(body: unknown, allowed: string[], required: string[] = []): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw ApiError.badRequest('body must be object');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw ApiError.badRequest('body must NOT have additional properties');
  for (const k of required) if ((body as Record<string, unknown>)[k] === undefined) throw ApiError.badRequest(`body must have required property '${k}'`);
  return body as T;
}

function intArray(v: unknown, key: string): number[] {
  if (!Array.isArray(v) || v.length > 500 || !v.every((x) => Number.isInteger(x) && x >= 1)) {
    throw ApiError.badRequest(`body/${key} must be an array of positive integers`);
  }
  return v as number[];
}

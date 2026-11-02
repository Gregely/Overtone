/**
 * The operations behind Overtone's REST API, independent of HTTP. The
 * Fastify server (server mode) and the EmbeddedTransport (standalone mode)
 * both call these, so both modes behave the same for the same data.
 *
 * Callers validate/parse their inputs (Fastify JSON schemas on the server,
 * the embedded router's parsers on the device); this layer enforces domain
 * rules and throws ApiError for anything the user did wrong.
 */
import type {
  AlbumDetailDto,
  CatalogueArtistDetailDto,
  CatalogueReleaseDto,
  CatalogueSearchResultDto,
  ConnectionTestResultDto,
  CreateRetrievalJobRequestDto,
  CreateRetrievalJobResultDto,
  DeviceFlowPollDto,
  DeviceFlowStartDto,
  DebridProviderDto,
  DiscoverRequestDto,
  DiscoverResponseDto,
  DiscoverScope,
  DiscoveryPreferencesDto,
  FileMatchRequestDto,
  LibraryFileDto,
  MatchCandidateDto,
  MatchStatus,
  PlayCatalogueResultDto,
  ReleaseCandidateDto,
  RetrievalJobDto,
  RetrievalJobFileDto,
  RetrievalJobFilesDto,
  ScanStatusDto,
  SourceDto,
  SourceWriteDto,
  TorrentSourceDto,
  TorrentSourceTestResultDto,
  TorrentSourceWriteDto,
  TrackDto,
} from '@overtone/shared';
import { ApiError } from '../errors.js';
import { isAudioFile } from '@overtone/shared';
import type { AlbumSort, DiscoveryMetadata, LibraryRepo, PlayableSource, SourceFileRow, ViewContext } from '../library/repo.js';
import { toCandidateDto } from '../library/repo.js';
import type { LibraryScanner, MatchWorker } from '../library/scanner.js';
import type { CoverArtService } from '../metadata/coverart/service.js';
import type { Matcher } from '../metadata/matcher/matcher.js';
import { luceneEscape } from '../metadata/musicbrainz/client.js';
import type { MusicBrainzApi } from '../metadata/musicbrainz/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { FileTags } from '../providers/types.js';
import type { TorrentSourceManager } from '../discovery/manager.js';
import type { DiscoveryService } from '../discovery/service.js';
import type { DiscoveryTarget } from '../discovery/query-builder.js';
import { bestCachedCandidate, cachedProvider, magnetOf } from '../discovery/source-matcher.js';
import type { DebridService } from '../providers/debrid/service.js';
import type { RetrievalService } from '../retrieval/service.js';
import { RETRIEVAL_SOURCE_ID } from '../retrieval/service.js';
import type { PreferencesService } from '../preferences.js';
import type { DeviceLoginService } from '../sources/device-login.js';
import type { SourceManager } from '../sources/manager.js';

export interface CoreApiDeps {
  registry: ProviderRegistry;
  sources: SourceManager;
  torrentSources: TorrentSourceManager;
  discovery: DiscoveryService;
  debrid: DebridService;
  retrieval: RetrievalService;
  preferences: PreferencesService;
  deviceLogins: DeviceLoginService;
  library: LibraryRepo;
  mb: MusicBrainzApi;
  matcher: Matcher;
  scanner: LibraryScanner;
  matchWorker: MatchWorker;
  covers: CoverArtService;
}

export interface PageQuery {
  offset?: number;
  limit?: number;
  q?: string;
  sort?: string;
  artistId?: number;
}

const ALBUM_SORTS = ['name', 'recent', 'year', 'artist', 'random'] as const;
const TRACK_SORTS = ['name', 'recent', 'artist'] as const;

export class CoreApi {
  constructor(private readonly s: CoreApiDeps) {}

  categoryOf = (providerId: string) => this.s.registry.get(providerId)?.manifest.category ?? 'server';

  // ── Library ──────────────────────────────────────────────────────────────

  home(view: ViewContext) {
    return this.s.library.home(view);
  }

  artists(q: PageQuery) {
    const { offset, limit, q: text } = q;
    return this.s.library.listArtists({ ...defined({ offset, limit, q: text }) });
  }

  async artist(id: number, view: ViewContext) {
    const a = await this.s.library.getArtist(id, view);
    if (!a) throw ApiError.notFound('Artist');
    return a;
  }

  albums(q: PageQuery, view: ViewContext) {
    const { sort: rawSort, ...rest } = q;
    const sort = ALBUM_SORTS.find((x) => x === rawSort) as AlbumSort | undefined;
    return this.s.library.listAlbums({ ...defined(rest), ...(sort ? { sort } : {}) }, view);
  }

  async album(id: number, view: ViewContext) {
    const a = await this.s.library.getAlbum(id, view);
    if (!a) throw ApiError.notFound('Album');
    return a;
  }

  tracks(q: PageQuery, view: ViewContext) {
    const { sort: rawSort, artistId: _artistId, ...rest } = q;
    const sort = TRACK_SORTS.find((x) => x === rawSort);
    return this.s.library.listTracks({ ...defined(rest), ...(sort ? { sort } : {}) }, view);
  }

  async track(id: number, view: ViewContext): Promise<TrackDto> {
    const [t] = await this.s.library.getTracks([id], view);
    if (!t) throw ApiError.notFound('Track');
    return t;
  }

  search(q: string, view: ViewContext) {
    return this.s.library.search(q, view);
  }

  /** Which file to play for each track (best-priority enabled source, or the preferred one). */
  async pickSources(trackIds: number[], preferSourceId?: string): Promise<{ picks: Array<{ trackId: number; pick: PlayableSource }>; unavailable: number[] }> {
    const picks: Array<{ trackId: number; pick: PlayableSource }> = [];
    const unavailable: number[] = [];
    for (const trackId of trackIds) {
      const options = await this.s.library.playableSources(trackId);
      const pick = options.find((o) => o.sourceId === preferSourceId) ?? options[0];
      if (pick) picks.push({ trackId, pick });
      else unavailable.push(trackId);
    }
    return { picks, unavailable };
  }

  // ── Matching ("fix match") ───────────────────────────────────────────────

  listFiles(q: { status?: MatchStatus; sourceId?: string; trackId?: number; offset?: number; limit?: number }) {
    return this.s.library.listFiles(q);
  }

  async file(id: number): Promise<LibraryFileDto> {
    const f = await this.s.library.fileDto(id);
    if (!f) throw ApiError.notFound('File');
    return f;
  }

  async #requireFile(id: number): Promise<SourceFileRow> {
    const file = await this.s.library.getFile(id);
    if (!file) throw ApiError.notFound('File');
    return file;
  }

  /** Search MusicBrainz for a file; results are scored against the file's tags. */
  async candidates(id: number, q: { title?: string; artist?: string }): Promise<MatchCandidateDto[]> {
    const file = await this.#requireFile(id);
    const tags: FileTags = file.tags_json ? JSON.parse(file.tags_json) : {};
    const search: FileTags = { ...tags };
    if (q.title) search.title = q.title;
    if (q.artist) search.artist = q.artist;
    const result = await this.s.matcher.matchOne({ key: file.id, path: file.path, tags: search }, new Set(), 25);
    return result.candidates.map(toCandidateDto);
  }

  async matchFile(id: number, body: FileMatchRequestDto): Promise<LibraryFileDto | null> {
    const file = await this.#requireFile(id);
    const tags: FileTags = file.tags_json ? JSON.parse(file.tags_json) : {};
    const pinned: FileTags = {
      ...tags,
      musicbrainz: { recordingId: body.recordingMbid, ...(body.releaseMbid ? { releaseId: body.releaseMbid } : {}) },
    };
    const r = await this.s.matcher.matchGroup([{ key: file.id, path: file.path, tags: pinned }]);
    const result = r.get(file.id);
    if (!result?.best) throw ApiError.badRequest('Recording not found on MusicBrainz');
    if (body.releaseMbid && result.best.release?.mbid !== body.releaseMbid) {
      throw ApiError.badRequest('That recording is not on the selected release');
    }
    await this.s.library.applyMatch(file.id, 'manual', 1, result.best, result.candidates);
    await this.s.library.cleanupOrphans();
    return this.s.library.fileDto(file.id);
  }

  async rematch(id: number): Promise<LibraryFileDto | null> {
    await this.#requireFile(id);
    await this.s.library.resetMatch(id);
    this.s.matchWorker.kick();
    return this.s.library.fileDto(id);
  }

  async releaseCandidates(q: string, artist?: string): Promise<ReleaseCandidateDto[]> {
    const parts = [`release:(${luceneEscape(q)})`];
    if (artist) parts.push(`artist:(${luceneEscape(artist)})`);
    const refs = await this.s.mb.searchReleases(parts.join(' AND '), 25);
    return refs.map((r) => ({
      mbid: r.id,
      title: r.title,
      artistCredit: r.credit?.text ?? '',
      date: r.date,
      country: r.country,
      trackCount: r.trackCount,
      primaryType: r.releaseGroup?.primaryType ?? null,
      status: r.status,
    }));
  }

  /** Re-match every file of an album to a chosen MusicBrainz release. */
  async matchAlbum(albumId: number, releaseMbid: string, view: ViewContext): Promise<AlbumDetailDto> {
    const files = await this.s.library.releaseFileRows(albumId);
    if (!files.length) throw ApiError.notFound('Album');
    const release = await this.s.mb.getRelease(releaseMbid);
    if (!release?.tracks.length) throw ApiError.badRequest('Release not found on MusicBrainz');
    const inputs = files.map((f) => ({ key: f.id, path: f.path, tags: (f.tags_json ? JSON.parse(f.tags_json) : {}) as FileTags }));
    const results = this.s.matcher.assignToRelease(inputs, release);
    let firstTrackId: number | null = null;
    for (const input of inputs) {
      const r = results.get(input.key);
      if (!r?.candidates[0]) continue;
      await this.s.library.applyMatch(input.key, 'manual', r.candidates[0].score, r.candidates[0], r.candidates);
      firstTrackId ??= (await this.s.library.getFile(input.key))?.track_id ?? null;
    }
    await this.s.library.cleanupOrphans();
    await this.s.covers.forget(albumId);
    const newAlbumId = firstTrackId ? (await this.s.library.getTracks([firstTrackId], view))[0]?.album?.id : undefined;
    const detail = newAlbumId ? await this.s.library.getAlbum(newAlbumId, view) : null;
    if (!detail) throw ApiError.notFound('Album');
    return detail;
  }

  // ── Sources ──────────────────────────────────────────────────────────────

  providers() {
    return this.s.registry.toDtos();
  }

  async listSources(): Promise<SourceDto[]> {
    return Promise.all(
      (await this.s.sources.list())
        .filter((r) => !this.s.registry.get(r.provider_id)?.manifest.hidden)
        .map((r) => this.s.sources.toDto(r)),
    );
  }

  async source(id: string): Promise<SourceDto> {
    return this.s.sources.toDto(await this.s.sources.require(id));
  }

  #loginSecrets(deviceLogin: string | undefined, userId: number, providerId: string, consume: boolean) {
    return deviceLogin ? this.s.deviceLogins.credentials(deviceLogin, providerId, userId, consume) : undefined;
  }

  async createSource(body: SourceWriteDto, userId: number): Promise<SourceDto> {
    if (this.s.registry.get(body.providerId ?? '')?.manifest.hidden) throw ApiError.validation({ providerId: 'Unknown provider' });
    const device = this.#loginSecrets(body.deviceLogin, userId, body.providerId!, false);
    const row = await this.s.sources.create(body, device);
    if (body.deviceLogin) this.#loginSecrets(body.deviceLogin, userId, row.provider_id, true);
    return this.s.sources.toDto(row);
  }

  async updateSource(id: string, body: SourceWriteDto, userId: number): Promise<SourceDto> {
    const current = await this.s.sources.require(id);
    if (this.s.registry.get(current.provider_id)?.manifest.hidden) throw ApiError.badRequest('This source is managed by Overtone');
    const device = this.#loginSecrets(body.deviceLogin, userId, current.provider_id, false);
    const row = await this.s.sources.update(id, body, device);
    if (body.deviceLogin) this.#loginSecrets(body.deviceLogin, userId, row.provider_id, true);
    return this.s.sources.toDto(row);
  }

  async deleteSource(id: string): Promise<void> {
    const row = await this.s.sources.require(id);
    if (this.s.registry.get(row.provider_id)?.manifest.hidden) throw ApiError.badRequest('This source is managed by Overtone');
    return this.s.sources.delete(id);
  }

  /** Test an unsaved config ("Test connection" in the add-source form). */
  testProvider(providerId: string, body: { config?: Record<string, unknown>; deviceLogin?: string }, userId: number): Promise<ConnectionTestResultDto> {
    return this.s.sources.test(providerId, body.config ?? {}, undefined, this.#loginSecrets(body.deviceLogin, userId, providerId, false));
  }

  /** Test a saved source, optionally with edited (unsaved) fields; stored secrets fill the gaps. */
  async testSource(id: string, body: { config?: Record<string, unknown>; deviceLogin?: string }, userId: number): Promise<ConnectionTestResultDto> {
    const row = await this.s.sources.require(id);
    const stored = JSON.parse(row.config_json) as Record<string, unknown>;
    return this.s.sources.test(row.provider_id, { ...stored, ...(body.config ?? {}) }, row.id, this.#loginSecrets(body.deviceLogin, userId, row.provider_id, false));
  }

  startDeviceLogin(providerId: string, userId: number): Promise<DeviceFlowStartDto> {
    return this.s.deviceLogins.start(providerId, userId);
  }

  pollDeviceLogin(flowId: string, userId: number): Promise<DeviceFlowPollDto> {
    return this.s.deviceLogins.poll(flowId, userId);
  }

  // ── Torrent sources ("Find sources") ─────────────────────────────────────

  listTorrentSources(): Promise<TorrentSourceDto[]> {
    return this.s.torrentSources.listDtos();
  }

  async torrentSource(id: string): Promise<TorrentSourceDto> {
    return this.s.torrentSources.toDto(await this.s.torrentSources.require(id));
  }

  async createTorrentSource(body: TorrentSourceWriteDto): Promise<TorrentSourceDto> {
    return this.s.torrentSources.toDto(await this.s.torrentSources.create(body));
  }

  async updateTorrentSource(id: string, body: TorrentSourceWriteDto): Promise<TorrentSourceDto> {
    return this.s.torrentSources.toDto(await this.s.torrentSources.update(id, body));
  }

  async deleteTorrentSource(id: string): Promise<void> {
    return this.s.torrentSources.delete(id);
  }

  testTorrentSource(id: string | undefined, body: TorrentSourceWriteDto): Promise<TorrentSourceTestResultDto> {
    return this.s.torrentSources.test(id, body);
  }

  /** "Find sources": resolve the target metadata and run discovery across enabled indexers. */
  async discover(body: DiscoverRequestDto, userId: number): Promise<DiscoverResponseDto> {
    const target = await this.#discoverTarget(body);
    const prefs = await this.s.preferences.get(userId);
    return this.s.discovery.discover(target, {
      preferredFormat: prefs.preferredFormat === 'any' ? undefined : prefs.preferredFormat,
      minBitrateKbps: prefs.minBitrateKbps ?? undefined,
      prioritizeCached: prefs.prioritizeCached,
      hideUncached: prefs.hideUncached,
    });
  }

  async #discoverTarget(body: DiscoverRequestDto): Promise<DiscoveryTarget> {
    if (body.query?.title) {
      return {
        scope: body.type ?? (body.query.album ? 'album' : 'track'),
        title: body.query.title,
        ...(body.query.artist ? { artist: body.query.artist } : {}),
        ...(body.query.album ? { album: body.query.album } : {}),
        ...(body.query.year ? { year: body.query.year } : {}),
      };
    }
    if (body.trackId) {
      const m = await this.s.library.discoveryForTrack(body.trackId);
      if (!m) throw ApiError.notFound('Track');
      return toTarget(m, 'track');
    }
    if (body.albumId) {
      const m = await this.s.library.discoveryForAlbum(body.albumId);
      if (!m) throw ApiError.notFound('Album');
      return toTarget(m, 'album');
    }
    throw ApiError.badRequest('Provide a trackId, albumId or query');
  }

  // ── MusicBrainz catalogue ─────────────────────────────────────────────────

  /** Search the MusicBrainz catalogue (independent of library/torrent availability). */
  async catalogueSearch(q: string): Promise<CatalogueSearchResultDto> {
    if (!q.trim()) return { artists: [], releases: [], recordings: [] };
    const [artists, releases, recordings] = await Promise.all([
      this.s.mb.searchArtists(q.trim(), 8),
      this.s.mb.searchReleaseGroups(q.trim(), 12),
      this.s.mb.searchRecordings(q.trim(), 12),
    ]);
    return {
      artists: artists.map((a) => ({ mbid: a.id, name: a.name, disambiguation: a.disambiguation })),
      releases: releases.map((r) => ({
        mbid: r.id,
        title: r.title,
        artistCredit: r.credit.text,
        primaryType: r.primaryType,
        year: r.firstReleaseDate ? yearOf(r.firstReleaseDate) : null,
      })),
      recordings: recordings.map((r) => ({ mbid: r.id, title: r.title, artistCredit: r.credit.text, durationMs: r.lengthMs })),
    };
  }

  async catalogueArtist(mbid: string): Promise<CatalogueArtistDetailDto> {
    const a = await this.s.mb.getArtist(mbid);
    if (!a) throw ApiError.notFound('Artist');
    return {
      artist: { mbid: a.id, name: a.name, disambiguation: a.disambiguation },
      releaseGroups: a.releaseGroups.map((r) => ({
        mbid: r.id,
        title: r.title,
        artistCredit: r.credit.text,
        primaryType: r.primaryType,
        year: r.firstReleaseDate ? yearOf(r.firstReleaseDate) : null,
      })),
    };
  }

  async catalogueRelease(mbid: string): Promise<CatalogueReleaseDto> {
    const r = await this.s.mb.getReleaseGroup(mbid);
    if (!r) throw ApiError.notFound('Album');
    const { releaseGroup, release } = r;
    const year = releaseGroup.firstReleaseDate ? yearOf(releaseGroup.firstReleaseDate) : release.date ? yearOf(release.date) : null;
    return {
      mbid: releaseGroup.id,
      title: releaseGroup.title,
      artistCredit: releaseGroup.credit.text,
      year,
      date: release.date,
      trackCount: release.tracks.length,
      tracks: release.tracks.map((t) => ({
        title: t.title,
        artistCredit: t.recording.credit.text || releaseGroup.credit.text,
        discNo: t.discNo,
        trackNo: t.trackNo,
        durationMs: t.lengthMs,
        recordingMbid: t.recording.id || null,
      })),
      coverUrl: `https://coverartarchive.org/release-group/${releaseGroup.id}/front-500`,
    };
  }

  /** Pressing Play: discover, match, select a cached release and start retrieval. */
  async playCatalogue(releaseGroupMbid: string, userId: number): Promise<PlayCatalogueResultDto> {
    const r = await this.s.mb.getReleaseGroup(releaseGroupMbid);
    if (!r) throw ApiError.notFound('Album');
    const { releaseGroup } = r;

    const target: DiscoveryTarget = {
      scope: 'album',
      title: releaseGroup.title,
      artist: releaseGroup.credit.text,
      album: releaseGroup.title,
      ...(releaseGroup.firstReleaseDate && yearOf(releaseGroup.firstReleaseDate) != null
        ? { year: yearOf(releaseGroup.firstReleaseDate)! }
        : {}),
    };
    const prefs = await this.s.preferences.get(userId);
    const res = await this.s.discovery.discover(target, {
      preferredFormat: prefs.preferredFormat === 'any' ? undefined : prefs.preferredFormat,
      minBitrateKbps: prefs.minBitrateKbps ?? undefined,
      prioritizeCached: true,
    });

    const best = bestCachedCandidate(res.results, 'probable');
    const magnet = best ? magnetOf(best.result) : null;
    const provider = best ? cachedProvider(best.result) : null;
    if (best && magnet && provider) {
      const created = await this.s.retrieval.create(userId, {
        providerId: provider.sourceId,
        magnet,
        title: best.result.title,
        ...(best.result.artist ? { artist: best.result.artist } : {}),
        ...(best.result.album ? { album: best.result.album } : {}),
        ...(best.result.year != null ? { year: best.result.year } : {}),
        ...(best.result.size != null ? { size: best.result.size } : {}),
      });
      return { status: 'retrieving', job: created.job, selected: best.result };
    }
    if (res.results.length) return { status: 'no_cached_source', candidates: res.results };
    return { status: 'no_source' };
  }

  // ── Debrid retrieval jobs ("add to debrid") ──────────────────────────────

  listDebridProviders(): Promise<DebridProviderDto[]> {
    return this.s.debrid.listProviders();
  }

  listRetrievalJobs(userId: number): Promise<RetrievalJobDto[]> {
    return this.s.retrieval.list(userId);
  }

  getRetrievalJob(userId: number, id: string): Promise<RetrievalJobDto> {
    return this.s.retrieval.get(userId, id).then((job) => {
      if (!job) throw ApiError.notFound('Retrieval job');
      return job;
    });
  }

  createRetrievalJob(userId: number, body: CreateRetrievalJobRequestDto): Promise<CreateRetrievalJobResultDto> {
    return this.s.retrieval.create(userId, body);
  }

  cancelRetrievalJob(userId: number, id: string): Promise<RetrievalJobDto> {
    return this.s.retrieval.cancel(userId, id);
  }

  retryRetrievalJob(userId: number, id: string): Promise<RetrievalJobDto> {
    return this.s.retrieval.retry(userId, id);
  }

  /**
   * Files of a completed retrieval job, plus their library tracks (for the
   * player). Imports the job's audio files on first request if not yet done.
   */
  async retrievalJobFiles(userId: number, id: string, view: ViewContext): Promise<RetrievalJobFilesDto> {
    const job = await this.s.retrieval.get(userId, id);
    if (!job) throw ApiError.notFound('Retrieval job');
    if (job.status !== 'complete') throw ApiError.badRequest('This job has not finished retrieving yet');

    if (!(await this.s.retrieval.hasImportedFiles(id))) {
      await this.s.retrieval.ensureSource();
      this.s.scanner.enqueue(RETRIEVAL_SOURCE_ID);
      await this.s.scanner.idle();
      await this.s.retrieval.markFilesProcessed(id);
    }

    const imported = await this.s.retrieval.listImportedFiles(id);
    const trackIds = imported.map((f) => f.trackId).filter((t): t is number => t != null);
    const tracks = await this.s.library.getTracks(trackIds, view);
    const files: RetrievalJobFileDto[] = imported.map((f) => ({
      id: f.fileId,
      name: f.name,
      path: f.path,
      size: f.size,
      mime: f.mime,
      playable: f.trackId != null && isAudioFile(f.name),
      trackId: f.trackId,
    }));
    return { jobId: id, imported: imported.length > 0, files, tracks };
  }

  // ── Discovery preferences ─────────────────────────────────────────────────

  getPreferences(userId: number): Promise<DiscoveryPreferencesDto> {
    return this.s.preferences.get(userId);
  }

  setPreferences(userId: number, body: DiscoveryPreferencesDto): Promise<DiscoveryPreferencesDto> {
    return this.s.preferences.set(userId, body);
  }

  // ── Scanning ─────────────────────────────────────────────────────────────

  async matchStatus(): Promise<ScanStatusDto['matching']> {
    return { pending: await this.s.library.pendingMatchCount(), active: this.s.matchWorker.active, ...(await this.s.library.reviewCounts()) };
  }

  async scanStatus(): Promise<ScanStatusDto> {
    return this.s.scanner.status(await this.matchStatus());
  }

  async scanSource(id: string): Promise<ScanStatusDto> {
    await this.s.sources.require(id);
    this.s.scanner.enqueue(id);
    return this.scanStatus();
  }

  async scanAll(): Promise<ScanStatusDto> {
    await this.s.scanner.enqueueAll();
    return this.scanStatus();
  }
}

function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function yearOf(date: string): number | null {
  const n = Number(date.slice(0, 4));
  return Number.isInteger(n) && n >= 1000 ? n : null;
}

function toTarget(m: DiscoveryMetadata, scope: DiscoverScope): DiscoveryTarget {
  return {
    scope,
    title: m.title,
    ...(m.artist ? { artist: m.artist } : {}),
    ...(m.album ? { album: m.album } : {}),
    ...(m.year ? { year: m.year } : {}),
    ...(m.durationMs ? { durationMs: m.durationMs } : {}),
  };
}

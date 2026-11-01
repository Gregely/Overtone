import type {
  AlbumDetailDto,
  AlbumDto,
  ArtistDetailDto,
  ArtistDto,
  HomeDto,
  LibraryFileDto,
  MatchCandidateDto,
  MatchStatus,
  PageDto,
  ProviderManifestDto,
  SearchResultDto,
  SourceBadgeDto,
  TrackDto,
} from '@overtone/shared';
import type { Db } from '../db/index.js';
import type { MatchCandidate } from '../metadata/matcher/matcher.js';
import { normalize, searchText } from '../metadata/matcher/normalize.js';
import type { MbCredit } from '../metadata/musicbrainz/types.js';
import type { FileTags, SourceFile } from '../providers/types.js';

// ── Row types ───────────────────────────────────────────────────────────────

export interface SourceFileRow {
  id: number;
  source_id: string;
  file_id: string;
  name: string;
  path: string;
  size: number;
  mime: string | null;
  modified_at: number | null;
  duration_ms: number | null;
  tags_json: string | null;
  tags_status: 'pending' | 'done';
  track_id: number | null;
  match_status: MatchStatus;
  match_score: number | null;
  match_candidates_json: string | null;
}

interface ReleaseRow {
  id: number;
  mbid: string | null;
  title: string;
  artist_id: number | null;
  artist_name: string | null;
  artist_credit: string;
  year: number | null;
  cover_status: string;
  track_count: number;
  attention: number;
}

interface TrackRow {
  id: number;
  recording_mbid: string | null;
  title: string;
  artist_credit: string;
  artist_id: number | null;
  artist_name: string | null;
  release_id: number | null;
  release_title: string | null;
  cover_status: string | null;
  disc_no: number | null;
  track_no: number | null;
  duration_ms: number | null;
}

export interface PlayableSource {
  sourceFileId: number;
  sourceId: string;
  sourceName: string;
  providerId: string;
  priority: number;
  mime: string | null;
}

/** Per-request presentation context (artwork URLs carry a per-user token). */
export interface ViewContext {
  artworkToken: string;
  categoryOf(providerId: string): ProviderManifestDto['category'];
}

export type AlbumSort = 'name' | 'recent' | 'year' | 'artist' | 'random';

const UNKNOWN_ARTIST = 'Unknown Artist';

/** Higher = less confident. A track shows its least confident file's state. */
const MATCH_RANK: Record<MatchStatus, number> = { manual: 0, matched: 1, pending: 2, needs_review: 3, unmatched: 4 };
const MAX_LIMIT = 500;

const RELEASE_SELECT = `
  SELECT r.id, r.mbid, r.title, r.artist_id, a.name AS artist_name, r.artist_credit, r.year, r.cover_status,
         (SELECT COUNT(*) FROM available_tracks t WHERE t.release_id = r.id) AS track_count,
         (SELECT COUNT(DISTINCT t.id) FROM available_tracks t JOIN source_files sf ON sf.track_id = t.id
           WHERE t.release_id = r.id AND sf.match_status IN ('needs_review', 'unmatched')) AS attention
  FROM releases r LEFT JOIN artists a ON a.id = r.artist_id`;

const RELEASE_AVAILABLE = `EXISTS (SELECT 1 FROM available_tracks t WHERE t.release_id = r.id)`;

const TRACK_SELECT = `
  SELECT t.id, t.recording_mbid, t.title, t.artist_credit, t.artist_id, a.name AS artist_name,
         t.release_id, r.title AS release_title, r.cover_status, t.disc_no, t.track_no, t.duration_ms
  FROM available_tracks t
  LEFT JOIN artists a ON a.id = t.artist_id
  LEFT JOIN releases r ON r.id = t.release_id`;

export class LibraryRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // ── Scanner writes ───────────────────────────────────────────────────────

  /** Insert or refresh a listed file. Changed files have tags + match reset (unless manually matched). */
  upsertSourceFile(sourceId: string, f: SourceFile, scanId: number): { id: number; status: 'added' | 'changed' | 'unchanged' } {
    const existing = this.db
      .prepare('SELECT id, size, modified_at, match_status FROM source_files WHERE source_id = ? AND file_id = ?')
      .get(sourceId, f.id) as { id: number; size: number; modified_at: number | null; match_status: MatchStatus } | undefined;
    const mtime = f.modifiedAt ? f.modifiedAt.getTime() : null;
    const listedTags = f.tags ? JSON.stringify(f.tags) : null;

    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO source_files (source_id, file_id, name, path, size, mime, modified_at, duration_ms, tags_json, scan_id, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sourceId, f.id, f.name, f.path, f.size, f.mimeType ?? null, mtime, f.durationMs ?? f.tags?.durationMs ?? null, listedTags, scanId, this.now());
      return { id: Number(info.lastInsertRowid), status: 'added' };
    }

    const changed = existing.size !== f.size || (mtime !== null && existing.modified_at !== mtime);
    if (changed) {
      this.db
        .prepare(
          `UPDATE source_files SET name = ?, path = ?, size = ?, mime = ?, modified_at = ?, duration_ms = ?, tags_json = ?,
             tags_status = 'pending',
             match_status = CASE WHEN match_status = 'manual' THEN 'manual' ELSE 'pending' END,
             scan_id = ? WHERE id = ?`,
        )
        .run(f.name, f.path, f.size, f.mimeType ?? null, mtime, f.durationMs ?? null, listedTags, scanId, existing.id);
      return { id: existing.id, status: 'changed' };
    }
    this.db.prepare('UPDATE source_files SET name = ?, path = ?, scan_id = ? WHERE id = ?').run(f.name, f.path, scanId, existing.id);
    return { id: existing.id, status: 'unchanged' };
  }

  countFiles(sourceId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM source_files WHERE source_id = ?').get(sourceId) as { n: number }).n;
  }

  removeUnseen(sourceId: string, scanId: number): number {
    const n = this.db.prepare('DELETE FROM source_files WHERE source_id = ? AND scan_id != ?').run(sourceId, scanId).changes;
    if (n) this.cleanupOrphans();
    return n;
  }

  filesNeedingTags(sourceId: string, limit = 200): SourceFileRow[] {
    return this.db
      .prepare(`SELECT * FROM source_files WHERE source_id = ? AND tags_status = 'pending' ORDER BY path LIMIT ?`)
      .all(sourceId, limit) as SourceFileRow[];
  }

  getFile(id: number): SourceFileRow | undefined {
    return this.db.prepare('SELECT * FROM source_files WHERE id = ?').get(id) as SourceFileRow | undefined;
  }

  /** Store final tags and give the file a provisional (tag-based) track right away. */
  saveTags(file: SourceFileRow, tags: FileTags): void {
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE source_files SET tags_json = ?, tags_status = 'done', duration_ms = COALESCE(?, duration_ms) WHERE id = ?`)
        .run(JSON.stringify(tags), tags.durationMs ?? null, file.id);
      if (file.match_status !== 'manual') this.#attachProvisional(file.id, tags);
    })();
  }

  #attachProvisional(fileId: number, tags: FileTags): void {
    const artistName = tags.artist || tags.albumArtist || UNKNOWN_ARTIST;
    const albumArtistName = tags.albumArtist || tags.artist || UNKNOWN_ARTIST;
    const artistId = this.upsertArtist({ name: artistName });
    let releaseId: number | null = null;
    let releaseKey = '';
    if (tags.album) {
      const albumArtistId = this.upsertArtist({ name: albumArtistName });
      const r = this.upsertRelease({ title: tags.album, artistId: albumArtistId, artistCredit: albumArtistName, year: tags.year ?? null });
      releaseId = r.id;
      releaseKey = r.key;
    }
    const title = tags.title || 'Untitled';
    const trackId = this.upsertTrack({
      key: `local:${releaseKey}|${tags.discNumber ?? ''}|${tags.trackNumber ?? ''}|${normalize(title)}|${normalize(artistName)}`,
      recordingMbid: null,
      releaseId,
      artistId,
      title,
      artistCredit: artistName,
      discNo: tags.discNumber ?? null,
      trackNo: tags.trackNumber ?? null,
      durationMs: tags.durationMs ?? null,
      albumTitle: tags.album ?? null,
    });
    this.db.prepare('UPDATE source_files SET track_id = ? WHERE id = ?').run(trackId, fileId);
  }

  /** Point a file at a MusicBrainz track (creating artist/release/track rows as needed). */
  applyMatch(
    fileId: number,
    status: Exclude<MatchStatus, 'pending'>,
    score: number,
    best: MatchCandidate | null,
    candidates: MatchCandidate[],
  ): void {
    this.db.transaction(() => {
      const file = this.getFile(fileId);
      if (!file) return;
      let trackId = file.track_id;
      if (best) trackId = this.#upsertMatchedTrack(best);
      else if (file.tags_json && status === 'unmatched') this.#attachProvisional(fileId, JSON.parse(file.tags_json) as FileTags);
      this.db
        .prepare(
          `UPDATE source_files SET track_id = COALESCE(?, track_id), match_status = ?, match_score = ?,
             match_candidates_json = ?, matched_at = ? WHERE id = ?`,
        )
        .run(best ? trackId : null, status, score, JSON.stringify(candidates.map(toCandidateDto)), this.now(), fileId);
    })();
  }

  /** Forget a match (manual or automatic) and queue the file for matching again. */
  resetMatch(fileId: number): void {
    this.db.transaction(() => {
      const file = this.getFile(fileId);
      if (!file) return;
      this.db
        .prepare(`UPDATE source_files SET match_status = 'pending', match_score = NULL, match_candidates_json = NULL WHERE id = ?`)
        .run(fileId);
      if (file.tags_json) this.#attachProvisional(fileId, JSON.parse(file.tags_json) as FileTags);
    })();
    this.cleanupOrphans();
  }

  #upsertMatchedTrack(c: MatchCandidate): number {
    const trackArtist = this.#artistFromCredit(c.credit);
    let releaseId: number | null = null;
    if (c.release) {
      const credit = c.release.credit?.artists.length ? c.release.credit : c.credit;
      releaseId = this.upsertRelease({
        mbid: c.release.mbid,
        title: c.release.title,
        artistId: this.#artistFromCredit(credit),
        artistCredit: credit.text || UNKNOWN_ARTIST,
        date: c.release.date,
        year: yearOf(c.release.date),
        releaseGroupMbid: c.release.releaseGroupMbid,
        primaryType: c.release.primaryType,
        trackCount: c.release.trackCount,
      }).id;
    }
    return this.upsertTrack({
      key: `mb:${c.recordingMbid}:${c.release?.mbid ?? ''}`,
      recordingMbid: c.recordingMbid,
      releaseId,
      artistId: trackArtist,
      title: c.title,
      artistCredit: c.credit.text || UNKNOWN_ARTIST,
      discNo: c.discNo,
      trackNo: c.trackNo,
      durationMs: c.lengthMs,
      albumTitle: c.release?.title ?? null,
    });
  }

  #artistFromCredit(credit: MbCredit): number {
    const primary = credit.artists[0];
    return primary
      ? this.upsertArtist({ mbid: primary.id, name: primary.name, sortName: primary.sortName })
      : this.upsertArtist({ name: credit.text || UNKNOWN_ARTIST });
  }

  upsertArtist(a: { mbid?: string; name: string; sortName?: string }): number {
    const key = a.mbid ? `mb:${a.mbid}` : `local:${normalize(a.name) || 'unknown'}`;
    const sortName = a.sortName || a.name.replace(/^the\s+/i, '');
    const row = this.db
      .prepare(
        `INSERT INTO artists (key, mbid, name, sort_name, search_text, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET name = excluded.name, sort_name = excluded.sort_name, search_text = excluded.search_text
         RETURNING id`,
      )
      .get(key, a.mbid ?? null, a.name, sortName, searchText(a.name, sortName), this.now()) as { id: number };
    return row.id;
  }

  upsertRelease(r: {
    mbid?: string;
    title: string;
    artistId: number | null;
    artistCredit: string;
    date?: string | null;
    year?: number | null;
    releaseGroupMbid?: string | null;
    primaryType?: string | null;
    trackCount?: number | null;
  }): { id: number; key: string } {
    const key = r.mbid ? `mb:${r.mbid}` : `local:${normalize(r.artistCredit)}|${normalize(r.title)}`;
    const row = this.db
      .prepare(
        `INSERT INTO releases (key, mbid, release_group_mbid, title, artist_id, artist_credit, date, year, primary_type, track_count, search_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           title = excluded.title, artist_id = excluded.artist_id, artist_credit = excluded.artist_credit,
           date = COALESCE(excluded.date, date), year = COALESCE(excluded.year, year),
           release_group_mbid = COALESCE(excluded.release_group_mbid, release_group_mbid),
           primary_type = COALESCE(excluded.primary_type, primary_type),
           track_count = COALESCE(excluded.track_count, track_count), search_text = excluded.search_text
         RETURNING id`,
      )
      .get(
        key,
        r.mbid ?? null,
        r.releaseGroupMbid ?? null,
        r.title,
        r.artistId,
        r.artistCredit,
        r.date ?? null,
        r.year ?? null,
        r.primaryType ?? null,
        r.trackCount ?? null,
        searchText(r.title, r.artistCredit),
        this.now(),
      ) as { id: number };
    return { id: row.id, key };
  }

  upsertTrack(t: {
    key: string;
    recordingMbid: string | null;
    releaseId: number | null;
    artistId: number | null;
    title: string;
    artistCredit: string;
    discNo: number | null;
    trackNo: number | null;
    durationMs: number | null;
    albumTitle: string | null;
  }): number {
    const row = this.db
      .prepare(
        `INSERT INTO tracks (key, recording_mbid, release_id, artist_id, title, artist_credit, disc_no, track_no, duration_ms, search_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           release_id = excluded.release_id, artist_id = excluded.artist_id, title = excluded.title,
           artist_credit = excluded.artist_credit, disc_no = excluded.disc_no, track_no = excluded.track_no,
           duration_ms = COALESCE(excluded.duration_ms, duration_ms), search_text = excluded.search_text
         RETURNING id`,
      )
      .get(
        t.key,
        t.recordingMbid,
        t.releaseId,
        t.artistId,
        t.title,
        t.artistCredit,
        t.discNo,
        t.trackNo,
        t.durationMs,
        searchText(t.title, t.artistCredit, t.albumTitle),
        this.now(),
      ) as { id: number };
    return row.id;
  }

  /** Remove tracks/releases/artists no file points at any more. */
  cleanupOrphans(): void {
    this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM tracks WHERE id NOT IN (SELECT track_id FROM source_files WHERE track_id IS NOT NULL);
        DELETE FROM releases WHERE id NOT IN (SELECT release_id FROM tracks WHERE release_id IS NOT NULL);
        DELETE FROM artists
          WHERE id NOT IN (SELECT artist_id FROM tracks WHERE artist_id IS NOT NULL)
            AND id NOT IN (SELECT artist_id FROM releases WHERE artist_id IS NOT NULL);
      `);
    })();
  }

  /** Files waiting for MusicBrainz matching, grouped by source folder (album coherence). */
  pendingMatchGroups(maxFiles = 100): SourceFileRow[][] {
    const rows = this.db
      .prepare(
        `SELECT sf.* FROM source_files sf JOIN sources s ON s.id = sf.source_id
         WHERE sf.match_status = 'pending' AND sf.tags_status = 'done' AND s.enabled = 1
         ORDER BY sf.source_id, sf.path LIMIT ?`,
      )
      .all(maxFiles) as SourceFileRow[];
    const groups = new Map<string, SourceFileRow[]>();
    for (const r of rows) {
      const k = `${r.source_id}\u0000${dirname(r.path)}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.values()];
  }

  pendingMatchCount(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM source_files sf JOIN sources s ON s.id = sf.source_id
           WHERE sf.match_status = 'pending' AND s.enabled = 1`,
        )
        .get() as { n: number }
    ).n;
  }

  setCoverStatus(releaseId: number, status: 'caa' | 'embedded' | 'none'): void {
    this.db.prepare('UPDATE releases SET cover_status = ?, cover_checked_at = ? WHERE id = ?').run(status, this.now(), releaseId);
  }

  getReleaseForArtwork(id: number):
    | { id: number; mbid: string | null; release_group_mbid: string | null; cover_status: string; cover_checked_at: number | null }
    | undefined {
    return this.db
      .prepare('SELECT id, mbid, release_group_mbid, cover_status, cover_checked_at FROM releases WHERE id = ?')
      .get(id) as never;
  }

  /** Source files for a release, local sources first (for embedded artwork). */
  releaseFiles(releaseId: number): Array<{ id: number; source_id: string; file_id: string; provider_id: string }> {
    return this.db
      .prepare(
        `SELECT sf.id, sf.source_id, sf.file_id, s.provider_id FROM source_files sf
         JOIN tracks t ON t.id = sf.track_id JOIN sources s ON s.id = sf.source_id
         WHERE t.release_id = ? AND s.enabled = 1 ORDER BY s.priority, t.disc_no, t.track_no LIMIT 5`,
      )
      .all(releaseId) as never;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  playableSources(trackId: number): PlayableSource[] {
    return (
      this.db
        .prepare(
          `SELECT sf.id AS sourceFileId, s.id AS sourceId, s.name AS sourceName, s.provider_id AS providerId,
                  s.priority, sf.mime FROM source_files sf JOIN sources s ON s.id = sf.source_id
           WHERE sf.track_id = ? AND s.enabled = 1 ORDER BY s.priority, sf.id`,
        )
        .all(trackId) as PlayableSource[]
    );
  }

  /** The file + its source, for the stream endpoint. */
  streamTarget(sourceFileId: number): { file: SourceFileRow; enabled: boolean } | undefined {
    const row = this.db
      .prepare('SELECT sf.*, s.enabled AS source_enabled FROM source_files sf JOIN sources s ON s.id = sf.source_id WHERE sf.id = ?')
      .get(sourceFileId) as (SourceFileRow & { source_enabled: number }) | undefined;
    return row ? { file: row, enabled: row.source_enabled === 1 } : undefined;
  }

  stats(): HomeDto['stats'] {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      tracks: one('SELECT COUNT(*) AS n FROM available_tracks'),
      albums: one(`SELECT COUNT(*) AS n FROM releases r WHERE ${RELEASE_AVAILABLE}`),
      artists: one(
        `SELECT COUNT(DISTINCT artist_id) AS n FROM (
           SELECT artist_id FROM available_tracks UNION SELECT r.artist_id FROM releases r WHERE ${RELEASE_AVAILABLE})`,
      ),
      pendingMatches: this.pendingMatchCount(),
      ...this.reviewCounts(),
    };
  }

  /** Files on enabled sources that need a human: low-confidence or no match. */
  reviewCounts(): { needsReview: number; unmatched: number } {
    const rows = this.db
      .prepare(
        `SELECT sf.match_status AS status, COUNT(*) AS n FROM source_files sf JOIN sources s ON s.id = sf.source_id
         WHERE s.enabled = 1 AND sf.match_status IN ('needs_review', 'unmatched') GROUP BY sf.match_status`,
      )
      .all() as Array<{ status: string; n: number }>;
    const get = (st: string) => rows.find((r) => r.status === st)?.n ?? 0;
    return { needsReview: get('needs_review'), unmatched: get('unmatched') };
  }

  home(view: ViewContext): HomeDto {
    const recent = this.db.prepare(`${RELEASE_SELECT} WHERE ${RELEASE_AVAILABLE} ORDER BY r.created_at DESC, r.id DESC LIMIT 12`).all() as ReleaseRow[];
    const random = this.db.prepare(`${RELEASE_SELECT} WHERE ${RELEASE_AVAILABLE} ORDER BY random() LIMIT 12`).all() as ReleaseRow[];
    return { recentlyAdded: recent.map((r) => this.#album(r, view)), random: random.map((r) => this.#album(r, view)), stats: this.stats() };
  }

  listArtists(opts: { offset?: number; limit?: number; q?: string }): PageDto<ArtistDto> {
    const { offset, limit } = page(opts);
    const where = [`(EXISTS (SELECT 1 FROM available_tracks t WHERE t.artist_id = a.id) OR EXISTS (SELECT 1 FROM releases r WHERE r.artist_id = a.id AND ${RELEASE_AVAILABLE}))`];
    const params: unknown[] = [];
    likeClauses('a.search_text', opts.q, where, params);
    const w = `WHERE ${where.join(' AND ')}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM artists a ${w}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`${ARTIST_SELECT} ${w} ORDER BY a.sort_name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ArtistRow[];
    return { items: rows.map(toArtist), total, offset, limit };
  }

  getArtist(id: number, view: ViewContext): ArtistDetailDto | null {
    const row = this.db.prepare(`${ARTIST_SELECT} WHERE a.id = ?`).get(id) as ArtistRow | undefined;
    if (!row) return null;
    const albums = this.db
      .prepare(`${RELEASE_SELECT} WHERE r.artist_id = ? AND ${RELEASE_AVAILABLE} ORDER BY r.year IS NULL, r.year, r.title COLLATE NOCASE`)
      .all(id) as ReleaseRow[];
    return { artist: toArtist(row), albums: albums.map((r) => this.#album(r, view)) };
  }

  listAlbums(opts: { offset?: number; limit?: number; q?: string; sort?: AlbumSort; artistId?: number }, view: ViewContext): PageDto<AlbumDto> {
    const { offset, limit } = page(opts);
    const where = [RELEASE_AVAILABLE];
    const params: unknown[] = [];
    if (opts.artistId) {
      where.push('r.artist_id = ?');
      params.push(opts.artistId);
    }
    likeClauses('r.search_text', opts.q, where, params);
    const w = `WHERE ${where.join(' AND ')}`;
    const order = {
      name: 'r.title COLLATE NOCASE',
      recent: 'r.created_at DESC, r.id DESC',
      year: 'r.year IS NULL, r.year DESC, r.title COLLATE NOCASE',
      artist: 'a.sort_name COLLATE NOCASE, r.year, r.title COLLATE NOCASE',
      random: 'random()',
    }[opts.sort ?? 'name'];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM releases r ${w}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`${RELEASE_SELECT} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as ReleaseRow[];
    return { items: rows.map((r) => this.#album(r, view)), total, offset, limit };
  }

  getAlbum(id: number, view: ViewContext): AlbumDetailDto | null {
    const row = this.db.prepare(`${RELEASE_SELECT} WHERE r.id = ?`).get(id) as ReleaseRow | undefined;
    if (!row) return null;
    const tracks = this.db
      .prepare(`${TRACK_SELECT} WHERE t.release_id = ? ORDER BY t.disc_no IS NULL, t.disc_no, t.track_no IS NULL, t.track_no, t.title COLLATE NOCASE`)
      .all(id) as TrackRow[];
    return { album: this.#album(row, view), tracks: this.#tracks(tracks, view) };
  }

  listTracks(opts: { offset?: number; limit?: number; q?: string; sort?: 'name' | 'recent' | 'artist' }, view: ViewContext): PageDto<TrackDto> {
    const { offset, limit } = page(opts);
    const where: string[] = [];
    const params: unknown[] = [];
    likeClauses('t.search_text', opts.q, where, params);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = {
      name: 't.title COLLATE NOCASE',
      recent: 't.created_at DESC, t.id DESC',
      artist: 'a.sort_name COLLATE NOCASE, r.year, r.title, t.disc_no, t.track_no',
    }[opts.sort ?? 'name'];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM available_tracks t ${w}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`${TRACK_SELECT} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as TrackRow[];
    return { items: this.#tracks(rows, view), total, offset, limit };
  }

  getTracks(ids: number[], view: ViewContext): TrackDto[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`${TRACK_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as TrackRow[];
    const byId = new Map(this.#tracks(rows, view).map((t) => [t.id, t]));
    return ids.map((id) => byId.get(id)).filter((t): t is TrackDto => Boolean(t));
  }

  search(q: string, view: ViewContext): SearchResultDto {
    if (!normalize(q)) return { artists: [], albums: [], tracks: [] };
    return {
      artists: this.listArtists({ q, limit: 10 }).items,
      albums: this.listAlbums({ q, limit: 12 }, view).items,
      tracks: this.listTracks({ q, limit: 30 }, view).items,
    };
  }

  listFiles(opts: { status?: MatchStatus; sourceId?: string; trackId?: number; offset?: number; limit?: number }): PageDto<LibraryFileDto> {
    const { offset, limit } = page(opts);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) (where.push('match_status = ?'), params.push(opts.status));
    if (opts.sourceId) (where.push('source_id = ?'), params.push(opts.sourceId));
    if (opts.trackId) (where.push('track_id = ?'), params.push(opts.trackId));
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM source_files ${w}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM source_files ${w} ORDER BY source_id, path LIMIT ? OFFSET ?`).all(...params, limit, offset) as SourceFileRow[];
    return { items: rows.map(toFileDto), total, offset, limit };
  }

  fileDto(id: number): LibraryFileDto | null {
    const row = this.getFile(id);
    return row ? toFileDto(row) : null;
  }

  /** Files whose current track belongs to a release (for album-level "fix match"). */
  releaseFileRows(releaseId: number): SourceFileRow[] {
    return this.db
      .prepare('SELECT sf.* FROM source_files sf JOIN tracks t ON t.id = sf.track_id WHERE t.release_id = ? ORDER BY sf.path')
      .all(releaseId) as SourceFileRow[];
  }

  // ── DTO mapping ──────────────────────────────────────────────────────────

  #coverUrl(releaseId: number | null, status: string | null, view: ViewContext): string | null {
    if (!releaseId || status === 'none') return null;
    return `/api/artwork/release/${releaseId}?at=${view.artworkToken}`;
  }

  #album(r: ReleaseRow, view: ViewContext): AlbumDto {
    return {
      id: r.id,
      title: r.title,
      mbid: r.mbid,
      artist: r.artist_id && r.artist_name ? { id: r.artist_id, name: r.artist_name } : null,
      artistCredit: r.artist_credit,
      year: r.year,
      coverUrl: this.#coverUrl(r.id, r.cover_status, view),
      trackCount: r.track_count,
      attention: r.attention,
    };
  }

  #tracks(rows: TrackRow[], view: ViewContext): TrackDto[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const sources = this.db
      .prepare(
        `SELECT DISTINCT sf.track_id, s.id, s.name, s.provider_id, s.priority FROM source_files sf JOIN sources s ON s.id = sf.source_id
         WHERE s.enabled = 1 AND sf.track_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.priority`,
      )
      .all(...ids) as Array<{ track_id: number; id: string; name: string; provider_id: string }>;
    const statuses = this.db
      .prepare(`SELECT track_id, match_status FROM source_files WHERE track_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ track_id: number; match_status: MatchStatus }>;
    const statusByTrack = new Map<number, MatchStatus>();
    for (const r of statuses) {
      const prev = statusByTrack.get(r.track_id);
      if (!prev || MATCH_RANK[r.match_status] > MATCH_RANK[prev]) statusByTrack.set(r.track_id, r.match_status);
    }
    const byTrack = new Map<number, SourceBadgeDto[]>();
    for (const s of sources) {
      const list = byTrack.get(s.track_id) ?? [];
      list.push({ sourceId: s.id, sourceName: s.name, providerId: s.provider_id, category: view.categoryOf(s.provider_id) });
      byTrack.set(s.track_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      artistCredit: r.artist_credit,
      artist: r.artist_id && r.artist_name ? { id: r.artist_id, name: r.artist_name } : null,
      album: r.release_id && r.release_title ? { id: r.release_id, title: r.release_title } : null,
      discNo: r.disc_no,
      trackNo: r.track_no,
      durationMs: r.duration_ms,
      mbid: r.recording_mbid,
      coverUrl: this.#coverUrl(r.release_id, r.cover_status, view),
      sources: byTrack.get(r.id) ?? [],
      matchStatus: statusByTrack.get(r.id) ?? 'pending',
    }));
  }
}

interface ArtistRow {
  id: number;
  mbid: string | null;
  name: string;
  album_count: number;
  track_count: number;
}

const ARTIST_SELECT = `
  SELECT a.id, a.mbid, a.name,
    (SELECT COUNT(*) FROM releases r WHERE r.artist_id = a.id AND ${RELEASE_AVAILABLE}) AS album_count,
    (SELECT COUNT(*) FROM available_tracks t WHERE t.artist_id = a.id) AS track_count
  FROM artists a`;

function toArtist(r: ArtistRow): ArtistDto {
  return { id: r.id, name: r.name, mbid: r.mbid, albumCount: r.album_count, trackCount: r.track_count };
}

function toFileDto(r: SourceFileRow): LibraryFileDto {
  return {
    id: r.id,
    sourceId: r.source_id,
    path: r.path,
    name: r.name,
    size: r.size,
    durationMs: r.duration_ms,
    tags: r.tags_json ? (JSON.parse(r.tags_json) as Record<string, unknown>) : null,
    matchStatus: r.match_status,
    matchScore: r.match_score,
    trackId: r.track_id,
    candidates: r.match_candidates_json ? (JSON.parse(r.match_candidates_json) as MatchCandidateDto[]) : [],
  };
}

export function toCandidateDto(c: MatchCandidate): MatchCandidateDto {
  return {
    recordingMbid: c.recordingMbid,
    releaseMbid: c.release?.mbid ?? null,
    title: c.title,
    artistCredit: c.credit.text,
    releaseTitle: c.release?.title ?? null,
    releaseDate: c.release?.date ?? null,
    discNo: c.discNo,
    trackNo: c.trackNo,
    durationMs: c.lengthMs,
    score: c.score,
  };
}

function page(opts: { offset?: number; limit?: number }): { offset: number; limit: number } {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), MAX_LIMIT);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  return { offset, limit };
}

/** Each search word must appear somewhere in the column (AND of LIKEs). */
function likeClauses(column: string, q: string | undefined, where: string[], params: unknown[]): void {
  if (!q) return;
  for (const word of normalize(q).split(' ').filter(Boolean).slice(0, 8)) {
    where.push(`${column} LIKE ? ESCAPE '\\'`);
    params.push(`%${word.replace(/[\\%_]/g, '\\$&')}%`);
  }
}

function yearOf(date: string | null | undefined): number | null {
  const m = date?.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

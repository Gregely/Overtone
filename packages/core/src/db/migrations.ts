/**
 * Append-only list of migrations, shared by every database driver (server
 * better-sqlite3, Android Capacitor SQLite, browser sql.js). Never edit a
 * shipped migration; add a new one. The index (1-based) is stored in
 * PRAGMA user_version.
 *
 * Portability rules (the Capacitor driver rewrites some statements):
 *  - no RETURNING clauses: do the upsert, then SELECT the row by its key;
 *  - no columns named last_modified or sql_deleted (they turn on the
 *    plugin's soft-delete sync mode, which rewrites DELETE statements).
 */
export const migrations: readonly string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE refresh_tokens (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT    NOT NULL UNIQUE,
    family_id   TEXT    NOT NULL,
    device_name TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    revoked_at  INTEGER
  );
  CREATE INDEX refresh_tokens_family ON refresh_tokens(family_id);

  CREATE TABLE sources (
    id           TEXT    PRIMARY KEY,
    provider_id  TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    priority     INTEGER NOT NULL DEFAULT 10,
    stream_mode  TEXT    NOT NULL DEFAULT 'proxy' CHECK (stream_mode IN ('proxy', 'redirect')),
    config_json  TEXT    NOT NULL DEFAULT '{}',
    secrets_enc  TEXT,
    created_at   INTEGER NOT NULL,
    last_scan_at INTEGER,
    last_error   TEXT
  );

  CREATE TABLE provider_state (
    source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY (source_id, key)
  );

  -- key: 'mb:<mbid>' or 'local:<normalized name>'
  CREATE TABLE artists (
    id          INTEGER PRIMARY KEY,
    key         TEXT    NOT NULL UNIQUE,
    mbid        TEXT,
    name        TEXT    NOT NULL,
    sort_name   TEXT    NOT NULL,
    search_text TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );

  -- key: 'mb:<release mbid>' or 'local:<artist>|<album>'
  CREATE TABLE releases (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT, -- ids key the artwork cache; never reuse
    key                TEXT    NOT NULL UNIQUE,
    mbid               TEXT,
    release_group_mbid TEXT,
    title              TEXT    NOT NULL,
    artist_id          INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    artist_credit      TEXT    NOT NULL,
    date               TEXT,
    year               INTEGER,
    primary_type       TEXT,
    track_count        INTEGER,
    cover_status       TEXT    NOT NULL DEFAULT 'unknown', -- unknown | caa | embedded | none
    cover_checked_at   INTEGER,
    search_text        TEXT    NOT NULL,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX releases_artist ON releases(artist_id);

  -- One recording on one release. key: 'mb:<recording>:<release>' or 'local:…'
  CREATE TABLE tracks (
    id             INTEGER PRIMARY KEY,
    key            TEXT    NOT NULL UNIQUE,
    recording_mbid TEXT,
    release_id     INTEGER REFERENCES releases(id) ON DELETE SET NULL,
    artist_id      INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    title          TEXT    NOT NULL,
    artist_credit  TEXT    NOT NULL,
    disc_no        INTEGER,
    track_no       INTEGER,
    duration_ms    INTEGER,
    search_text    TEXT    NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX tracks_release ON tracks(release_id, disc_no, track_no);
  CREATE INDEX tracks_artist ON tracks(artist_id);
  CREATE INDEX tracks_recording ON tracks(recording_mbid);

  CREATE TABLE source_files (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT, -- ids are in stream tokens; never reuse
    source_id             TEXT    NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    file_id               TEXT    NOT NULL,
    name                  TEXT    NOT NULL,
    path                  TEXT    NOT NULL,
    size                  INTEGER NOT NULL,
    mime                  TEXT,
    modified_at           INTEGER,
    duration_ms           INTEGER,
    tags_json             TEXT,
    tags_status           TEXT    NOT NULL DEFAULT 'pending', -- pending | done
    track_id              INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
    match_status          TEXT    NOT NULL DEFAULT 'pending', -- pending | matched | needs_review | unmatched | manual
    match_score           REAL,
    match_candidates_json TEXT,
    matched_at            INTEGER,
    scan_id               INTEGER NOT NULL,
    added_at              INTEGER NOT NULL,
    UNIQUE (source_id, file_id)
  );
  CREATE INDEX source_files_track ON source_files(track_id);
  CREATE INDEX source_files_match ON source_files(match_status, tags_status);

  -- Tracks playable from at least one enabled source. Library views read from this.
  CREATE VIEW available_tracks AS
    SELECT t.* FROM tracks t
    WHERE EXISTS (
      SELECT 1 FROM source_files sf JOIN sources s ON s.id = sf.source_id
      WHERE sf.track_id = t.id AND s.enabled = 1
    );

  CREATE TABLE mb_cache (
    key        TEXT    PRIMARY KEY,
    status     INTEGER NOT NULL,
    body       TEXT,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  /* 2: persistent background-work queue (standalone mode resumes after the app is killed) */ `
  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY,
    kind        TEXT    NOT NULL,             -- 'scan'
    source_id   TEXT    REFERENCES sources(id) ON DELETE CASCADE,
    state       TEXT    NOT NULL DEFAULT 'queued', -- queued | running
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (kind, source_id)
  );

  -- Small key/value settings (last scan time, standalone preferences).
  CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  `,
  /* 3: torrent indexer connections ("Find sources"), kept separate from music sources and debrid providers */ `
  CREATE TABLE torrent_sources (
    id           TEXT    PRIMARY KEY,
    kind         TEXT    NOT NULL CHECK (kind IN ('torznab', 'prowlarr', 'jackett')),
    name         TEXT    NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    url          TEXT    NOT NULL,
    config_json  TEXT    NOT NULL DEFAULT '{}',
    secrets_enc  TEXT,
    created_at   INTEGER NOT NULL,
    last_error   TEXT
  );
  `,
];

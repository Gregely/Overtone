# Overtone — Architecture & Build Plan

> "Overtone" is a placeholder name. Search-and-replace `overtone` / `Overtone`
> when a final name is chosen; nothing depends on the string.

Overtone is a self-hosted music streaming server with a Stremio-style plugin
system for **sources**. A source is anything that can list audio files and
hand back a stream for one of them: a local folder, a Navidrome server, the
Internet Archive, or the files already sitting in your debrid account. The
backend merges every source into one library, matches it against MusicBrainz,
and serves it to thin clients over one REST API.

---

## 1. Goals and non-goals

**Goals**

- Runs comfortably on a Raspberry Pi 4/5 (arm64) from one `docker compose up`.
- One REST API, many thin clients: PWA first, then Android via Capacitor.
- Pluggable sources with a small, documented interface (one folder each).
- Clean metadata from MusicBrainz + Cover Art Archive, with manual "fix match".
- Credentials never leave the server. They are encrypted at rest, never
  logged, and never returned to clients.

**Non-goals (explicit)**

- **No content discovery.** No torrent indexers, magnet search, "add to
  debrid", or any "find and add content" feature. Debrid adapters are
  read-only views of what is *already* in the user's account. There is no
  `add` method anywhere in the provider interface, and none will be added.
- No transcoding in v1. Files stream as-is. On-the-fly Opus/AAC via ffmpeg
  could come later as an opt-in on stronger hardware.
- No public multi-tenant hosting. Multi-user is for a household, not a
  service.

---

## 2. Repository layout

npm workspaces monorepo, TypeScript everywhere, ESM, Node 22+.

```
overtone/
├── package.json              # workspaces + root scripts
├── tsconfig.base.json
├── docker-compose.yml        # stage 2
├── Dockerfile                # stage 2 (multi-stage; builds web + server, arm64-friendly)
├── .env.example
├── docs/
│   ├── PLAN.md               # this file
│   ├── providers.md          # writing a provider (stage 6, seeded in stage 1)
│   ├── remote-access.md      # Tailscale / reverse proxy + HTTPS (stage 5)
│   └── android.md            # building the APK (stage 5)
├── packages/
│   └── shared/               # @overtone/shared: types and helpers used by server AND clients
│       └── src/
│           ├── config-schema.ts   # declarative provider config schema + validator
│           ├── audio.ts           # audio extension / MIME helpers
│           └── api.ts             # REST DTOs (grows each stage)
└── apps/
    ├── server/               # @overtone/server: Fastify + better-sqlite3
    │   └── src/
    │       ├── index.ts           # boot (stage 2)
    │       ├── config.ts          # env parsing (stage 2)
    │       ├── db/                # schema, migrations, repositories (stage 2)
    │       ├── auth/              # users, access/refresh tokens, stream tokens (stage 2)
    │       ├── crypto/            # AES-256-GCM secret box (stage 2)
    │       ├── metadata/
    │       │   ├── musicbrainz/   # rate-limited, cached client (stage 2)
    │       │   ├── coverart/      # Cover Art Archive (stage 2)
    │       │   └── matcher/       # tags/filename → MB recording/release (stage 2)
    │       ├── library/           # scanner, dedupe, unified library (stage 2)
    │       ├── streaming/         # proxy/redirect, range, link re-resolution (stage 2)
    │       ├── app.ts / services.ts   # Fastify app + service wiring (stage 2)
    │       ├── http/              # errors, auth hooks, provider fetch, log redaction (stage 2)
    │       ├── sources/           # SourceManager: persistence, secrets, provider instances (stage 2)
    │       ├── routes/            # REST API (stage 2+)
    │       ├── testing/           # test helpers for provider authors (stage 1)
    │       └── providers/
    │           ├── types.ts       # ★ THE PLUGIN INTERFACE (stage 1)
    │           ├── errors.ts      # ProviderError (stage 1)
    │           ├── registry.ts    # plugin registry (stage 1)
    │           ├── resolve-cache.ts   # expiry-aware stream resolution cache (stage 1)
    │           ├── index.ts       # built-in plugin list (stage 1)
    │           ├── local-folder/  # stage 2
    │           ├── subsonic/      # stage 4
    │           ├── internet-archive/  # stage 4
    │           └── debrid/
    │               ├── types.ts       # ★ DebridAdapter interface (stage 1)
    │               ├── index.ts       # adapter → SourceProvider bridge (stage 1)
    │               └── adapters/
    │                   ├── real-debrid/
    │                   ├── alldebrid/
    │                   ├── torbox/
    │                   └── premiumize/
    └── web/                  # React + Vite PWA (stage 3)
        ├── src/
        │   ├── api/               # typed REST client, token refresh
        │   ├── player/            # PlayerEngine abstraction (HTML audio / native)
        │   ├── views/             # Home, Library, Search, Album, NowPlaying, Settings
        │   └── platform/          # web vs Capacitor shims (storage, server URL)
        └── android/          # Capacitor Android project (stage 5)
```

Why `shared`: the Settings > Sources screen renders each provider's config
form straight from its `configSchema`, so the schema types and the validator
must be identical on both sides.

---

## 3. The provider plugin interface (Stage 1 deliverable)

Full source: `apps/server/src/providers/types.ts`. Summary:

```ts
interface ProviderPlugin {
  manifest: ProviderManifest;            // { id, name, description, configSchema, capabilities }
  create(config, ctx): SourceProvider;   // one instance per configured source
}

interface SourceProvider {
  listLibrary(opts): AsyncIterable<SourceFile>;           // { id, name, size, path, ...optional tags }
  resolveStream(fileId, opts): Promise<ResolvedStream>;  // { url, headers?, expiresAt?, redirectSafe? }
  testConnection?(opts): Promise<ConnectionTestResult>;
  readTags?(fileId, opts): Promise<FileTags | null>;
  watch?(onChange): Disposable;
  dispose?(): Promise<void>;
}
```

Key decisions:

- **Plugin vs. source.** A *plugin* is code (e.g. "Subsonic"). A *source* is
  a configured instance (e.g. "Navidrome at home"). Users can add the same
  plugin twice with different configs. Global identity of a file is
  `(sourceId, fileId)`.
- **`fileId` is opaque and stable.** Providers choose it (a relative path for
  LocalFolder, a song id for Subsonic, `torrentId:fileIndex` for debrid). The
  scanner diffs listings by it.
- **Declarative config.** `configSchema` is a flat list of typed fields
  (`string | url | path | number | boolean | select | secret`). The server
  validates with the shared validator. The client renders the form from it.
  `secret` fields are encrypted at rest, write-only from the API, and
  redacted everywhere. `hidden` fields are provider-managed state (e.g.
  rotated OAuth tokens) that the UI never shows.
- **`ResolvedStream.url` may be `file://`.** LocalFolder returns a `file://`
  URL and the streaming layer serves it from disk with byte ranges. Every
  other provider returns `http(s)://` and the streaming layer proxies or
  redirects.
- **`redirectSafe`.** A provider sets this flag only when the URL and headers
  carry no credentials. Subsonic URLs embed auth params, so they are always
  proxied. A source's `streamMode: 'redirect'` setting is honored only when
  the resolved stream is `redirectSafe`. Otherwise the server proxies,
  because keys must never reach a client.
- **Expiry.** `expiresAt` lets the streaming layer cache resolutions and
  re-resolve before they lapse. If the upstream returns 401/403/404/410
  mid-session, the cached link is evicted and resolved once more.
- **Tags.** Providers that get metadata cheaply (Subsonic, IA) attach `tags`
  to `SourceFile`. Providers that can read the file (LocalFolder) implement
  `readTags`. For everything else (debrid), the scanner falls back to
  probing the head of the stream with HTTP range requests through
  music-metadata, and then to filename parsing.
- **Context, not globals.** Providers get a `ProviderContext` with a
  redacting logger, a `fetch` with timeouts and a proper User-Agent, a small
  per-source state store, and `updateSecrets()` for rotated OAuth tokens.
  Providers never touch the database or `process.env` directly.
- **Errors.** Providers throw `ProviderError` with a code (`auth`,
  `not_found`, `rate_limited`, `unavailable`, `config`, `expired`). The API
  maps codes to HTTP statuses and user-facing messages.

### Debrid

`apps/server/src/providers/debrid/types.ts` defines `DebridAdapter`:

```ts
interface DebridAdapter {
  testConnection(): Promise<DebridAccountInfo>;
  listFiles(opts): AsyncIterable<DebridFile>;           // account contents only
  resolveLink(file, opts): Promise<DebridResolvedLink>; // unrestrict → direct URL
}
interface DebridAdapterDefinition {
  id, name, website,
  deviceFlow?: DebridDeviceFlow;       // RD / AllDebrid PIN / Premiumize, where supported
  create(credentials, ctx): DebridAdapter;
}
```

`createDebridPlugin(definition)` turns each adapter into a normal
`ProviderPlugin`, so Real-Debrid, AllDebrid, TorBox and Premiumize appear as
four separate entries in Settings > Sources. The bridge owns the
debrid-specific shared behavior: filtering to audio extensions, lazy
credential checks, a default link TTL, and mapping account status to a "Test
connection" result. Adapters stay thin HTTP mappers that are easy to test
with mocked responses.

Link caching is **not** debrid-specific. `providers/resolve-cache.ts`
(`ResolveCache`) wraps *any* provider's `resolveStream`. It reuses a
resolution until shortly before `expiresAt`, shares one in-flight request
between concurrent plays, and supports `invalidate()` + `forceRefresh` for
links that die early.

---

## 4. Backend design (Stage 2 — built)

The full endpoint list is in [`docs/api.md`](api.md).

### Configuration (env)

| Var | Purpose |
|---|---|
| `OVERTONE_SECRET_KEY` | **Required.** 32-byte key (base64 or hex); `OVERTONE_SECRET_KEY_FILE` for Docker secrets. HKDF derives separate subkeys for stored secrets (AES-256-GCM), access tokens, stream tokens and artwork tokens. Generate with `openssl rand -base64 32`. |
| `OVERTONE_DATA_DIR` | SQLite DB + artwork cache. Default `./data` (`/data` in Docker). |
| `OVERTONE_MUSIC_DIR` | Folder auto-added as a "Music" LocalFolder source on first boot. Default `/music`; empty disables it. |
| `OVERTONE_PORT` / `OVERTONE_HOST` | Default `4800` / `0.0.0.0`. |
| `OVERTONE_CORS_ORIGINS` | Extra allowed origins. `https://localhost`, `http://localhost`, `capacitor://localhost` are always allowed. |
| `OVERTONE_MB_CONTACT` | Contact for the MusicBrainz User-Agent. |
| `OVERTONE_MULTI_USER` | `false` (default) → single user. |
| `OVERTONE_SCAN_INTERVAL_MINUTES` | Full rescan interval, default 360 (0 = off). |
| `OVERTONE_TRUST_PROXY` | Set when behind a reverse proxy. |
| `OVERTONE_LOG_LEVEL` | Default `info`. |

Stream and artwork URLs are returned **relative** (`/api/stream/…`), and
clients prefix their configured server URL. No public-URL setting is needed,
and the same response works for the PWA and the Android app.

### Database

better-sqlite3 in WAL mode with append-only numbered migrations
(`db/migrations.ts`, version kept in `PRAGMA user_version`).

```
users            id, username (NOCASE unique), password_hash, is_admin
refresh_tokens   token_hash, family_id, expires_at, used_at, revoked_at   (hashed, rotated)
sources          id, provider_id, name, enabled, priority, stream_mode, config_json, secrets_enc
provider_state   (source_id, key) → value_json
source_files     id AUTOINCREMENT, (source_id, file_id) unique, path, size, mtime, tags_json,
                 tags_status, track_id, match_status, match_score, match_candidates_json, scan_id
artists          key unique ('mb:<mbid>' | 'local:<name>'), mbid, name, sort_name, search_text
releases         id AUTOINCREMENT, key unique, mbid, release_group_mbid, title, artist_id, year,
                 cover_status (unknown|caa|embedded|none)
tracks           key unique ('mb:<recording>:<release>' | 'local:…'), recording_mbid, release_id,
                 artist_id, title, disc_no, track_no, duration_ms, search_text
available_tracks VIEW: tracks with at least one file on an enabled source
mb_cache         key → status, body, expires_at
```

**Dedup.** A `track` is one recording on one release. Every file that
matches the same `(recording, release)` points at the same row, which is
how "the same song in two sources" shows as one row with two source badges.
Before MusicBrainz matching (or when it fails), a file gets a *provisional*
track keyed on normalized tags. The library is browsable seconds after a
scan, and identical untagged copies still dedupe. Playback picks the
lowest-`priority` enabled source (local 0, servers 5, others 10).

Ids that appear in URLs (`releases`, `source_files`) use `AUTOINCREMENT`, so
a deleted row's id is never reused by something else.

### Auth

- Passwords: `scrypt` (N=2¹⁵, r=8) from `node:crypto`. No native deps.
  Unknown usernames cost the same time as wrong passwords.
- **Access token:** HS256 JWT, 15 min, `Authorization: Bearer`. The header
  is pinned, so `alg` confusion and `none` are rejected.
- **Refresh token:** opaque 256-bit, stored as SHA-256, 30-day sliding
  window, single-use. Replaying a rotated token revokes the whole session
  family. A replay within 20 s of rotation returns `refresh_race` instead, so
  a client that double-fires doesn't log itself out. A password change
  revokes every session.
- **Stream tokens** (`?st=`): HMAC over `(userId, sourceFileId, exp)`, 6 h,
  valid for that one file. **Artwork tokens** (`?at=`): per user, expiry
  aligned to a day boundary so cover URLs stay cacheable. Both are needed
  because `<audio>`, `<img>` and Android's native player can't send headers.
  Both are rejected once the user is deleted.
- Request logs redact `st`/`at`/key-like query params and the
  `Authorization` header. Provider loggers additionally scrub any current
  secret value.
- Login, setup and password change are rate-limited (10/min/IP).
- CORS uses an explicit allowlist, with credentials off.
- Single-user by default: `POST /api/auth/setup` works once. With
  `OVERTONE_MULTI_USER=true`, admins manage users via `/api/users`. Source
  management and fix-match are admin-only.

### Library scanning

`LibraryScanner` processes one source at a time.

1. List the source and upsert files, diffed by id + size + mtime.
2. Remove files that weren't seen. **Exception:** a previously non-empty
   source that suddenly lists zero files (an unmounted drive or an API
   outage) keeps its library, and the scan reports an error.
3. Read tags for new or changed files. Sources, in priority order: tags
   from the listing (Subsonic, IA), then `provider.readTags()`
   (LocalFolder), then a 256 KB range-request probe (debrid), then
   filename parsing. Provisional tracks are attached right away.
4. Kick the `MatchWorker`.

Triggers: on boot, every `OVERTONE_SCAN_INTERVAL_MINUTES`, on source
create/update, from a recursive `fs.watch` (15 s debounce), and from
`POST /api/sources/:id/scan`.

### Metadata

- **MusicBrainz client:** a single process-wide queue with request starts
  ≥1.1 s apart, `User-Agent: Overtone/<ver> ( <contact> )`, and retry with
  backoff on 5xx/429. Responses are cached in `mb_cache` (30 d entities, 7 d
  searches, 1 d misses), and identical in-flight requests are coalesced.
- **Matcher** (`metadata/matcher/`), cheapest strategy first:
  1. **MBIDs in tags** (Picard): one cached release lookup, trusted as score 1.
  2. **Album strategy:** for a folder whose files share an album tag, search
     the release once, fetch up to 3 candidate tracklists, and assign files
     by disc/track number or title. That's about 2–4 requests per album
     instead of one per track.
  3. **Per-recording search** for anything left, with a bonus for releases
     the rest of the folder matched.

  Scoring blends title similarity, artist similarity (with ligature and
  diacritic folding, `feat.` stripping and word-order tolerance), duration
  difference, album similarity, track-number agreement, and a preference
  for official studio albums. A title alone never auto-matches. Score
  ≥ 0.85 → `matched`. 0.6–0.85 → `needs_review` (the best guess is
  applied). Lower → `unmatched` (the file keeps its tag-based track).
  MusicBrainz outages pause matching and retry in 5 min. Files are never
  marked unmatched because MusicBrainz was down.
- **Fix match:** file-level search (scored against the file),
  pin-a-recording, album-level "use this release", and rematch. Manual
  matches survive rescans.
- **Cover Art Archive:** release `front-{250,500,1200}`, then the release
  group, then embedded pictures (`provider.readArtwork`). Images are cached
  on disk under `<data>/artwork`. Misses are retried after 7 days.

### Streaming

`GET /api/stream/:sourceFileId?st=…` (a Bearer token is also accepted)

1. Verify the token (it must be for this file), check the source is
   enabled, then `resolveStream` through `ResolveCache`.
2. `file://` → served from disk with `Range`/`206`/`416`, `Accept-Ranges`
   and `Content-Type`.
3. `http(s)://` → `302` only if the source's `streamMode` is `redirect`
   **and** the resolution is `redirectSafe` **and** it needs no headers.
   Otherwise it's proxied: `Range`/`If-Range` and provider headers go
   upstream, and only status, type, length, range, ETag and Last-Modified
   are relayed back. Upstream cookies and custom headers are dropped.
4. If upstream returns 401/403/404/410, invalidate the link, re-resolve
   with `forceRefresh`, and retry once.
5. A client disconnect aborts the upstream request (seeking creates many
   short requests).

### Deployment

`Dockerfile` (multi-stage, `node:22-bookworm-slim`, runs as uid 1000,
healthcheck on `/api/health`) and `docker-compose.yml`. The music volume is
mounted read-only.

---

## 5. Web client (Stage 3)

- React + Vite + React Router. State lives in a lightweight store (Zustand)
  plus TanStack Query for API caching. CSS variables give light/dark themes
  that follow the system setting, with a manual override.
- **Server URL** is a first-run screen and lives in Settings. It defaults to
  the page's origin when served by the backend. Stored with the tokens
  through a `platform/storage` abstraction (localStorage on web, secure
  storage on Android).
- **API client:** attaches the access token and refreshes on 401 with a
  single-flight lock, then retries once.
- **Player:** a `PlayerEngine` interface with an `HtmlAudioEngine` that uses
  two `<audio>` elements. The next track is preloaded and started on `ended`
  (or a few ms before, via `timeupdate`) for gapless-ish transitions. Queue,
  shuffle (Fisher–Yates that keeps the current track), repeat
  off/all/one, and seeking through native range support.
- **Media Session API:** metadata, artwork, and play/pause/next/prev/seek
  handlers.
- **PWA:** `vite-plugin-pwa`, a manifest, an app-shell precache, and a
  runtime cache for artwork. Audio is never cached by the service worker.
- Views: Home (recent, recently added, random albums), Library
  (Artists/Albums/Tracks tabs), Search, Album, Artist, Now Playing, and
  Settings (Server, Account, Sources, Appearance). Source badges appear on
  track rows.

## 6. Android (Stage 5)

- Capacitor (latest stable) wrapping `apps/web` with the same build.
  `android/` lives under `apps/web`.
- **Background playback:** a webview's `<audio>` gets throttled or killed in
  the background, so Android uses a small local Capacitor plugin,
  `NativePlayer`, backed by **Media3 ExoPlayer + MediaSessionService**. That
  gives a foreground service, the media notification with controls, audio
  focus (duck/pause on calls), and the becoming-noisy (headphones unplugged)
  pause. The web UI picks `NativeEngine` under Capacitor and `HtmlAudioEngine`
  on the web through the same `PlayerEngine` interface. The queue stays in
  JS, and the native side holds the current and next item for gapless
  playback.
- **Secure token storage:** Android Keystore-backed secure storage plugin,
  wrapped by `platform/storage`.
- Cleartext HTTP to LAN IPs is allowed only via an opt-in network-security
  config. HTTPS (Tailscale/reverse proxy) is the documented path.
- `docs/remote-access.md` covers two options: Tailscale (MagicDNS +
  `tailscale serve` for HTTPS) and Caddy/Traefik with Let's Encrypt.

## 7. Testing

- Vitest across the workspace.
- Matcher: table-driven tests over tag/filename fixtures, scoring edge cases,
  and a mocked MB client.
- Providers: every adapter tested against recorded/mocked HTTP responses
  (`undici` MockAgent), covering listing, audio filtering, pagination, link
  resolution, expiry, and auth errors.
- Server: route tests via `fastify.inject` (auth flows, token rotation and
  reuse detection, range requests, redaction: secrets must never appear in
  any response or log line).

## 8. Stages

| # | Stage | Commit(s) |
|---|---|---|
| 1 | Folder structure, plan, provider + debrid interfaces, config schema/validator, registry, debrid bridge, resolve cache, tests | ✅ |
| 2 | DB schema & migrations, auth, crypto, MusicBrainz/CAA, matcher, scanner, LocalFolder, streaming, Docker | ✅ |
| 3 | Web app: library, search, album, player, Media Session, PWA, themes | |
| 4 | Subsonic, Internet Archive, Real-Debrid/AllDebrid/TorBox/Premiumize adapters, Settings > Sources (+ test connection, device flow) | |
| 5 | Capacitor Android: NativePlayer plugin, notification, focus, secure storage, docs | |
| 6 | Polish, test coverage, README/docs | |

## 9. Decisions

Agreed after stage 1:

1. **Debrid:** four separate source types (Real-Debrid, AllDebrid, TorBox,
   Premiumize).
2. **Streaming:** proxy by default. Redirect is a per-source opt-in, and it
   applies only to resolutions that carry no credentials. Both conditions
   are enforced server-side, and providers whose links always carry
   credentials can't be set to redirect at all.
3. **Internet Archive:** limited to a configured collection or query of
   public-domain / Creative Commons audio.
4. **No transcoding in v1.**
5. **TypeScript 7.0**, exact version pinned.

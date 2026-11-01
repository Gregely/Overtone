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

## 4. Backend design (Stage 2)

### Configuration (env)

| Var | Purpose |
|---|---|
| `OVERTONE_SECRET_KEY` | 32-byte key (base64/hex). AES-256-GCM for stored secrets and HMAC for stream tokens. **Required.** Generate with `openssl rand -base64 32`. |
| `OVERTONE_DATA_DIR` | SQLite DB, caches. Default `/data`. |
| `OVERTONE_MUSIC_DIR` | Default LocalFolder mount. Default `/music`. |
| `OVERTONE_PUBLIC_URL` | Used to build absolute stream URLs for clients. |
| `OVERTONE_CORS_ORIGINS` | Comma list. Defaults include `capacitor://localhost`, `http://localhost`, `https://localhost`. |
| `OVERTONE_MB_CONTACT` | Contact (email/URL) for the MusicBrainz User-Agent. |
| `OVERTONE_MULTI_USER` | `false` (default) → single user. First-run setup creates the admin. |

### Database (better-sqlite3, WAL mode, hand-rolled numbered migrations)

```
users(id, username, password_hash, is_admin, created_at)
refresh_tokens(id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by, user_agent, created_at)
sources(id, plugin_id, name, enabled, config_json, secrets_enc, stream_mode, last_scan_at, last_error)
provider_state(source_id, key, value_json)
source_files(source_id, file_id, name, path, size, mime, modified_at, duration_ms,
             tags_json, track_id NULL, match_status, match_score, seen_at,
             PRIMARY KEY(source_id, file_id))
artists(id, mbid UNIQUE NULL, name, sort_name)
releases(id, mbid UNIQUE NULL, release_group_mbid, title, artist_credit, date, cover_url)
tracks(id, recording_mbid NULL, release_id, title, artist_credit, artist_id,
       disc_no, track_no, duration_ms, UNIQUE(recording_mbid, release_id))
mb_cache(key PRIMARY KEY, body_json, status, fetched_at, expires_at)
playlists / play_history (later)
```

**Dedup.** A `track` is one recording on one release. Multiple
`source_files` can point to the same `track_id`. That is the "same song from
two sources" case, and the UI shows one row with several source badges.
Playback picks the best available source (local first, then by user
priority). Unmatched files still get a `track` row (no MBID) so nothing
disappears from the library.

### Auth

- Passwords: `scrypt` from `node:crypto`, so the Pi build needs no native
  argon2.
- **Access token:** JWT (HS256, 15 min), sent as `Authorization: Bearer`.
- **Refresh token:** opaque 256-bit random, stored *hashed*, 30-day sliding
  window, **rotated on every use** with reuse detection. A replayed refresh
  token revokes its whole family.
- **Stream tokens:** `<audio>` elements and Android's native player can't
  attach headers. Track URLs therefore carry a short-lived HMAC token scoped
  to `(userId, trackSourceId)`, e.g. `?st=…`, valid ~6h. Clients get these
  from the API, never construct them.
- **CORS:** `@fastify/cors` with an explicit allowlist (env), credentials
  off. Tokens travel in headers, not cookies.
- Single-user by default: first-run `POST /api/setup` creates the admin and
  then locks. Multi-user lets the admin create accounts.

### Metadata

- **MusicBrainz client:** a single global queue, ≤1 req/s with a backoff on
  503, a `User-Agent: Overtone/<ver> ( <contact> )` header, and responses
  cached in `mb_cache` (30 days for entities, 7 days for searches, 1 day for
  misses).
- **Cover Art Archive:** `front-250`/`front-500` thumbnails, resolved per
  release (falling back to release group). URLs are cached and images are
  proxied with long-lived cache headers. Embedded art is extracted for local
  files as a fallback.
- **Matcher** (pure, heavily tested), in this order:
  1. MBIDs in tags (`MUSICBRAINZ_TRACKID`, Picard-tagged files) win outright.
  2. Otherwise build a query from tags (artist, title, album, track number,
     duration) or from the parsed filename/path (`Artist/Album/01 - Title.flac`,
     `Artist - Title.mp3`, …).
  3. Search MB recordings and score candidates: normalized string
     similarity (title, artist, release), a duration delta penalty,
     track-number agreement, and consistency with other files in the same
     folder (album coherence).
  4. Score ≥ 0.85 → auto-match. 0.6–0.85 → `needs_review`. Below that →
     `unmatched`.
  5. **Fix match** API/UI: search MB, pick a recording/release, and pin it
     (`match_status = manual`, never overwritten by rescans).

### Streaming

`GET /api/stream/:sourceId/:fileId?st=…`

1. Verify the stream token, look up the source, then `resolveStream` through `ResolveCache`.
2. `file://` → serve from disk with `Range`/`206`, `Accept-Ranges`, and
   correct `Content-Type`.
3. `http(s)://` → if `streamMode=redirect` **and** `redirectSafe`, send a
   `302`. Otherwise proxy with `undici`, forwarding `Range` and provider
   headers and relaying status, length, and range headers. Upstream auth
   headers are never echoed back.
4. If upstream returns 401/403/404/410, evict, re-resolve once, and retry.

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
| 1 | Folder structure, plan, provider + debrid interfaces, config schema/validator, registry, debrid bridge, resolve cache, tests | ← **this commit; stop for approval** |
| 2 | DB schema & migrations, auth, crypto, MusicBrainz/CAA, matcher, scanner, LocalFolder, streaming, Docker | |
| 3 | Web app: library, search, album, player, Media Session, PWA, themes | |
| 4 | Subsonic, Internet Archive, Real-Debrid/AllDebrid/TorBox/Premiumize adapters, Settings > Sources (+ test connection, device flow) | |
| 5 | Capacitor Android: NativePlayer plugin, notification, focus, secure storage, docs | |
| 6 | Polish, test coverage, README/docs | |

## 9. Open questions for you

1. **Debrid in Settings:** four separate source types (current design), or one
   "Debrid" type with a service dropdown? Separate types keep each form
   simpler and allow device-flow buttons per service.
2. **Default stream mode:** proxy everything by default (safest, and the Pi
   pays the bandwidth), or redirect where `redirectSafe`? Current plan:
   **proxy** by default, redirect opt-in per source.
3. **Internet Archive scope:** the plan is user-configured *collections or
   saved searches* (e.g. `collection:etree`, `licenseurl:*creativecommons*`)
   that define what appears in the library. That is a curated listing of
   openly licensed audio, not a general search-and-add feature. OK?
4. **Transcoding:** confirm it is out of scope for v1.

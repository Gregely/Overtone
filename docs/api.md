# REST API

All endpoints live under `/api`. Request and response types are exported from
[`@overtone/shared`](../packages/shared/src/api.ts), so clients get them
type-checked.

**Auth.** Send `Authorization: Bearer <accessToken>` unless an endpoint is
marked *public* or *URL token*. Tokens come from setup, login or refresh.
Access tokens last 15 minutes; refresh before they expire, or on a `401`.

**Errors.** Every non-2xx response has this shape:

```json
{ "error": { "code": "validation_failed", "message": "Some fields are invalid", "fields": { "config.url": "Must be an http(s) URL" } } }
```

Provider failures use the codes `provider_auth`, `provider_not_found`,
`provider_unavailable`, `provider_rate_limited`, `provider_config` and
`provider_subscription`.

## Auth & account

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | public | `{ ok, version }` |
| GET | `/auth/status` | public | `{ setupRequired, multiUser, version }` → show first-run setup if `setupRequired` |
| POST | `/auth/setup` | public | `{ username, password, deviceName? }` → `AuthTokensDto`. Only works while no users exist. |
| POST | `/auth/login` | public | Same body → `AuthTokensDto`. Rate-limited to 10/min. |
| POST | `/auth/refresh` | public | `{ refreshToken }` → new `AuthTokensDto`. **Refresh tokens are single-use**; always store the new one. `401 refresh_race` means another request already rotated this token: use the newer one. `401 refresh_token_reused` / `invalid_refresh_token` means log in again. |
| POST | `/auth/logout` | public | `{ refreshToken }` → 204. Revokes this device's session. |
| GET | `/me` | bearer | `UserDto` |
| POST | `/me/password` | bearer | `{ currentPassword, newPassword }` → 204. Logs out all sessions. |
| GET/POST | `/users` | admin | List / create (`{ username, password, isAdmin? }`). Create needs `OVERTONE_MULTI_USER=true`. |
| DELETE | `/users/:id` | admin | |

## Library

| Method | Path | Notes |
|---|---|---|
| GET | `/library/home` | `HomeDto`: recently added and random albums, plus stats |
| GET | `/library/artists?q&offset&limit` | `PageDto<ArtistDto>` |
| GET | `/library/artists/:id` | `ArtistDetailDto` (artist + albums) |
| GET | `/library/albums?q&sort&artistId&offset&limit` | `sort`: `name` (default), `recent`, `year`, `artist`, `random` |
| GET | `/library/albums/:id` | `AlbumDetailDto` (album + ordered tracks) |
| GET | `/library/tracks?q&sort&offset&limit` | `sort`: `name`, `recent`, `artist` |
| GET | `/library/tracks/:id` | `TrackDto` |
| GET | `/search?q=` | `SearchResultDto`: artists, albums and tracks; every word must match |

Every `TrackDto` has `sources[]`, one badge per source the track can play from.
`coverUrl` is a relative URL that carries its own token, so it can be used
directly in `<img>` (append `&size=250|500|1200`; default 500).

## Playback

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/stream-urls` | bearer | `{ trackIds, preferSourceId? }` → `{ items: StreamUrlDto[], unavailable }`. Each `url` is valid for 6 h and works for that one file. |
| GET/HEAD | `/stream/:sourceFileId?st=` | URL token | Audio bytes. Supports `Range` (206/416). May `302` to a public URL when the source is set to redirect and the link has no credentials. |
| GET | `/artwork/release/:id?at=&size=` | URL token | Cover image, or 404 when there is none. |

Clients prefix relative URLs with their configured server URL. Playing a
queue usually means one `/stream-urls` call for the next few tracks, then
fetching more as the queue advances or when `expiresAt` nears.

## Sources (admin)

| Method | Path | Notes |
|---|---|---|
| GET | `/providers` | Plugin catalog with `configSchema` for rendering forms (any user) |
| GET/POST | `/sources` | List / create `{ providerId, name?, enabled?, priority?, streamMode?, config }` |
| GET/PATCH/DELETE | `/sources/:id` | PATCH merges `config`. For secrets: omit or `""` keeps the value, `null` clears it. Secret values are never returned; `config.secretsSet` lists which are set. |
| POST | `/providers/:providerId/test` | `{ config }` → `ConnectionTestResultDto` (test before saving) |
| POST | `/sources/:id/test` | `{ config? }`: test the saved source, optionally with edited fields; stored secrets fill the gaps |
| POST | `/sources/:id/scan`, `/scan` | Queue a rescan of one source or all → `ScanStatusDto` (202) |
| GET | `/scan/status` | `ScanStatusDto`: running scan, queue, pending matches, recent reports |

`streamMode: "redirect"` is rejected with 422 for providers whose links always
carry credentials (LocalFolder, Subsonic).

## Fix match (admin)

| Method | Path | Notes |
|---|---|---|
| GET | `/library/files?status&sourceId&trackId` | `PageDto<LibraryFileDto>`; `status=needs_review` drives the review queue |
| GET | `/library/files/:id` | One file with tags and top candidates |
| GET | `/library/files/:id/candidates?title&artist` | Search MusicBrainz, scored against the file (title/artist override the tags) |
| POST | `/library/files/:id/match` | `{ recordingMbid, releaseMbid? }` → pins the file as `manual`; rescans won't change it |
| POST | `/library/files/:id/rematch` | Clears a match and queues the file for automatic matching |
| GET | `/match/releases?q&artist` | `ReleaseCandidateDto[]` for album-level fixes |
| POST | `/library/albums/:id/match` | `{ releaseMbid }` → re-assigns every file of the album to that release's tracklist |

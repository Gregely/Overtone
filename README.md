# Overtone

*(placeholder name)*: a self-hostable music streaming server with a
Stremio-style pluggable source system. You point it at your local folders,
a Navidrome/Subsonic server, Internet Archive collections, or the audio
already in your debrid account. It merges them into one MusicBrainz-matched
library and streams to a PWA and an Android app.

> **Status: stage 1 of 6** (architecture, folder structure, provider interface).
> Nothing runs yet. See [`docs/PLAN.md`](docs/PLAN.md) for the full design and
> roadmap.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Types + helpers shared by server and clients (config schema, API DTOs, audio helpers) |
| `apps/server` | Fastify + SQLite backend; all provider and debrid logic |
| `apps/server/src/providers/types.ts` | **The plugin interface** |
| `apps/server/src/providers/debrid/types.ts` | Debrid adapter interface |
| `apps/web` | React + Vite PWA, later wrapped by Capacitor for Android (stage 3/5) |
| `docs/` | Plan, provider guide, and later remote access + Android docs |

## Development

Requires Node 22+.

```sh
npm install
npm run typecheck
npm test
```

## Writing a provider

See [`docs/providers.md`](docs/providers.md).

## Scope note

Debrid support is limited to **files already in your own account**. Overtone
does not include, and will not include, torrent indexers, magnet search, or
any "find and add content" feature.

# Overtone

*(placeholder name)*: a self-hostable music streaming server with a
Stremio-style pluggable source system. You point it at your local folders,
a Navidrome/Subsonic server, Internet Archive collections, or the audio
already in your debrid account. It merges them into one MusicBrainz-matched
library and streams to a PWA and an Android app.

> **Status: stage 2 of 6.** The backend runs. Local folders are scanned,
> matched to MusicBrainz, browsable and streamable over the REST API. The
> web app comes in stage 3; Subsonic, Internet Archive and debrid sources
> in stage 4. See [`docs/PLAN.md`](docs/PLAN.md).

## Run it (Docker, e.g. on a Raspberry Pi 4/5)

```sh
git clone https://github.com/gregely/overtone && cd overtone
cp .env.example .env
# Edit .env: set OVERTONE_SECRET_KEY (openssl rand -base64 32) and MUSIC_DIR
mkdir -p data
docker compose up -d
```

The server listens on port 4800. On first start it adds your `MUSIC_DIR`
(mounted read-only) as a source and scans it. The first API call should be
`POST /api/auth/setup` to create the admin account. The web UI will handle
this in stage 3; until then, see [`docs/api.md`](docs/api.md).

Back up `./data` (SQLite database + artwork cache) and your `.env`. Without
`OVERTONE_SECRET_KEY`, saved provider credentials can't be decrypted.

MusicBrainz allows about one request per second. Overtone matches whole
albums with a few requests each, but a first scan of a large library still
takes a while. The library is browsable from file tags straight away, and
matches fill in over time.

## Develop

Requires Node 22+.

```sh
npm install
npm run typecheck
npm test
OVERTONE_SECRET_KEY=$(openssl rand -base64 32) OVERTONE_MUSIC_DIR=~/Music npm run dev:server
```

## Layout

| Path | What |
|---|---|
| `packages/shared` | Types + helpers shared by server and clients (config schema, API DTOs, audio helpers) |
| `apps/server` | Fastify + SQLite backend; all provider and debrid logic |
| `apps/server/src/providers/types.ts` | **The plugin interface** |
| `apps/server/src/providers/debrid/types.ts` | Debrid adapter interface |
| `apps/server/src/metadata/matcher` | Tag/filename → MusicBrainz matcher |
| `apps/web` | React + Vite PWA, later wrapped by Capacitor for Android (stages 3 and 5) |
| `docs/` | [Plan](docs/PLAN.md), [API](docs/api.md), [writing a provider](docs/providers.md) |

## Scope note

Debrid support is limited to **files already in your own account**. Overtone
does not include, and will not include, torrent indexers, magnet search, or
any "find and add content" feature.

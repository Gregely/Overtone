# Overtone

*(placeholder name)*: a self-hostable music streaming server with a
Stremio-style pluggable source system. You point it at your local folders,
a Navidrome/Subsonic server, Internet Archive collections, or the audio
already in your debrid account. It merges them into one MusicBrainz-matched
library and streams to a PWA and an Android app.

> **Status: stage 5 of 6.** The server, the installable web app, and an
> Android app (Capacitor + native Media3 playback) work with every source
> type: local folders, Subsonic/Navidrome, Internet Archive, Real-Debrid,
> AllDebrid, TorBox and Premiumize. See [`docs/PLAN.md`](docs/PLAN.md).

## Run it (Docker, e.g. on a Raspberry Pi 4/5)

```sh
git clone https://github.com/gregely/overtone && cd overtone
cp .env.example .env
# Edit .env: set OVERTONE_SECRET_KEY (openssl rand -base64 32) and MUSIC_DIR
mkdir -p data
docker compose up -d
```

Open `http://<server>:4800`. On first start Overtone adds your `MUSIC_DIR`
(mounted read-only) as a source and scans it, and the web app asks you to
create the admin account.

Back up `./data` (SQLite database + artwork cache) and your `.env`. Without
`OVERTONE_SECRET_KEY`, saved provider credentials can't be decrypted.

MusicBrainz allows about one request per second. Overtone matches whole
albums with a few requests each, but a first scan of a large library still
takes a while. The library is browsable from file tags straight away, and
matches fill in over time.

## Running the web app

The Docker image includes the web app, so there's nothing extra to run:
the server hosts it at `/`.

- **First run:** the app shows a *Welcome* screen. Create the admin account
  there, then sign in on other devices with the same credentials.
- **Server address:** on the web it defaults to the address you opened. The
  login screen has a *Change* button for pointing the app at a different
  Overtone server; it's remembered per device.
- **Install it:** in Chrome/Edge/Android use *Install app* / *Add to Home
  screen*; in Safari on iOS use *Share → Add to Home Screen*. The installed
  app opens offline. If the server can't be reached it says so and offers
  *Try again* instead of showing a blank page.
- **Lock screen / notification controls** work through the Media Session
  API, with album art.
- **HTTPS:** browsers only allow service workers (installing, offline shell)
  on `https://` or `localhost`. On a LAN IP over plain HTTP the app still
  works but can't be installed. For access away from home, use Tailscale or
  a reverse proxy with HTTPS. See [`docs/remote-access.md`](docs/remote-access.md).
- **Admins** also get *Settings › Sources* (add, edit, test, scan and delete
  sources; saved keys are never shown again) and a *Review matches* queue
  for files that couldn't be confidently identified.
- **Keyboard:** <kbd>Space</kbd>/<kbd>K</kbd> play/pause, <kbd>J</kbd>/<kbd>L</kbd>
  ±10 s, <kbd>Shift</kbd>+<kbd>N</kbd>/<kbd>P</kbd> next/previous,
  <kbd>/</kbd> search.

### Developing the web app

```sh
# terminal 1: API server on :4800
OVERTONE_SECRET_KEY=$(openssl rand -base64 32) OVERTONE_MUSIC_DIR=~/Music npm run dev:server
# terminal 2: Vite dev server on :5173, proxying /api to :4800
npm run dev:web
```

The service worker is only active in production builds (`npm run build`,
then serve `apps/web/dist` from the server with `OVERTONE_WEB_DIR`).

## Standalone or server: which to choose?

| | **Standalone** (Android app default) | **Server mode** |
|---|---|---|
| What runs where | Everything inside the app on your phone | An Overtone server (e.g. Raspberry Pi) + browser/app clients |
| Setup | Install the APK, add sources | Docker, accounts, HTTPS for remote access |
| Library | One device | Shared by all your devices and users |
| Music on the device | "This device" folders (Android folder picker) | Folders on the server |
| Keys and tokens | Android Keystore on the phone | Encrypted on the server; never sent to clients |
| Streaming | Device plays provider links directly | Server proxies (or redirects when safe) |

Pick **standalone** for one phone and no infrastructure; pick **server mode**
for several devices or a shared library. The app asks on first launch and you
can switch in *Settings › Mode*; each mode keeps its own data. Architecture:
[docs/PLAN.md §6b](docs/PLAN.md).

## Android app

A native Android app built from the same code (Capacitor). It plays in the
background through a Media3 foreground service, with a media notification,
lock-screen and Bluetooth/headset controls, audio focus, pause on headphone
unplug, and near-gapless track changes. Tokens are kept in Android Keystore
encrypted storage.

```sh
export ANDROID_HOME=~/android-sdk   # Android SDK; JDK 21 on PATH
npm run android:keystore            # once: release signing key (back it up!)
npm run android:build               # → apps/web/android-dist/*.apk / *.aab
```

Then sideload `overtone-<version>-release.apk`. On first launch, enter your
server address; `https://` is recommended (Tailscale makes it one command).
Plain `http://` works only to local-network names and the private IPs you
list in `apps/web/app.config.json`.

**Permissions:** `INTERNET`, `FOREGROUND_SERVICE` +
`FOREGROUND_SERVICE_MEDIA_PLAYBACK` (background playback), `POST_NOTIFICATIONS`
(media notification, asked on first play), `WAKE_LOCK` (streaming with the
screen off), and `ACCESS_NETWORK_STATE` (added by the Media3 library).
There are no analytics, ads, or tracking SDKs.

The full guide is in [`docs/android.md`](docs/android.md): toolchain
versions, package ID, signing and backups, sideloading, updating, the HTTP
policy and its tradeoffs, and a device test checklist. The Android build and
native unit tests run in this repo's environment, but on-device playback has
**not** been tested yet.

## Sources

Add them in *Settings › Sources*. Each form is generated from the provider's
schema. Saved keys and passwords are encrypted on the server and never shown
again.

| Source | What it plays | Sign-in |
|---|---|---|
| Local folder | Files under a folder on the server (Docker: `MUSIC_DIR`) | — |
| Subsonic / Navidrome | Everything on a Subsonic or OpenSubsonic server | Username + password (sent as a salted token), or an API key |
| Internet Archive | One collection or saved query, Creative Commons / public-domain audio only | — |
| Real-Debrid · AllDebrid · TorBox | Audio already in your account (finished torrents, downloads, saved links) | **Log in with …** button, or paste an API key |
| Premiumize.me | Audio already in your cloud | API key. *Log in with Premiumize* appears if you set `OVERTONE_PREMIUMIZE_CLIENT_ID` to a registered OAuth client. |

Debrid and Subsonic streams always go through your server. Their links carry
credentials or are tied to the server's IP. Expired links are refreshed
automatically.

## Writing a provider

A provider is a folder under `apps/server/src/providers/<id>/` exporting a
`ProviderPlugin`:

- a **manifest** with an id, a name, and a declarative `configSchema` (the
  Settings form is generated from it; `secret` fields are encrypted and
  write-only);
- **`listLibrary()`**, which yields the audio files that already exist in the
  source (`{ id, name, size, path, tags? }`);
- **`resolveStream(fileId)`**, which returns `{ url, headers?, expiresAt?,
  redirectSafe? }`.

Optionally it can also provide `testConnection()`, `readTags()`,
`readArtwork()`, `watch()`, or a **"Log in with …"** device flow, which is a
generic schema feature any provider can use. Debrid services implement the
smaller `DebridAdapter` interface instead.

Ground rules: use only the service's documented API, and cite the docs and
the date checked in the adapter's header. Keep it read-only (nothing that
adds content). Keep secrets out of errors and logs. Test against fixture
responses covering success, bad and expired keys, 429 backoff, network
failure, and an empty account.

The full guide, with a worked example, the rules, and the test kit, is in
[`docs/providers.md`](docs/providers.md).

## Develop

Requires Node 22+.

```sh
npm install
npm run typecheck
npm test            # unit + component tests (server, shared, web)
npm run test:e2e    # builds the web app, then a Playwright smoke test against a real test server
```

The e2e test needs a Chromium for Playwright (`npx playwright install chromium`
once, if you don't have one).

## Layout

| Path | What |
|---|---|
| `packages/shared` | Types + helpers shared by server and clients (config schema, API DTOs, audio helpers) |
| `apps/server` | Fastify + SQLite backend; all provider and debrid logic |
| `apps/server/src/providers/types.ts` | **The plugin interface** |
| `apps/server/src/providers/debrid/types.ts` | Debrid adapter interface |
| `apps/server/src/metadata/matcher` | Tag/filename → MusicBrainz matcher |
| `apps/web` | React + Vite PWA; also the Android app via Capacitor |
| `apps/web/android` | Capacitor Android project: Media3 playback service, Keystore storage plugin |
| `apps/web/app.config.json` | Android package id, app name, version, cleartext hosts |
| `apps/web/src/player` | Queue state machine, player controller (link refresh), audio engine, Media Session |
| `docs/` | [Plan](docs/PLAN.md), [API](docs/api.md), [writing a provider](docs/providers.md), [Android](docs/android.md), [remote access](docs/remote-access.md) |

## Scope note

Debrid support is limited to **files already in your own account**. Overtone
does not include, and will not include, torrent indexers, magnet search, or
any "find and add content" feature.

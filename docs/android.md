# Android app

The Android app is the same React app as the web version, wrapped with
**Capacitor 8**. Android-only code sits behind the web app's existing
platform abstractions:

| Concern | Web | Android |
|---|---|---|
| Audio | `HtmlAudioEngine` (two `<audio>` elements) | `NativeEngine` → **Media3 ExoPlayer + MediaSessionService** (foreground service) |
| Token storage | `localStorage` | **Android Keystore** (AES-256-GCM, `SecureStorage` plugin) |
| Server URL | page origin by default | entered on first launch, health-checked, saved securely, editable in *Settings › Server* |
| Lock screen / notification | Media Session API | Media3 media notification + session |

The `PlayerController` in JavaScript stays the source of truth for the queue,
shuffle/repeat and stream-link refresh. The native service plays the URLs
it's given and reports back.

## What the native player does

- **Background playback** in a foreground service of type `mediaPlayback`
  (Android 14+ typed service, permission `FOREGROUND_SERVICE_MEDIA_PLAYBACK`).
- **Media notification and lock screen** show the title, artist, album art,
  play/pause, next/previous and a seek bar. **Bluetooth and headset buttons**
  also work through the media session. Next and previous are forwarded to the
  JS queue (`RemoteCommandPlayer`).
- **Audio focus:** playback pauses for calls, ducks for notifications, and
  resumes afterwards (ExoPlayer `handleAudioFocus`).
- **Headphones unplugged** pauses playback ("becoming noisy").
- **Near-gapless:** the next track is preloaded as the second playlist item,
  and ExoPlayer moves into it without a gap. JS is told afterwards
  (`advanced` → `ended`) and catches up.
- **Expired or failed links:** ExoPlayer reports an error, with its position,
  to the existing `PlayerController`. That fetches a fresh signed URL and
  resumes at the same position, exactly as on the web.
- **After the app is killed:** the queue and position are saved, and the next
  launch restores them **paused** where you left off. Pressing play fetches a
  fresh link. The system "resume" card after a reboot isn't offered, because
  stream links are short-lived signed URLs that only the running app can
  refresh.
- **Notification permission** (Android 13+) is requested the first time you
  press play. Playback works without it; you just won't see the notification.

## Permissions

| Permission | Why |
|---|---|
| `INTERNET` | Talk to your Overtone server |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | Keep playing in the background (required on Android 14+) |
| `POST_NOTIFICATIONS` | Show the media notification (Android 13+; asked on first play) |
| `WAKE_LOCK` | Keep CPU and Wi-Fi awake while streaming with the screen off |
| `ACCESS_NETWORK_STATE` | Added by the Media3 ExoPlayer library (network-type detection). Normal permission; no prompt. |

There are no analytics, crash reporting, ads, Firebase/Google Play Services,
or tracking SDKs. Backups are disabled (`allowBackup=false`, with no
data-extraction backups): tokens are bound to this device's Keystore anyway.

## Connecting to your server

On first launch the app asks for the server address. It checks
`GET /api/health` and `/api/auth/status` before saving the address.

**HTTPS is the recommended path**, especially away from home. See
[remote-access.md](remote-access.md): Tailscale (`tailscale serve`) gives you
`https://<machine>.<tailnet>.ts.net` with a real certificate in one command.

**Plain HTTP** is limited by a network security config
(`android/app/src/main/res/xml/network_security_config.xml`, generated from
`app.config.json`):

- refused for every public host;
- allowed for local names: `localhost`, `*.local`, `*.lan`, `*.home`,
  `*.internal`, `*.home.arpa`, `*.ts.net`, and the emulator's `10.0.2.2`;
- allowed for **exact private IPs listed in `cleartextHosts`** in
  `apps/web/app.config.json`, e.g. `"cleartextHosts": ["192.168.1.20"]`.
  Android's config can't express IP ranges, so private IPs must be listed one
  by one. The build refuses public IPs and non-local names here.

The app also refuses `http://` to public hosts when you enter the address,
with a clear message.

**Tradeoff:** plain HTTP on your home Wi-Fi means anyone on that network can
read your traffic, including stream URLs and your access tokens. That's
acceptable for some home setups. Use HTTPS (Tailscale or a reverse proxy) if
other people or devices share the network, and always outside it. Traffic to
`*.ts.net` over plain HTTP is still encrypted by Tailscale's WireGuard
tunnel.

**Origins / CORS:** the WebView runs at `http://localhost` (Capacitor
`androidScheme: "http"`). That lets it call a plain-HTTP LAN server without
WebView "mixed content", which Capacitor documents as development-only. The
server allows `http://localhost`, `https://localhost` and
`capacitor://localhost` by default, so no server configuration is needed.
The native player fetches the signed stream URLs directly, sending `Range`
for seeking and no cookies or `Authorization` header.

## Build

Pinned toolchain (what the build was verified with):

| Tool | Version |
|---|---|
| Node.js | 22.x (22.23 tested) |
| JDK | 21 (OpenJDK 21.0.x) |
| Android SDK | platform `android-36`, build-tools `35.0.0` and `36.0.0`, platform-tools |
| Gradle / AGP | 8.14.3 (wrapper) / 8.13.0 |
| Capacitor | 8.6.0 (`@capacitor/core`, `android`, `cli`), `@capacitor/app` 8.1.2 |
| Media3 | 1.11.1 |

Android Studio Otter (2025.2.1) or newer works too. Open `apps/web/android`.

### 1. Install the SDK (command line)

```sh
# JDK 21 must be on PATH (java -version)
export ANDROID_HOME=$HOME/android-sdk
mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp
curl -LO https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip   # see developer.android.com/studio#command-tools for macOS/Windows
unzip -q commandlinetools-linux-*_latest.zip && mv cmdline-tools $ANDROID_HOME/cmdline-tools/latest
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0"
```

### 2. Configure (once)

Edit `apps/web/app.config.json`:

```json
{
  "appId": "app.overtone.player",
  "appName": "Overtone",
  "versionName": "0.5.0",
  "versionCode": 5,
  "cleartextHosts": []
}
```

`appId` is the Android package id: **the one value to change** if you want
your own. Choose it before your first install, because changing it later
creates a separate app.

### 3. Signing key (once, for release builds)

```sh
npm run android:keystore
```

This creates `apps/web/android/keystore/overtone-release.jks` and
`apps/web/android/keystore.properties`, with a random password. Both are
git-ignored. **Back up both files** in a password manager or another
encrypted backup. Without them you can't publish updates that install over
the existing app; users would have to uninstall, which loses their login and
queue. For CI, set `OVERTONE_KEYSTORE_FILE`, `OVERTONE_KEYSTORE_PASSWORD`,
`OVERTONE_KEY_ALIAS` and `OVERTONE_KEY_PASSWORD` instead.

### 4. Build

```sh
npm install
export ANDROID_HOME=$HOME/android-sdk
npm run android:build
```

This builds the web app, regenerates the network security config, runs
`cap sync`, and produces:

- `apps/web/android-dist/overtone-<version>-debug.apk`
- `apps/web/android-dist/overtone-<version>-release.apk` (signed; with a keystore)
- `apps/web/android-dist/overtone-<version>-release.aab` (signed; with a keystore; for stores)

Native unit tests (JVM, Robolectric):
`cd apps/web/android && ./gradlew testDebugUnitTest`.

## Install (sideload)

1. Copy `overtone-<version>-release.apk` to the phone, or run
   `adb install overtone-<version>-release.apk` with USB debugging on.
2. Open it. Android asks you to allow your file manager/browser to *install
   unknown apps*: allow it for that app only.
3. Play Protect may warn about an unknown developer. Choose *Install anyway*
   (you built it).
4. Launch **Overtone** and enter your server address.

## Updating the app

1. Pull the new code and run `npm install`.
2. Bump `versionCode` (it must increase) and `versionName` in
   `apps/web/app.config.json`.
3. Run `npm run android:build` **with the same keystore**.
4. Install the new release APK over the old one (`adb install -r …`, or open
   it on the phone). Login, server address and queue are kept.

Debug and release builds are signed with different keys. You can't update
one with the other; uninstall first if you switch.

## Verification status

Tested in this repository's CI-like environment:

- `npm run android:build` produces the debug APK, the signed release APK
  (v2/v3 signatures verified with `apksigner`) and the AAB. Android
  `lintVital` passes.
- Merged-manifest permissions were checked (table above).
- JVM tests (Robolectric, real ExoPlayer): remote next/previous forwarding,
  media-item URI handling and scheme check, and the AES-GCM secure-storage
  format.
- TypeScript tests with the native side mocked: event translation,
  load/preload/metadata mapping, gapless hand-off, expired-link recovery at
  the same position, remote buttons, external pauses, notification-permission
  timing, the secure-storage adapter, the cleartext policy, the back button,
  and queue restore after process death.
- Server tests: `http://localhost` CORS preflight, and signed-URL streaming
  with Range seeking and no auth header.

**Not tested on a device or emulator.** The build environment has no
hardware virtualisation (KVM), so no emulator could run. Run the checklist
below on a phone before relying on it.

### Manual test checklist

Use a release build on Android 13 or newer, plus one older device if you can.

- [ ] **First launch:** enter an `https://` server URL; a wrong address shows
      "Can't reach"; an `http://` public host is refused with an explanation.
- [ ] **Sign in;** kill the app and relaunch: you're still signed in. Sign
      out: the login screen appears.
- [ ] **Theme:** switch system dark/light; the app, status bar and nav bar
      icons follow it.
- [ ] **Edge-to-edge:** nothing sits under the status bar, gesture bar or
      camera cut-out, in portrait and landscape.
- [ ] **Back button:** goes back through screens, closes dialogs, and at Home
      exits (or moves to the background while playing).
- [ ] **First play:** the notification permission prompt appears once;
      playback starts.
- [ ] **Background playback:** press Home, lock the screen, wait 10+ minutes
      across several track changes.
- [ ] **Notification and lock screen:** artwork, title and artist are
      correct; play/pause, next, previous and the seek bar work.
- [ ] **Bluetooth headset / car:** play/pause and next/previous buttons work;
      metadata shows.
- [ ] **Phone call:** playback pauses during the call and resumes after it.
      A notification sound ducks the music briefly.
- [ ] **Headphones unplugged** (wired or BT disconnect): playback pauses.
- [ ] **Seeking:** in the app and from the notification, including far
      ahead (Range requests).
- [ ] **Track change:** near-gapless between consecutive album tracks.
      Shuffle and repeat (all/one) behave.
- [ ] **Expired link recovery:** start a track, wait more than 6 h paused
      (or restart the server with a new `OVERTONE_SECRET_KEY`) and press
      play: it resumes at the same position.
- [ ] **Server unreachable:** stop the server (or turn Wi-Fi off). The app
      shows "Can't reach the server" with *Try again*; it recovers after the
      server returns.
- [ ] **Session expired:** revoke the session (change password on another
      device): the app returns to sign-in with a notice.
- [ ] **Process death:** while paused, swipe the app away from recents and
      reopen it: the queue is restored at the same position.
- [ ] **Debrid / Subsonic sources** play through the server (proxy), as on
      the web.

/**
 * Background work in standalone mode.
 *
 * Scanning and MusicBrainz matching run inside the app's JavaScript. To keep
 * going while the app is in the background:
 *  - every wait (MusicBrainz's 1 request/second limit, retry backoff,
 *    rescans) uses a native timer instead of setTimeout, which Android's
 *    WebView throttles heavily in the background;
 *  - while work is pending, a foreground service (type dataSync) with a
 *    visible "Updating your library" notification keeps the process alive.
 *
 * If the app is killed anyway, nothing is lost: the scan queue, untagged
 * files and unmatched files are all in the database, and core.start()
 * resumes them on the next launch.
 */
import type { Clock, OvertoneCore } from '@overtone/core';
import type { BackgroundWorkPlugin } from './plugins';

/** Clock whose timers are native (Handler.postDelayed), not WebView setTimeout. */
export function nativeClock(plugin: BackgroundWorkPlugin): Clock {
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal!.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      plugin.sleep({ ms: Math.max(0, Math.round(ms)) }).then(
        () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  return {
    now: () => Date.now(),
    sleep,
    schedule(ms, fn) {
      let cancelled = false;
      void sleep(ms).then(() => {
        if (!cancelled) fn();
      });
      return () => {
        cancelled = true;
      };
    },
  };
}

/**
 * Shows the foreground-service notification while the library is being
 * updated, and removes it when everything is done. Updates are throttled.
 */
export function createActivityNotifier(getCore: () => OvertoneCore | null, plugin: BackgroundWorkPlugin, clock: Clock) {
  let shown = false;
  let pending: (() => void) | undefined;
  let lastText = '';
  let names = new Map<string, string>();

  const refresh = async () => {
    pending = undefined;
    const core = getCore();
    if (!core) return;
    if (!core.busy) {
      if (shown) {
        shown = false;
        lastText = '';
        await plugin.stop().catch(() => undefined);
      }
      return;
    }
    const progress = core.scanner.progress;
    let text: string;
    if (progress) {
      if (!names.has(progress.sourceId)) names = new Map((await core.sources.list()).map((s) => [s.id, s.name]));
      text = `Scanning ${names.get(progress.sourceId) ?? 'a source'}: ${progress.filesSeen.toLocaleString()} files${progress.queued ? ` (${progress.queued} more queued)` : ''}`;
    } else {
      const left = await core.library.pendingMatchCount();
      text = left ? `Matching with MusicBrainz: ${left.toLocaleString()} files left` : 'Finishing up';
    }
    if (text === lastText && shown) return;
    lastText = text;
    shown = true;
    await plugin.start({ title: 'Updating your library', text }).catch(() => undefined);
  };

  return () => {
    // Coalesce bursts of activity events (one per 200 files, per match batch).
    pending ??= clock.schedule(750, () => void refresh());
  };
}

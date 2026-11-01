import type { SourceBadgeDto, TrackDto } from '@overtone/shared';
import type { EngineEvent, PlayerEngine, TrackMetadata } from './engine';
import {
  currentItem,
  emptyQueue,
  hasNext,
  peekNext,
  queueReducer,
  type QueueAction,
  type QueueItem,
  type QueueState,
} from './queue';

export interface StreamLink {
  /** Absolute URL. */
  url: string;
  /** Epoch ms. */
  expiresAt: number;
  source: SourceBadgeDto | null;
}

export type LinkFetcher = (trackIds: number[]) => Promise<{ links: Map<number, StreamLink>; unavailable: number[] }>;

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface PlayerSnapshot {
  queue: QueueState;
  current: QueueItem | null;
  status: PlayerStatus;
  buffering: boolean;
  /** Seconds. */
  position: number;
  duration: number;
  volume: number;
  /** Source the current track is streaming from. */
  source: SourceBadgeDto | null;
  /** Error for the current track (status 'error'). */
  error: string | null;
  /** Last user-facing notice (announced by a live region), e.g. a skipped track. */
  notice: { id: number; text: string } | null;
}

export interface PlayerControllerOptions {
  engine: PlayerEngine;
  fetchLinks: LinkFetcher;
  now?: () => number;
  random?: () => number;
  /** Treat links expiring sooner than this as expired. */
  linkMarginMs?: number;
  /** Fresh-link retries per failure spot before giving up on a track. */
  maxRefreshes?: number;
  /** Start buffering the next track this many seconds before the end. */
  preloadSeconds?: number;
  /** Absolute artwork URL for a track (for the OS media notification / lock screen). */
  artworkUrl?: (track: TrackDto) => string | null;
}

/** A queue snapshot that survives an app restart (see persistence.ts). */
export interface SavedQueue {
  version: 1;
  tracks: TrackDto[];
  order: number[];
  cursor: number;
  shuffle: boolean;
  repeat: QueueState['repeat'];
  position: number;
}

class TrackUnavailableError extends Error {}

/**
 * Drives an engine from the queue state machine and owns stream links:
 *
 *  - links are fetched in small batches (current + next two) and cached until
 *    shortly before they expire;
 *  - the next track is preloaded near the end of the current one;
 *  - if playback errors (e.g. the link expired mid-track or the network
 *    dropped), a fresh link is fetched and playback resumes at the same
 *    position. Repeated failures at the same spot skip the track.
 */
export class PlayerController {
  readonly #engine: PlayerEngine;
  readonly #fetchLinks: LinkFetcher;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #margin: number;
  readonly #maxRefreshes: number;
  readonly #preloadSeconds: number;
  readonly #artworkUrl: (track: TrackDto) => string | null;
  readonly #links = new Map<number, StreamLink>();
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribeEngine: () => void;

  #state: PlayerSnapshot = {
    queue: emptyQueue,
    current: null,
    status: 'idle',
    buffering: false,
    position: 0,
    duration: 0,
    volume: 1,
    source: null,
    error: null,
    notice: null,
  };
  /** What the user wants: drives autoplay on loads and recoveries. */
  #intent: 'play' | 'pause' = 'pause';
  /** Increments per load; stale async work compares and bails. */
  #seq = 0;
  #refreshes = 0;
  #failurePosition = -Infinity;
  #preloadedUid: string | null = null;
  #noticeId = 0;

  constructor(opts: PlayerControllerOptions) {
    this.#engine = opts.engine;
    this.#fetchLinks = opts.fetchLinks;
    this.#now = opts.now ?? Date.now;
    this.#random = opts.random ?? Math.random;
    this.#margin = opts.linkMarginMs ?? 60_000;
    this.#maxRefreshes = opts.maxRefreshes ?? 2;
    this.#preloadSeconds = opts.preloadSeconds ?? 30;
    this.#artworkUrl = opts.artworkUrl ?? (() => null);
    this.#unsubscribeEngine = this.#engine.subscribe((e) => this.#onEngine(e));
  }

  // ── store ────────────────────────────────────────────────────────────────

  getSnapshot = (): PlayerSnapshot => this.#state;

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  #set(patch: Partial<PlayerSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn();
  }

  #notify(text: string): void {
    this.#set({ notice: { id: ++this.#noticeId, text } });
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /** Replace the queue and start playing. Call from a user gesture. */
  playTracks(tracks: TrackDto[], startIndex = 0, opts: { shuffle?: boolean } = {}): void {
    this.#engine.prime();
    this.#intent = 'play';
    this.#dispatch({ type: 'replace', tracks, startIndex, ...(opts.shuffle !== undefined ? { shuffle: opts.shuffle } : {}) });
  }

  addToQueue(tracks: TrackDto[]): void {
    const wasEmpty = !this.#state.current;
    if (wasEmpty) {
      this.#engine.prime();
      this.#intent = 'play';
    }
    this.#dispatch({ type: 'append', tracks });
    this.#notify(tracks.length === 1 ? `Added "${tracks[0]!.title}" to the queue` : `Added ${tracks.length} tracks to the queue`);
  }

  playNext(tracks: TrackDto[]): void {
    if (!this.#state.current) return this.addToQueue(tracks);
    this.#dispatch({ type: 'playNext', tracks });
    this.#notify(tracks.length === 1 ? `"${tracks[0]!.title}" will play next` : `${tracks.length} tracks will play next`);
  }

  togglePlay(): void {
    if (this.#intent === 'play' && this.#state.status !== 'error' && this.#state.status !== 'paused') this.pause();
    else this.play();
  }

  play(): void {
    const item = this.#state.current;
    if (!item) return;
    this.#engine.prime();
    this.#intent = 'play';
    if (this.#state.queue.finished) {
      this.#dispatch({ type: 'restart' });
      return;
    }
    const link = this.#links.get(item.track.id);
    const stale = !link || link.expiresAt - this.#now() < this.#margin;
    if (this.#state.status === 'error' || stale) {
      // Paused long enough for the link to lapse (or it failed): resume where we were on a fresh link.
      void this.#load(this.#state.position, { forceLink: this.#state.status === 'error' || stale });
      return;
    }
    this.#engine.play().catch(() => this.#set({ status: 'paused' }));
  }

  pause(): void {
    this.#intent = 'pause';
    this.#engine.pause();
    if (this.#state.status === 'loading' || this.#state.status === 'playing') this.#set({ status: 'paused', buffering: false });
  }

  next(): void {
    this.#dispatch({ type: 'next' });
  }

  /** Restart the track if more than 3 s in, else go to the previous one. */
  prev(): void {
    this.#dispatch({ type: this.#engine.position() > 3 ? 'restart' : 'prev' });
  }

  jump(position: number): void {
    this.#engine.prime();
    this.#intent = 'play';
    this.#dispatch({ type: 'jump', position });
  }

  seek(seconds: number): void {
    if (!this.#state.current) return;
    const s = Math.max(0, Math.min(seconds, this.#state.duration || seconds));
    this.#engine.seek(s);
    this.#set({ position: s });
  }

  remove(position: number): void {
    this.#dispatch({ type: 'remove', position });
  }

  move(from: number, to: number): void {
    this.#dispatch({ type: 'move', from, to });
  }

  toggleShuffle(): void {
    this.#dispatch({ type: 'toggleShuffle' });
  }

  cycleRepeat(): void {
    this.#dispatch({ type: 'cycleRepeat' });
  }

  clear(): void {
    this.#dispatch({ type: 'clear' });
  }

  setVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, volume));
    this.#engine.setVolume(v);
    this.#set({ volume: v });
  }

  destroy(): void {
    this.#unsubscribeEngine();
    this.#engine.destroy();
  }

  /** Snapshot for persistence (null when nothing is queued). */
  save(): SavedQueue | null {
    const q = this.#state.queue;
    if (!this.#state.current) return null;
    return { version: 1, tracks: q.items.map((i) => i.track), order: q.order, cursor: q.cursor, shuffle: q.shuffle, repeat: q.repeat, position: this.#state.position };
  }

  /**
   * Restore a saved queue, paused at the saved position (e.g. after the app
   * was killed). Nothing loads until the user presses play, which then fetches
   * a fresh stream link and resumes where it left off.
   */
  restore(saved: SavedQueue): void {
    if (this.#state.current || saved.version !== 1 || !saved.tracks.length) return;
    const valid = saved.order.length > 0 && saved.order.every((i) => i >= 0 && i < saved.tracks.length) && saved.cursor >= 0 && saved.cursor < saved.order.length;
    if (!valid) return;
    let queue = queueReducer(emptyQueue, { type: 'replace', tracks: saved.tracks, startIndex: 0, shuffle: false }, this.#random);
    queue = { ...queue, order: [...saved.order], cursor: saved.cursor, shuffle: saved.shuffle, repeat: saved.repeat };
    const current = currentItem(queue);
    this.#intent = 'pause';
    this.#set({
      queue,
      current,
      status: 'paused',
      position: Math.max(0, saved.position),
      duration: current?.track.durationMs ? current.track.durationMs / 1000 : 0,
    });
  }

  #metadata(track: TrackDto): TrackMetadata {
    return { title: track.title, artist: track.artistCredit, album: track.album?.title ?? '', artworkUrl: this.#artworkUrl(track) };
  }

  // ── internals ────────────────────────────────────────────────────────────

  #dispatch(action: QueueAction): void {
    const prev = this.#state.queue;
    const queue = queueReducer(prev, action, this.#random);
    const current = currentItem(queue);
    this.#set({ queue, current });

    const restarted = current?.uid !== currentItem(prev)?.uid || queue.playToken !== prev.playToken;
    if (!current) {
      this.#seq++;
      this.#engine.unload();
      this.#set({ status: 'idle', position: 0, duration: 0, source: null, error: null, buffering: false });
      return;
    }
    if (queue.finished && !prev.finished) {
      // End of queue with repeat off: stop on the last track, ready to replay.
      this.#intent = 'pause';
      this.#engine.pause();
      this.#set({ status: 'paused', buffering: false });
      return;
    }
    if (restarted) void this.#load(0, { fresh: true });
    else if (action.type === 'toggleShuffle' || action.type === 'cycleRepeat' || action.type === 'playNext' || action.type === 'move') {
      // The upcoming track may have changed; re-plan preloading.
      this.#preloadedUid = null;
    }
  }

  /** `fresh`: a new play of the current item (not a resume/recovery). */
  async #load(startAt: number, opts: { forceLink?: boolean; fresh?: boolean } = {}): Promise<void> {
    const item = this.#state.current;
    if (!item) return;
    const seq = ++this.#seq;
    const autoplay = this.#intent === 'play';
    if (opts.fresh) {
      this.#refreshes = 0;
      this.#failurePosition = -Infinity;
      this.#preloadedUid = null;
    }
    this.#set({
      status: 'loading',
      error: null,
      buffering: false,
      position: startAt,
      duration: item.track.durationMs ? item.track.durationMs / 1000 : 0,
    });
    let link: StreamLink;
    try {
      link = await this.#link(item.track.id, opts.forceLink ?? false);
    } catch (err) {
      if (seq !== this.#seq) return;
      this.#fail(item, err instanceof TrackUnavailableError ? 'This track is not available from any source right now.' : "Couldn't reach the server.");
      return;
    }
    if (seq !== this.#seq) return;
    this.#set({ source: link.source });
    this.#engine.load(link.url, { startAt, autoplay, metadata: this.#metadata(item.track) });
    if (!autoplay) this.#set({ status: 'paused' });
  }

  async #link(trackId: number, force: boolean): Promise<StreamLink> {
    const cached = this.#links.get(trackId);
    if (!force && cached && cached.expiresAt - this.#now() > this.#margin) return cached;
    // Batch in the next couple of tracks to save round trips.
    const ids = [trackId];
    for (const item of this.#upcomingAfterCurrent(2)) {
      const c = this.#links.get(item.track.id);
      if (item.track.id !== trackId && (!c || c.expiresAt - this.#now() <= this.#margin)) ids.push(item.track.id);
    }
    const { links, unavailable } = await this.#fetchLinks([...new Set(ids)]);
    for (const [id, l] of links) this.#links.set(id, l);
    for (const id of unavailable) this.#links.delete(id);
    const link = links.get(trackId);
    if (!link) throw new TrackUnavailableError();
    return link;
  }

  #upcomingAfterCurrent(n: number): QueueItem[] {
    const q = this.#state.queue;
    const out: QueueItem[] = [];
    for (let i = q.cursor + 1; i < q.order.length && out.length < n; i++) out.push(q.items[q.order[i]!]!);
    return out;
  }

  #fail(item: QueueItem, message: string): void {
    const q = this.#state.queue;
    if (this.#intent === 'play' && hasNext(q) && q.order.length > 1) {
      this.#notify(`Couldn't play "${item.track.title}". Skipped.`);
      this.#dispatch({ type: 'next' });
      return;
    }
    this.#engine.pause();
    this.#set({ status: 'error', error: message, buffering: false });
    this.#notify(`Couldn't play "${item.track.title}".`);
  }

  #onEngine(e: EngineEvent): void {
    switch (e.type) {
      case 'playing':
        // Playback made real progress past the last failure: the recovery worked.
        if (this.#state.position > this.#failurePosition + 5) this.#refreshes = 0;
        this.#set({ status: 'playing', buffering: false, error: null });
        return;
      case 'paused':
        // Also covers a blocked autoplay while loading: show a play button, not an endless spinner.
        if (this.#state.status === 'playing' || this.#state.status === 'loading') {
          this.#intent = 'pause';
          this.#set({ status: 'paused', buffering: false });
        }
        return;
      case 'waiting':
        this.#set({ buffering: true });
        return;
      case 'time': {
        const patch: Partial<PlayerSnapshot> = { position: e.position };
        if (e.duration > 0 && Number.isFinite(e.duration)) patch.duration = e.duration;
        if (this.#state.buffering && this.#state.status === 'playing') patch.buffering = false;
        this.#set(patch);
        if (e.position > this.#failurePosition + 5) this.#refreshes = 0;
        this.#maybePreload();
        return;
      }
      case 'ended':
        this.#intent = 'play';
        this.#dispatch({ type: 'ended' });
        return;
      case 'error':
        void this.#recover();
        return;
      case 'remote':
        if (e.command === 'next') this.next();
        else this.prev();
        return;
    }
  }

  /** Fresh link, same position. */
  async #recover(): Promise<void> {
    const item = this.#state.current;
    if (!item) return;
    const position = this.#engine.position() || this.#state.position;
    if (this.#refreshes >= this.#maxRefreshes) {
      this.#fail(item, "Couldn't play this track.");
      return;
    }
    this.#refreshes++;
    this.#failurePosition = position;
    this.#links.delete(item.track.id);
    await this.#load(position, { forceLink: true });
  }

  #maybePreload(): void {
    const { current, duration, position, queue } = this.#state;
    if (!current || !duration || duration - position > this.#preloadSeconds) return;
    const next = peekNext(queue);
    if (!next || next.uid === current.uid || this.#preloadedUid === next.uid) return;
    this.#preloadedUid = next.uid;
    const seq = this.#seq;
    this.#link(next.track.id, false).then(
      (link) => {
        if (seq === this.#seq) this.#engine.preload(link.url, this.#metadata(next.track));
      },
      () => {
        /* it'll be retried (and reported) when it becomes current */
      },
    );
  }
}

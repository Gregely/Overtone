/**
 * The play queue as a pure state machine (no I/O, no timers, injectable
 * randomness), so every queue/shuffle/repeat rule is unit-testable.
 *
 * `items` holds what was queued, in insertion order. `order` is the play
 * order: indices into `items`, identity when shuffle is off. `cursor` points
 * into `order`. Each item gets a `uid` so the same track can be queued twice.
 *
 * `playToken` increments whenever the current item should (re)start from the
 * beginning — a new current item, repeat-one looping, or "previous" restarting
 * a track. The controller loads audio whenever (current uid, playToken) changes.
 */
import type { TrackDto } from '@overtone/shared';

export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueItem {
  uid: string;
  track: TrackDto;
}

export interface QueueState {
  items: QueueItem[];
  order: number[];
  cursor: number;
  shuffle: boolean;
  repeat: RepeatMode;
  playToken: number;
  /** Reached the end with repeat off; playback should stop. */
  finished: boolean;
}

export type QueueAction =
  | { type: 'replace'; tracks: TrackDto[]; startIndex?: number; shuffle?: boolean }
  | { type: 'append'; tracks: TrackDto[] }
  | { type: 'playNext'; tracks: TrackDto[] }
  /** Jump to a position in play order. */
  | { type: 'jump'; position: number }
  /** User pressed next. Ignores repeat-one; wraps only with repeat-all. */
  | { type: 'next' }
  /** User pressed previous (the controller decides restart vs previous by elapsed time). */
  | { type: 'prev' }
  | { type: 'restart' }
  /** The current track finished playing on its own. */
  | { type: 'ended' }
  | { type: 'remove'; position: number }
  | { type: 'move'; from: number; to: number }
  | { type: 'toggleShuffle' }
  | { type: 'setRepeat'; mode: RepeatMode }
  | { type: 'cycleRepeat' }
  | { type: 'clear' };

export const emptyQueue: QueueState = { items: [], order: [], cursor: -1, shuffle: false, repeat: 'off', playToken: 0, finished: false };

let uidCounter = 0;
const nextUid = () => `q${++uidCounter}`;

export function currentItem(s: QueueState): QueueItem | null {
  const i = s.order[s.cursor];
  return i === undefined ? null : (s.items[i] ?? null);
}

/** Items in play order, starting with the current one. */
export function upcoming(s: QueueState): QueueItem[] {
  return s.order.slice(s.cursor).map((i) => s.items[i]!);
}

/** The item that will play after the current one, honouring repeat. */
export function peekNext(s: QueueState): QueueItem | null {
  if (s.cursor < 0) return null;
  if (s.repeat === 'one') return currentItem(s);
  const next = s.cursor + 1 < s.order.length ? s.cursor + 1 : s.repeat === 'all' ? 0 : -1;
  return next < 0 ? null : s.items[s.order[next]!]!;
}

export function hasNext(s: QueueState): boolean {
  return s.cursor >= 0 && (s.cursor + 1 < s.order.length || s.repeat === 'all');
}

export function hasPrev(s: QueueState): boolean {
  return s.cursor > 0 || (s.cursor === 0 && s.repeat === 'all' && s.order.length > 1);
}

/** Fisher–Yates over a copy. */
export function shuffled<T>(xs: readonly T[], random: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const identity = (n: number) => Array.from({ length: n }, (_, i) => i);

function moveTo(s: QueueState, cursor: number): QueueState {
  return { ...s, cursor, playToken: s.playToken + 1, finished: false };
}

export function queueReducer(s: QueueState, a: QueueAction, random: () => number = Math.random): QueueState {
  switch (a.type) {
    case 'replace': {
      if (!a.tracks.length) return { ...emptyQueue, shuffle: s.shuffle, repeat: s.repeat, playToken: s.playToken + 1 };
      const items = a.tracks.map((track) => ({ uid: nextUid(), track }));
      const start = Math.min(Math.max(0, a.startIndex ?? 0), items.length - 1);
      const shuffle = a.shuffle ?? s.shuffle;
      // With shuffle the chosen track plays first and the rest follow in random order.
      const order = shuffle ? [start, ...shuffled(identity(items.length).filter((i) => i !== start), random)] : identity(items.length);
      return { ...s, items, order, cursor: shuffle ? 0 : start, shuffle, playToken: s.playToken + 1, finished: false };
    }

    case 'append': {
      if (!a.tracks.length) return s;
      const base = s.items.length;
      const items = [...s.items, ...a.tracks.map((track) => ({ uid: nextUid(), track }))];
      const order = [...s.order, ...a.tracks.map((_, i) => base + i)];
      if (s.cursor < 0) return { ...s, items, order, cursor: 0, playToken: s.playToken + 1, finished: false };
      // Appending after the queue finished makes the new tracks playable via next.
      return { ...s, items, order };
    }

    case 'playNext': {
      if (!a.tracks.length) return s;
      if (s.cursor < 0) return queueReducer(s, { type: 'append', tracks: a.tracks }, random);
      const base = s.items.length;
      const items = [...s.items, ...a.tracks.map((track) => ({ uid: nextUid(), track }))];
      const order = [...s.order];
      order.splice(s.cursor + 1, 0, ...a.tracks.map((_, i) => base + i));
      return { ...s, items, order };
    }

    case 'jump':
      if (a.position < 0 || a.position >= s.order.length) return s;
      return moveTo(s, a.position);

    case 'next':
      if (s.cursor < 0) return s;
      if (s.cursor + 1 < s.order.length) return moveTo(s, s.cursor + 1);
      if (s.repeat === 'all') return moveTo(s, 0);
      return { ...s, finished: true };

    case 'prev':
      if (s.cursor < 0) return s;
      if (s.cursor > 0) return moveTo(s, s.cursor - 1);
      if (s.repeat === 'all' && s.order.length > 1) return moveTo(s, s.order.length - 1);
      return moveTo(s, 0); // at the start: restart the first track

    case 'restart':
      return s.cursor < 0 ? s : moveTo(s, s.cursor);

    case 'ended':
      if (s.cursor < 0) return s;
      if (s.repeat === 'one') return moveTo(s, s.cursor);
      return queueReducer(s, { type: 'next' }, random);

    case 'remove': {
      if (a.position < 0 || a.position >= s.order.length) return s;
      const removedItem = s.order[a.position]!;
      const order = s.order.filter((_, i) => i !== a.position);
      if (!order.length) return { ...emptyQueue, shuffle: s.shuffle, repeat: s.repeat, playToken: s.playToken + 1 };
      if (a.position < s.cursor) return compact({ ...s, order, cursor: s.cursor - 1 }, removedItem);
      if (a.position > s.cursor) return compact({ ...s, order }, removedItem);
      // Removing the current item: play whatever slid into its place.
      if (s.cursor < order.length) return compact(moveTo({ ...s, order }, s.cursor), removedItem);
      return compact({ ...s, order, cursor: order.length - 1, finished: true, playToken: s.playToken + 1 }, removedItem);
    }

    case 'move': {
      const { from, to } = a;
      if (from === to || from < 0 || to < 0 || from >= s.order.length || to >= s.order.length) return s;
      const order = [...s.order];
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved!);
      let cursor = s.cursor;
      if (from === s.cursor) cursor = to;
      else if (from < s.cursor && to >= s.cursor) cursor--;
      else if (from > s.cursor && to <= s.cursor) cursor++;
      return { ...s, order, cursor };
    }

    case 'toggleShuffle': {
      const shuffle = !s.shuffle;
      if (s.cursor < 0) return { ...s, shuffle };
      const current = s.order[s.cursor]!;
      if (shuffle) {
        // Keep what's playing; already-played items stay behind it, the rest is shuffled ahead.
        const played = s.order.slice(0, s.cursor);
        const rest = shuffled(s.order.slice(s.cursor + 1), random);
        return { ...s, shuffle, order: [...played, current, ...rest], cursor: played.length };
      }
      const order = identity(s.items.length).filter((i) => s.order.includes(i));
      return { ...s, shuffle, order, cursor: order.indexOf(current) };
    }

    case 'setRepeat':
      return { ...s, repeat: a.mode };

    case 'cycleRepeat':
      return { ...s, repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' };

    case 'clear':
      return { ...emptyQueue, shuffle: s.shuffle, repeat: s.repeat, playToken: s.playToken + 1 };
  }
}

/** Drop an item no longer referenced by `order`, re-indexing `order`. */
function compact(s: QueueState, removedItem: number): QueueState {
  if (s.order.includes(removedItem)) return s;
  const items = s.items.filter((_, i) => i !== removedItem);
  const order = s.order.map((i) => (i > removedItem ? i - 1 : i));
  return { ...s, items, order };
}

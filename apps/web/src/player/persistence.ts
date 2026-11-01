import type { KeyValueStore } from '../platform/storage';
import type { PlayerController, SavedQueue } from './controller';

const KEY = 'overtone.queue';

/** Restore the last queue (paused) — e.g. after Android killed the app. */
export async function restoreQueue(player: PlayerController, store: KeyValueStore): Promise<void> {
  try {
    const raw = await store.get(KEY);
    if (raw) player.restore(JSON.parse(raw) as SavedQueue);
  } catch {
    /* corrupt or old snapshot: ignore */
  }
}

/**
 * Save the queue + position: on every queue/status change, and at most every
 * `intervalMs` while playing. Returns an unsubscribe function.
 */
export function persistQueue(player: PlayerController, store: KeyValueStore, intervalMs = 5000): () => void {
  let lastSaved = 0;
  let lastKey = '';
  const save = () => {
    const snap = player.save();
    lastSaved = Date.now();
    void (snap ? store.set(KEY, JSON.stringify(snap)) : store.remove(KEY));
  };
  return player.subscribe(() => {
    const s = player.getSnapshot();
    const key = `${s.current?.uid ?? ''}|${s.queue.order.length}|${s.queue.cursor}|${s.queue.shuffle}|${s.queue.repeat}|${s.status}`;
    if (key !== lastKey || Date.now() - lastSaved >= intervalMs) {
      lastKey = key;
      save();
    }
  });
}

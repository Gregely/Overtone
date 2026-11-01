import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/index.js';
import type { Matcher } from '../metadata/matcher/matcher.js';
import { MusicBrainzError } from '../metadata/musicbrainz/client.js';
import { LibraryRepo } from './repo.js';
import { isTransient, MatchWorker } from './scanner.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function setup() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO sources (id, provider_id, name, created_at) VALUES ('s', 'local-folder', 'S', 0)`).run();
  const repo = new LibraryRepo(db);
  for (const name of ['A/1.mp3', 'B/1.mp3']) {
    const { id } = repo.upsertSourceFile('s', { id: name, name, path: name, size: 1 }, 1);
    repo.saveTags(repo.getFile(id)!, { title: name, artist: 'X' });
  }
  return repo;
}

describe('MatchWorker', () => {
  it('marks a failing folder unmatched and continues with the rest', async () => {
    const repo = setup();
    const matchGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error('bug on weird data'))
      .mockImplementation(async (inputs: Array<{ key: number }>) => new Map(inputs.map((i) => [i.key, { status: 'unmatched', score: 0.1, best: null, candidates: [] }])));
    await new MatchWorker(repo, { matchGroup } as unknown as Matcher, logger).drain();
    expect(repo.listFiles({}).items.map((f) => f.matchStatus)).toEqual(['unmatched', 'unmatched']);
    expect(matchGroup).toHaveBeenCalledTimes(2);
  });

  it('treats network and MusicBrainz failures as transient', () => {
    expect(isTransient(new MusicBrainzError(503, 'x'))).toBe(true);
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransient(new Error('bug'))).toBe(false);
  });
});

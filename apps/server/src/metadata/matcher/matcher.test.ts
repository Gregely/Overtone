import { describe, expect, it } from 'vitest';
import { credit, FakeMusicBrainz, release } from '../../testing/fake-musicbrainz.js';
import type { FileTags } from '../../providers/types.js';
import { Matcher, recordingQueries, type MatchInput } from './matcher.js';

const daft = credit('Daft Punk');
const homework = release('rel-homework', 'Homework', daft, [
  ['Daftendirekt', 164_000],
  ['WDPK 83.7 FM', 28_000],
  ['Revolution 909', 326_000],
  ['Da Funk', 329_000],
  ['Phœnix', 297_000],
]);
const compilation = release('rel-hits', 'Greatest Club Hits', credit('Various Artists'), [['Da Funk', 329_000, 'rec-da-funk']], {
  date: '2003-05-01',
  releaseGroup: { id: 'rg-hits', primaryType: 'Album', secondaryTypes: ['Compilation'] },
});
// A compilation's tracks still credit the original artist.
compilation.tracks[0]!.recording.credit = daft;
const live = release('rel-alive', 'Alive 1997', daft, [['Da Funk', 450_000, 'rec-da-funk-live']], {
  date: '2001-10-01',
  releaseGroup: { id: 'rg-alive', primaryType: 'Album', secondaryTypes: ['Live'] },
});
const intro = release('rel-other', 'Some Album', credit('Someone Else'), [['Intro', 60_000]]);

const file = (key: number, tags: FileTags, path = `x/${key}.mp3`): MatchInput => ({ key, path, tags });

describe('Matcher', () => {
  it('matches a whole album folder with one release search + one lookup', async () => {
    const mb = new FakeMusicBrainz([homework, compilation, live]);
    const m = new Matcher(mb);
    const titles = ['Daftendirekt', 'WDPK 83.7 FM', 'Revolution 909', 'Da Funk', 'Phoenix'];
    const inputs = titles.map((title, i) =>
      file(i + 1, { title, artist: 'Daft Punk', albumArtist: 'Daft Punk', album: 'Homework', trackNumber: i + 1, durationMs: homework.tracks[i]!.lengthMs! + 500 }),
    );
    const results = await m.matchGroup(inputs);
    for (const [i, input] of inputs.entries()) {
      const r = results.get(input.key)!;
      expect(r.status, titles[i]).toBe('matched');
      expect(r.best?.release?.mbid).toBe('rel-homework');
      expect(r.best?.trackNo).toBe(i + 1);
    }
    expect(mb.calls.filter((c) => c.startsWith('searchRecordings'))).toHaveLength(0);
    expect(mb.calls).toEqual(['searchReleases release:"homework" AND artist:"daft punk"', 'getRelease rel-homework']);
  });

  it('prefers the original album over compilations and live versions for a single file', async () => {
    const m = new Matcher(new FakeMusicBrainz([compilation, homework, live]));
    const r = await m.matchOne(file(1, { title: 'Da Funk', artist: 'Daft Punk', durationMs: 329_500 }));
    expect(r.status).toBe('matched');
    expect(r.best?.release?.mbid).toBe('rel-homework');
    expect(r.candidates.map((c) => c.release?.mbid)).not.toContain(undefined);
  });

  it('uses the album tag to pick the right release of the same recording', async () => {
    const m = new Matcher(new FakeMusicBrainz([homework, compilation]));
    const r = await m.matchOne(file(1, { title: 'Da Funk', artist: 'Daft Punk', album: 'Greatest Club Hits' }));
    expect(r.best?.release?.mbid).toBe('rel-hits');
  });

  it('trusts MusicBrainz ids embedded in tags', async () => {
    const mb = new FakeMusicBrainz([homework]);
    const r = await new Matcher(mb).matchGroup([
      file(1, { title: 'wrong title', musicbrainz: { recordingId: 'rec-da-funk', releaseId: 'rel-homework' } }),
    ]);
    expect(r.get(1)).toMatchObject({ status: 'matched', score: 1, best: { title: 'Da Funk', trackNo: 4, release: { mbid: 'rel-homework' } } });
    expect(mb.calls).toEqual(['getRelease rel-homework']);
  });

  it('never auto-matches on a title alone', async () => {
    const r = await new Matcher(new FakeMusicBrainz([intro])).matchOne(file(1, { title: 'Intro' }));
    expect(r.status).not.toBe('matched');
  });

  it('reports needs_review for plausible but uncertain matches', async () => {
    const r = await new Matcher(new FakeMusicBrainz([homework])).matchOne(
      file(1, { title: 'Da Funk', artist: 'Daft Pank', album: 'Something Else', durationMs: 340_000 }),
    );
    expect(r.status).toBe('needs_review');
    expect(r.best?.recordingMbid).toBe('rec-da-funk');
  });

  it('returns unmatched with no candidates when MusicBrainz knows nothing', async () => {
    const r = await new Matcher(new FakeMusicBrainz([])).matchOne(file(1, { title: 'Nope', artist: 'Nobody' }));
    expect(r).toEqual({ status: 'unmatched', score: 0, best: null, candidates: [] });
  });

  it('matches remastered titles by searching without the suffix', async () => {
    const mb = new FakeMusicBrainz([homework]);
    const r = await new Matcher(mb).matchOne(file(1, { title: 'Revolution 909 (2022 Remaster)', artist: 'Daft Punk', album: 'Homework' }));
    expect(r.status).toBe('matched');
    expect(mb.calls[0]).toContain('recording:"revolution 909"');
  });

  it('falls back to per-track search when the album is not on MusicBrainz, biased to the group release', async () => {
    const mb = new FakeMusicBrainz([homework, compilation]);
    const inputs = [
      file(1, { title: 'Da Funk', artist: 'Daft Punk', album: 'My Mixtape', musicbrainz: { recordingId: 'rec-daftendirekt', releaseId: 'rel-homework' } }),
      file(2, { title: 'Da Funk', artist: 'Daft Punk', album: 'My Mixtape' }),
    ];
    const r = await new Matcher(mb).matchGroup(inputs);
    expect(r.get(2)?.best?.release?.mbid).toBe('rel-homework');
  });

  it('assignToRelease maps files by track number', () => {
    const m = new Matcher(new FakeMusicBrainz([]));
    const r = m.assignToRelease([file(1, { title: 'Track 3', trackNumber: 3 }), file(2, { title: 'Da Funk' })], homework);
    // Position decides the assignment even when the title is useless...
    expect(r.get(1)?.candidates[0]?.title).toBe('Revolution 909');
    // ...but a generic title alone isn't confident enough to auto-apply.
    expect(r.get(1)?.status).not.toBe('matched');
    expect(r.get(2)?.best?.title).toBe('Da Funk');
  });
});

describe('recordingQueries', () => {
  it('escapes Lucene syntax and strips suffixes', () => {
    expect(recordingQueries({ title: 'AC/DC: Live! (Remastered)', artist: 'AC/DC' })[0]).toBe('recording:"ac dc live" AND artist:"ac dc"');
    expect(recordingQueries({ title: 'Hello "World"' })[1]).toBe('recording:(hello world)');
  });
});

describe('scoreCandidate', () => {
  it('rewards official studio albums over other release types', async () => {
    const m = new Matcher(new FakeMusicBrainz([homework, compilation, live]));
    const r = await m.matchOne(file(1, { title: 'Da Funk', artist: 'Daft Punk', durationMs: 329_000 }), new Set(), 10);
    const scores = Object.fromEntries(r.candidates.map((c) => [c.release?.mbid, c.score]));
    // Perfect title/artist/duration on the original album is a perfect score.
    expect(scores['rel-homework']).toBe(1);
    // Each recording contributes its best release; the live recording scores lower.
    expect(scores['rel-hits']).toBeUndefined();
    expect(scores['rel-alive']).toBeLessThan(0.85);
  });
});

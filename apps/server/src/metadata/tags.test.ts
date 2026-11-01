import { parseBuffer } from 'music-metadata';
import { describe, expect, it } from 'vitest';
import { makeMp3, makeWav } from '../testing/audio-fixtures.js';
import { fromMusicMetadata, mergeTags } from './tags.js';

describe('fromMusicMetadata', () => {
  it('reads ID3v2 tags including MusicBrainz ids', async () => {
    const buf = makeMp3({
      title: 'Around the World',
      artist: 'Daft Punk',
      albumArtist: 'Daft Punk',
      album: 'Homework',
      track: '7/16',
      disc: '1/1',
      year: '1997',
      mbRecordingId: 'D13AEEBB-461E-4D2D-B1F3-056467058852',
      mbReleaseId: '00000000-0000-0000-0000-000000000001',
    });
    const tags = fromMusicMetadata(await parseBuffer(buf, { mimeType: 'audio/mpeg' }));
    expect(tags).toMatchObject({
      title: 'Around the World',
      artist: 'Daft Punk',
      albumArtist: 'Daft Punk',
      album: 'Homework',
      trackNumber: 7,
      trackTotal: 16,
      discNumber: 1,
      year: 1997,
      musicbrainz: { recordingId: 'd13aeebb-461e-4d2d-b1f3-056467058852', releaseId: '00000000-0000-0000-0000-000000000001' },
    });
    expect(tags.durationMs).toBeGreaterThan(0);
  });

  it('reads RIFF INFO tags and duration from WAV', async () => {
    const tags = fromMusicMetadata(await parseBuffer(makeWav({ title: 'T', artist: 'A', album: 'Al', track: '3' }, 2), { mimeType: 'audio/wav' }));
    expect(tags).toMatchObject({ title: 'T', artist: 'A', album: 'Al', durationMs: 2000 });
  });

  it('ignores malformed MBIDs', async () => {
    const tags = fromMusicMetadata(await parseBuffer(makeMp3({ title: 'x', mbRecordingId: 'not-an-id' }), { mimeType: 'audio/mpeg' }));
    expect(tags.musicbrainz).toBeUndefined();
  });
});

describe('mergeTags', () => {
  it('prefers primary values and fills gaps from fallback', () => {
    expect(
      mergeTags(
        { title: 'Real', artist: '', musicbrainz: { recordingId: 'r' } },
        { title: 'From file', artist: 'Folder Artist', trackNumber: 3, musicbrainz: { releaseId: 'x' } },
      ),
    ).toEqual({ title: 'Real', artist: 'Folder Artist', trackNumber: 3, musicbrainz: { releaseId: 'x', recordingId: 'r' } });
  });
});

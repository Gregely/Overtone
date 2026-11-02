import { describe, expect, it } from 'vitest';
import { makeMp3, makeWav } from '../testing/audio-fixtures.js';
import { parseRanged } from './ranged.js';
import { fromMusicMetadata } from './tags.js';

function reader(bytes: Uint8Array) {
  const reads: Array<[number, number]> = [];
  return {
    reads,
    read: async (offset: number, length: number) => {
      reads.push([offset, length]);
      return bytes.subarray(offset, offset + length);
    },
  };
}

describe('parseRanged', () => {
  it('reads ID3 tags with small ranged reads, not the whole file', async () => {
    const mp3 = new Uint8Array(makeMp3({ title: 'Ranged', artist: 'Reader', album: 'Blocks', track: '3' }, 4000));
    const r = reader(mp3);
    const meta = await parseRanged(r.read, { size: mp3.length, mimeType: 'audio/mpeg' }, { duration: false, skipCovers: true });
    expect(fromMusicMetadata(meta)).toMatchObject({ title: 'Ranged', artist: 'Reader', album: 'Blocks', trackNumber: 3 });
    const total = r.reads.reduce((n, [, l]) => n + l, 0);
    expect(mp3.length).toBeGreaterThan(1_000_000);
    expect(total).toBeLessThan(mp3.length / 4);
    expect(Math.max(...r.reads.map(([, l]) => l))).toBeLessThanOrEqual(64 * 1024);
  });

  it('parses RIFF/WAV info tags', async () => {
    const wav = new Uint8Array(makeWav({ title: 'Wave', artist: 'Form' }));
    const meta = await parseRanged(reader(wav).read, { size: wav.length, mimeType: 'audio/wav' });
    expect(fromMusicMetadata(meta)).toMatchObject({ title: 'Wave', artist: 'Form' });
  });

  it('never reads past the cap, even when asked for the full duration', async () => {
    const mp3 = new Uint8Array(makeMp3({ title: 'Capped' }, 4000));
    const r = reader(mp3);
    const meta = await parseRanged(r.read, { size: mp3.length, mimeType: 'audio/mpeg' }, { duration: true, maxReadBytes: 128 * 1024 });
    expect(meta.common.title).toBe('Capped');
    expect(r.reads.reduce((n, [, l]) => n + l, 0)).toBeLessThanOrEqual(128 * 1024);
  });
});

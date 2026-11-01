import { describe, expect, it } from 'vitest';
import { audioMimeType, fileExtension, isAudioFile } from './audio.js';

describe('audio helpers', () => {
  it.each([
    ['Artist/Album/01 - Song.FLAC', true],
    ['song.mp3', true],
    ['https://cdn.test/dl/abc/track.opus?token=x', true],
    ['cover.jpg', false],
    ['album.cue', false],
    ['README', false],
    ['.mp3', false],
    ['movie.mkv', false],
  ])('isAudioFile(%s) = %s', (name, expected) => {
    expect(isAudioFile(name)).toBe(expected);
  });

  it('extracts extensions and MIME types', () => {
    expect(fileExtension('C:\\Music\\a.b.M4A')).toBe('m4a');
    expect(audioMimeType('x.flac')).toBe('audio/flac');
    expect(audioMimeType('x.txt')).toBeUndefined();
  });
});

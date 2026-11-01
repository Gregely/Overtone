import { describe, expect, it } from 'vitest';
import { parseFilename } from './filename.js';

describe('parseFilename', () => {
  it.each([
    [
      'Daft Punk/Homework/04 - Da Funk.flac',
      { albumArtist: 'Daft Punk', artist: 'Daft Punk', album: 'Homework', trackNumber: 4, title: 'Da Funk' },
    ],
    [
      'Radiohead/OK Computer (1997)/02. Paranoid Android.mp3',
      { albumArtist: 'Radiohead', album: 'OK Computer', year: 1997, trackNumber: 2, title: 'Paranoid Android' },
    ],
    ['Pink Floyd/[1979] The Wall/CD2/03 Hey You.flac', { album: 'The Wall', year: 1979, discNumber: 2, trackNumber: 3, title: 'Hey You' }],
    ['The Beatles/1967 - Sgt. Pepper/1-05 Fixing a Hole.mp3', { album: 'Sgt. Pepper', year: 1967, discNumber: 1, trackNumber: 5 }],
    ['Artist/Album/203 Third Disc Song.mp3', { discNumber: 2, trackNumber: 3, title: 'Third Disc Song' }],
    ['Air - Moon Safari (1998)/01 Air - La Femme d\'Argent.mp3', { albumArtist: 'Air', album: 'Moon Safari', artist: 'Air', title: "La Femme d'Argent", trackNumber: 1 }],
    ['Portishead - Glory Box.mp3', { artist: 'Portishead', title: 'Glory Box' }],
    ['Some_Song_Name.ogg', { title: 'Some Song Name' }],
    ['Artist/Album/Artist - Album - 07 - Title.mp3', { artist: 'Artist', title: 'Album - 07 - Title' }],
  ])('%s', (path, expected) => {
    expect(parseFilename(path)).toMatchObject(expected);
  });

  it('does not mistake a numeric title for a track number', () => {
    expect(parseFilename('Prince/1999/1999.mp3')).toMatchObject({ title: '1999' });
  });

  it('keeps the album title when the folder is "Artist - Album" under an artist folder', () => {
    expect(parseFilename('Boards of Canada/Boards of Canada - Geogaddi/01 Ready Lets Go.flac')).toMatchObject({
      albumArtist: 'Boards of Canada',
      album: 'Geogaddi',
    });
  });
});

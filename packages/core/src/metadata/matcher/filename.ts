import type { FileTags } from '../../providers/types.js';

/**
 * Guess tags from a file's path when embedded tags are missing or partial.
 * Handles the common layouts:
 *
 *   Artist/Album/01 - Title.flac
 *   Artist/Album (1999)/1-01 Title.mp3        (disc-track)
 *   Artist/[1999] Album/CD2/03. Title.flac    (disc folders)
 *   Artist - Album (1999)/01 Artist - Title.mp3
 *   Artist - Title.mp3                         (loose singles)
 */
export function parseFilename(path: string): FileTags {
  const segments = path.split('/').filter(Boolean);
  const file = segments.pop() ?? '';
  const stem = file.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const tags: FileTags = {};

  // Disc folders: "CD2", "Disc 1", "Disk 03"
  let discFromFolder: number | undefined;
  const last = segments.at(-1);
  const discMatch = last?.match(/^(?:cd|dis[ck])\s*(\d{1,2})$/i);
  if (discMatch) {
    discFromFolder = Number(discMatch[1]);
    segments.pop();
  }

  // Album folder (+ year), and artist folder above it.
  const albumFolder = segments.at(-1);
  const artistFolder = segments.at(-2);
  if (albumFolder) {
    let album = albumFolder;
    const yearMatch =
      album.match(/^[([]?((?:19|20)\d{2})[)\]]?\s*[-–.]?\s+(.+)$/) ?? // "[1999] Album", "1999 - Album"
      album.match(/^(.+?)\s*[([]((?:19|20)\d{2})[)\]]\s*$/); // "Album (1999)"
    if (yearMatch) {
      const [, a, b] = yearMatch as unknown as [string, string, string];
      const isLeading = /^(?:19|20)\d{2}$/.test(a);
      tags.year = Number(isLeading ? a : b);
      album = isLeading ? b : a;
    }
    const artistAlbum = album.match(/^(.+?)\s+-\s+(.+)$/);
    if (artistAlbum && !artistFolder) {
      tags.albumArtist = artistAlbum[1]!.trim();
      album = artistAlbum[2]!;
    } else if (artistAlbum && artistFolder && sameish(artistAlbum[1]!, artistFolder)) {
      album = artistAlbum[2]!;
    }
    tags.album = album.trim();
    if (artistFolder && !tags.albumArtist) tags.albumArtist = artistFolder.trim();
  }

  // File stem: optional disc-track number, optional "Artist - ", title.
  let rest = stem;
  const num = rest.match(/^(?:(\d)[-.](\d{1,3})|(\d{1,3}))(?:\s*[-.)_]\s*|\s+)(.+)$/);
  if (num) {
    const [, disc, discTrack, track, remainder] = num;
    if (disc && discTrack) {
      tags.discNumber = Number(disc);
      tags.trackNumber = Number(discTrack);
    } else if (track) {
      const n = Number(track);
      // "101 Title" in multi-disc rips → disc 1 track 1
      if (track.length === 3 && n >= 101) {
        tags.discNumber = Math.floor(n / 100);
        tags.trackNumber = n % 100;
      } else {
        tags.trackNumber = n;
      }
    }
    rest = remainder!.trim();
  }
  if (discFromFolder && !tags.discNumber) tags.discNumber = discFromFolder;

  const artistTitle = rest.match(/^(.+?)\s+-\s+(.+)$/);
  if (artistTitle) {
    tags.artist = artistTitle[1]!.trim();
    tags.title = artistTitle[2]!.trim();
  } else {
    tags.title = rest;
    if (tags.albumArtist) tags.artist = tags.albumArtist;
  }
  if (!tags.title) tags.title = stem || file;
  return tags;
}

function sameish(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

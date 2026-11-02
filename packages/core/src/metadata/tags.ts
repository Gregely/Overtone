import type { IAudioMetadata } from 'music-metadata';
import type { FileTags } from '../providers/types.js';

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mbid(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && MBID_RE.test(s.trim()) ? s.trim().toLowerCase() : undefined;
}

function clean(v: string | undefined | null): string | undefined {
  const s = v?.replace(/\0/g, '').trim();
  return s ? s : undefined;
}

function positive(n: number | null | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Map music-metadata output to our normalized FileTags. */
export function fromMusicMetadata(meta: IAudioMetadata): FileTags {
  const c = meta.common;
  const tags: FileTags = {};
  const set = <K extends keyof FileTags>(k: K, v: FileTags[K] | undefined) => {
    if (v !== undefined) tags[k] = v;
  };
  set('title', clean(c.title));
  set('artist', clean(c.artist) ?? clean(c.artists?.join(', ')));
  set('albumArtist', clean(c.albumartist));
  set('album', clean(c.album));
  set('trackNumber', positive(c.track?.no));
  set('trackTotal', positive(c.track?.of));
  set('discNumber', positive(c.disk?.no));
  set('discTotal', positive(c.disk?.of));
  set('year', positive(c.year));
  if (c.genre?.length) tags.genre = c.genre.map((g) => g.trim()).filter(Boolean);
  const dur = positive(meta.format.duration);
  if (dur) tags.durationMs = Math.round(dur * 1000);

  const mb: NonNullable<FileTags['musicbrainz']> = {};
  const setMb = (k: keyof typeof mb, v: string | undefined) => {
    if (v) mb[k] = v;
  };
  setMb('recordingId', mbid(c.musicbrainz_recordingid));
  setMb('trackId', mbid(c.musicbrainz_trackid));
  setMb('releaseId', mbid(c.musicbrainz_albumid));
  setMb('releaseGroupId', mbid(c.musicbrainz_releasegroupid));
  setMb('artistId', mbid(c.musicbrainz_artistid));
  setMb('albumArtistId', mbid(c.musicbrainz_albumartistid));
  if (Object.keys(mb).length) tags.musicbrainz = mb;
  return tags;
}

/** Field-wise merge: values from `primary` win; `fallback` fills gaps. */
export function mergeTags(primary: FileTags | null | undefined, fallback: FileTags | null | undefined): FileTags {
  const out: FileTags = { ...(fallback ?? {}) };
  for (const [k, v] of Object.entries(primary ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'musicbrainz') out.musicbrainz = { ...(fallback?.musicbrainz ?? {}), ...(v as object) };
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

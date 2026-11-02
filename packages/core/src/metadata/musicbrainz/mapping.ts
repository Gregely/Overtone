/* Raw MusicBrainz JSON → normalized types. Defensive: MB omits fields freely. */
import type { MbCredit, MbRecording, MbRelease, MbReleaseRef, MbReleaseTrack } from './types.js';

type Json = Record<string, any>;

export function mapCredit(raw: Json[] | undefined): MbCredit {
  const parts = Array.isArray(raw) ? raw : [];
  return {
    text: parts.map((p) => `${p.name ?? p.artist?.name ?? ''}${p.joinphrase ?? ''}`).join('').trim(),
    artists: parts
      .filter((p) => p.artist?.id)
      .map((p) => ({ id: p.artist.id, name: p.artist.name ?? p.name ?? '', sortName: p.artist['sort-name'] ?? p.artist.name ?? '' })),
  };
}

function int(v: unknown): number | null {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export function mapReleaseRef(r: Json): MbReleaseRef {
  const rg = r['release-group'];
  // In recording search/lookup, media[] holds just the medium containing the recording.
  const medium = Array.isArray(r.media) ? r.media[0] : undefined;
  const track = medium?.track?.[0] ?? medium?.tracks?.[0];
  return {
    id: r.id,
    title: r.title ?? '',
    status: r.status ?? null,
    date: r.date || null,
    country: r.country ?? null,
    credit: r['artist-credit'] ? mapCredit(r['artist-credit']) : null,
    releaseGroup: rg?.id
      ? { id: rg.id, primaryType: rg['primary-type'] ?? null, secondaryTypes: rg['secondary-types'] ?? [] }
      : null,
    trackCount: int(r['track-count']),
    discNo: int(medium?.position),
    trackNo: track ? (int(track.number) ?? int(track.position)) : null,
  };
}

export function mapRecording(r: Json): MbRecording {
  return {
    id: r.id,
    title: r.title ?? '',
    lengthMs: int(r.length),
    credit: mapCredit(r['artist-credit']),
    releases: Array.isArray(r.releases) ? r.releases.map(mapReleaseRef) : [],
  };
}

export function mapRelease(r: Json): MbRelease {
  const ref = mapReleaseRef({ ...r, media: undefined });
  const media: Json[] = Array.isArray(r.media) ? r.media : [];
  const tracks: MbReleaseTrack[] = [];
  for (const m of media) {
    for (const t of (m.tracks ?? []) as Json[]) {
      const rec = t.recording ?? {};
      const credit = mapCredit(t['artist-credit'] ?? rec['artist-credit'] ?? r['artist-credit']);
      tracks.push({
        discNo: int(m.position) ?? 1,
        trackNo: int(t.number) ?? int(t.position) ?? tracks.length + 1,
        title: t.title ?? rec.title ?? '',
        lengthMs: int(t.length) ?? int(rec.length),
        recording: { id: rec.id, title: rec.title ?? t.title ?? '', lengthMs: int(rec.length), credit },
      });
    }
  }
  return { ...ref, trackCount: tracks.length || ref.trackCount, tracks };
}

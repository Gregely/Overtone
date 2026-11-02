/** In-memory MusicBrainzApi for tests, with call recording. */
import type { MbArtist, MbArtistDetail, MbCredit, MbRecording, MbRelease, MbReleaseGroup, MbReleaseRef, MusicBrainzApi } from '../metadata/musicbrainz/types.js';

export function credit(...names: string[]): MbCredit {
  return {
    text: names.join(' feat. '),
    artists: names.map((n) => ({ id: `artist-${n.toLowerCase().replace(/\W+/g, '-')}`, name: n, sortName: n })),
  };
}

export function release(
  id: string,
  title: string,
  artist: MbCredit,
  tracks: Array<[title: string, lengthMs: number, recordingId?: string]>,
  extra: Partial<MbReleaseRef> = {},
): MbRelease {
  return {
    id,
    title,
    status: 'Official',
    date: '1997-01-20',
    country: 'GB',
    credit: artist,
    releaseGroup: { id: `rg-${id}`, primaryType: 'Album', secondaryTypes: [] },
    trackCount: tracks.length,
    discNo: null,
    trackNo: null,
    ...extra,
    tracks: tracks.map(([t, len, rid], i) => ({
      discNo: 1,
      trackNo: i + 1,
      title: t,
      lengthMs: len,
      recording: { id: rid ?? `rec-${t.toLowerCase().replace(/\W+/g, '-')}`, title: t, lengthMs: len, credit: artist },
    })),
  };
}

/** Recordings derived from releases: each recording lists every release it appears on. */
export function recordingsFrom(releases: MbRelease[]): MbRecording[] {
  const byId = new Map<string, MbRecording>();
  for (const rel of releases) {
    for (const t of rel.tracks) {
      const rec = byId.get(t.recording.id) ?? {
        id: t.recording.id,
        title: t.recording.title,
        lengthMs: t.recording.lengthMs,
        credit: t.recording.credit,
        releases: [],
      };
      const { tracks: _t, ...ref } = rel;
      rec.releases.push({ ...ref, discNo: t.discNo, trackNo: t.trackNo });
      byId.set(rec.id, rec);
    }
  }
  return [...byId.values()];
}

export class FakeMusicBrainz implements MusicBrainzApi {
  readonly calls: string[] = [];
  readonly recordings: MbRecording[];

  constructor(
    readonly releases: MbRelease[],
    extraRecordings: MbRecording[] = [],
  ) {
    this.recordings = [...recordingsFrom(releases), ...extraRecordings];
  }

  async searchRecordings(query: string): Promise<MbRecording[]> {
    this.calls.push(`searchRecordings ${query}`);
    const t = needle(query, 'recording');
    return this.recordings.filter((r) => norm(r.title).includes(t) || r.credit.artists.some((a) => norm(a.name).includes(t)));
  }

  async searchReleases(query: string): Promise<MbReleaseRef[]> {
    this.calls.push(`searchReleases ${query}`);
    const t = needle(query, 'release');
    return this.releases
      .filter((r) => norm(r.title).includes(t) || (r.credit?.artists ?? []).some((a) => norm(a.name).includes(t)))
      .map(({ tracks: _t, ...ref }) => ref);
  }

  async getRelease(mbid: string): Promise<MbRelease | null> {
    this.calls.push(`getRelease ${mbid}`);
    return this.releases.find((r) => r.id === mbid) ?? null;
  }

  async getRecording(mbid: string): Promise<MbRecording | null> {
    this.calls.push(`getRecording ${mbid}`);
    return this.recordings.find((r) => r.id === mbid) ?? null;
  }

  async searchArtists(query: string): Promise<MbArtist[]> {
    this.calls.push(`searchArtists ${query}`);
    const t = norm(query);
    const seen = new Set<string>();
    const out: MbArtist[] = [];
    for (const r of this.releases) {
      for (const a of r.credit?.artists ?? []) {
        if (seen.has(a.id) || !norm(a.name).includes(t)) continue;
        seen.add(a.id);
        out.push({ id: a.id, name: a.name, sortName: a.sortName, disambiguation: null });
      }
    }
    return out;
  }

  async searchReleaseGroups(query: string): Promise<MbReleaseGroup[]> {
    this.calls.push(`searchReleaseGroups ${query}`);
    const t = norm(query);
    const seen = new Set<string>();
    const out: MbReleaseGroup[] = [];
    for (const r of this.releases) {
      const artistMatches = (r.credit?.artists ?? []).some((a) => norm(a.name).includes(t));
      if (!r.releaseGroup || seen.has(r.releaseGroup.id) || (!norm(r.title).includes(t) && !artistMatches)) continue;
      seen.add(r.releaseGroup.id);
      out.push({ id: r.releaseGroup.id, title: r.title, credit: r.credit ?? { text: '', artists: [] }, primaryType: r.releaseGroup.primaryType, secondaryTypes: r.releaseGroup.secondaryTypes, firstReleaseDate: r.date });
    }
    return out;
  }

  async getArtist(mbid: string): Promise<MbArtistDetail | null> {
    this.calls.push(`getArtist ${mbid}`);
    const artist = (await this.searchArtists('')).find((a) => a.id === mbid);
    if (!artist) return null;
    const releaseGroups: MbReleaseGroup[] = this.releases
      .filter((r) => (r.credit?.artists ?? []).some((a) => a.id === mbid))
      .map((r) => ({ id: r.releaseGroup!.id, title: r.title, credit: r.credit ?? { text: '', artists: [] }, primaryType: r.releaseGroup!.primaryType, secondaryTypes: r.releaseGroup!.secondaryTypes, firstReleaseDate: r.date }));
    return { ...artist, releaseGroups };
  }

  async getReleaseGroup(mbid: string): Promise<{ releaseGroup: MbReleaseGroup; release: MbRelease } | null> {
    this.calls.push(`getReleaseGroup ${mbid}`);
    const r = this.releases.find((x) => x.releaseGroup?.id === mbid);
    if (!r) return null;
    const releaseGroup: MbReleaseGroup = { id: mbid, title: r.title, credit: r.credit ?? { text: '', artists: [] }, primaryType: r.releaseGroup?.primaryType ?? null, secondaryTypes: r.releaseGroup?.secondaryTypes ?? [], firstReleaseDate: r.date };
    return { releaseGroup, release: r };
  }
}

/** Extract a Lucene `field:(...)` phrase, else the raw query, unescaped + lowered. */
function needle(query: string, field: string): string {
  const re = new RegExp(`${field}:(?:"([^"]+)"|\\(([^)]+)\\))`);
  const m = re.exec(query);
  return norm(m?.[1] ?? m?.[2] ?? query);
}

/** Lowercase and strip punctuation/backslashes for fuzzy matching. */
function norm(s: string): string {
  return s.replace(/\\/g, '').toLowerCase().replace(/[^\w\s]/g, '');
}

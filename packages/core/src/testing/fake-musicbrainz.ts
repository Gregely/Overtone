/** In-memory MusicBrainzApi for tests, with call recording. */
import type { MbCredit, MbRecording, MbRelease, MbReleaseRef, MusicBrainzApi } from '../metadata/musicbrainz/types.js';

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
    const title = /recording:(?:"([^"]+)"|\(([^)]+)\))/.exec(query);
    const t = (title?.[1] ?? title?.[2] ?? '').replace(/\\/g, '').toLowerCase();
    return this.recordings.filter((r) => r.title.toLowerCase().replace(/[^\w\s]/g, '').includes(t.replace(/[^\w\s]/g, '')));
  }

  async searchReleases(query: string): Promise<MbReleaseRef[]> {
    this.calls.push(`searchReleases ${query}`);
    const title = /release:(?:"([^"]+)"|\(([^)]+)\))/.exec(query);
    const t = (title?.[1] ?? title?.[2] ?? '').replace(/\\/g, '').toLowerCase();
    return this.releases.filter((r) => r.title.toLowerCase().includes(t)).map(({ tracks: _t, ...ref }) => ref);
  }

  async getRelease(mbid: string): Promise<MbRelease | null> {
    this.calls.push(`getRelease ${mbid}`);
    return this.releases.find((r) => r.id === mbid) ?? null;
  }

  async getRecording(mbid: string): Promise<MbRecording | null> {
    this.calls.push(`getRecording ${mbid}`);
    return this.recordings.find((r) => r.id === mbid) ?? null;
  }
}

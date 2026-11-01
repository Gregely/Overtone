/** Normalized MusicBrainz shapes used by the matcher and library. */

export interface MbArtistRef {
  id: string;
  name: string;
  sortName: string;
}

export interface MbCredit {
  /** Full credit string as displayed, e.g. "Daft Punk feat. Pharrell Williams". */
  text: string;
  artists: MbArtistRef[];
}

export interface MbReleaseGroupRef {
  id: string;
  primaryType: string | null;
  secondaryTypes: string[];
}

export interface MbReleaseRef {
  id: string;
  title: string;
  status: string | null;
  date: string | null;
  country: string | null;
  credit: MbCredit | null;
  releaseGroup: MbReleaseGroupRef | null;
  trackCount: number | null;
  /** Position of the recording on this release (from recording search/lookup). */
  discNo: number | null;
  trackNo: number | null;
}

export interface MbRecording {
  id: string;
  title: string;
  lengthMs: number | null;
  credit: MbCredit;
  releases: MbReleaseRef[];
}

export interface MbReleaseTrack {
  discNo: number;
  trackNo: number;
  title: string;
  lengthMs: number | null;
  recording: { id: string; title: string; lengthMs: number | null; credit: MbCredit };
}

export interface MbRelease extends MbReleaseRef {
  tracks: MbReleaseTrack[];
}

/** The subset of the client the matcher needs; mocked in tests. */
export interface MusicBrainzApi {
  searchRecordings(query: string, limit?: number): Promise<MbRecording[]>;
  searchReleases(query: string, limit?: number): Promise<MbReleaseRef[]>;
  getRelease(mbid: string): Promise<MbRelease | null>;
  getRecording(mbid: string): Promise<MbRecording | null>;
}

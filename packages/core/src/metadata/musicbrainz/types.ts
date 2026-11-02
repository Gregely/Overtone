/** Normalized MusicBrainz shapes used by the matcher, catalogue and library. */

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

/** An artist as returned by artist search. */
export interface MbArtist {
  id: string;
  name: string;
  sortName: string;
  disambiguation: string | null;
}

/** A release group (album) as returned by release-group search / artist discography. */
export interface MbReleaseGroup {
  id: string;
  title: string;
  credit: MbCredit;
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
}

/** An artist with their release-group discography. */
export interface MbArtistDetail extends MbArtist {
  releaseGroups: MbReleaseGroup[];
}

/** The subset of the client the matcher/catalogue needs; mocked in tests. */
export interface MusicBrainzApi {
  searchRecordings(query: string, limit?: number): Promise<MbRecording[]>;
  searchReleases(query: string, limit?: number): Promise<MbReleaseRef[]>;
  searchArtists(query: string, limit?: number): Promise<MbArtist[]>;
  searchReleaseGroups(query: string, limit?: number): Promise<MbReleaseGroup[]>;
  getRelease(mbid: string): Promise<MbRelease | null>;
  getRecording(mbid: string): Promise<MbRecording | null>;
  getArtist(mbid: string): Promise<MbArtistDetail | null>;
  /** Resolve a release group to its metadata and a representative release (with tracklist). */
  getReleaseGroup(mbid: string): Promise<{ releaseGroup: MbReleaseGroup; release: MbRelease } | null>;
}

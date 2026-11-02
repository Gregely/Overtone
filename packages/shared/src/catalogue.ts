/**
 * MusicBrainz catalogue DTOs — the browsing/search surface, independent of the
 * user's library and of torrent/debrid availability. A catalogue entry exists
 * whether or not Overtone can currently play it.
 */

export interface CatalogueArtistDto {
  mbid: string;
  name: string;
  disambiguation: string | null;
}

export interface CatalogueReleaseGroupDto {
  mbid: string;
  title: string;
  artistCredit: string;
  primaryType: string | null;
  year: number | null;
}

export interface CatalogueRecordingDto {
  mbid: string;
  title: string;
  artistCredit: string;
  durationMs: number | null;
}

export interface CatalogueSearchResultDto {
  artists: CatalogueArtistDto[];
  releases: CatalogueReleaseGroupDto[];
  recordings: CatalogueRecordingDto[];
}

export interface CatalogueTrackDto {
  title: string;
  artistCredit: string;
  discNo: number;
  trackNo: number;
  durationMs: number | null;
  recordingMbid: string | null;
}

export interface CatalogueReleaseDto {
  /** Release-group MBID — the stable "album" identity. */
  mbid: string;
  title: string;
  artistCredit: string;
  year: number | null;
  date: string | null;
  trackCount: number;
  tracks: CatalogueTrackDto[];
  /** Cover Art Archive front URL (absolute), or null. */
  coverUrl: string | null;
}

export interface CatalogueArtistDetailDto {
  artist: CatalogueArtistDto;
  releaseGroups: CatalogueReleaseGroupDto[];
}

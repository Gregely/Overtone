import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  AlbumDetailDto,
  AlbumDto,
  ArtistDetailDto,
  ArtistDto,
  ConnectionTestResultDto,
  HomeDto,
  LibraryFileDto,
  MatchCandidateDto,
  MatchStatus,
  PageDto,
  ProviderManifestDto,
  ReleaseCandidateDto,
  ScanStatusDto,
  SearchResultDto,
  SourceDto,
  SourceWriteDto,
  TrackDto,
} from '@overtone/shared';
import { useApi, useIsAdmin } from '../app/context';
import { NetworkError } from './client';

const PAGE = 60;

export const keys = {
  library: ['library'] as const,
  home: ['library', 'home'] as const,
  artists: (q: string) => ['library', 'artists', q] as const,
  artist: (id: number) => ['library', 'artist', id] as const,
  albums: (q: string, sort: string) => ['library', 'albums', q, sort] as const,
  album: (id: number) => ['library', 'album', id] as const,
  tracks: (q: string, sort: string) => ['library', 'tracks', q, sort] as const,
  search: (q: string) => ['library', 'search', q] as const,
  files: (status: string) => ['library', 'files', status] as const,
  trackFiles: (trackId: number) => ['library', 'trackFiles', trackId] as const,
  providers: ['providers'] as const,
  sources: ['sources'] as const,
  source: (id: string) => ['sources', id] as const,
  scan: ['scan'] as const,
};

export function retryPolicy(count: number, err: unknown): boolean {
  return err instanceof NetworkError && count < 2;
}

export function useHome() {
  const api = useApi();
  return useQuery({ queryKey: keys.home, queryFn: ({ signal }) => api.get<HomeDto>('/api/library/home', undefined, signal) });
}

function usePaged<T>(key: readonly unknown[], path: string, query: Record<string, string | number | undefined>) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.get<PageDto<T>>(path, { ...query, offset: pageParam, limit: PAGE }, signal),
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
  });
}

export const useArtists = (q: string) => usePaged<ArtistDto>(keys.artists(q), '/api/library/artists', { q });
export const useAlbums = (q: string, sort: string) => usePaged<AlbumDto>(keys.albums(q, sort), '/api/library/albums', { q, sort });
export const useTracks = (q: string, sort: string) => usePaged<TrackDto>(keys.tracks(q, sort), '/api/library/tracks', { q, sort });

export function useArtist(id: number) {
  const api = useApi();
  return useQuery({ queryKey: keys.artist(id), queryFn: ({ signal }) => api.get<ArtistDetailDto>(`/api/library/artists/${id}`, undefined, signal) });
}

export function useAlbum(id: number) {
  const api = useApi();
  return useQuery({ queryKey: keys.album(id), queryFn: ({ signal }) => api.get<AlbumDetailDto>(`/api/library/albums/${id}`, undefined, signal) });
}

export function useSearch(q: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.search(q),
    queryFn: ({ signal }) => api.get<SearchResultDto>('/api/search', { q }, signal),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });
}

// ── admin: sources ─────────────────────────────────────────────────────────

export function useProviders() {
  const api = useApi();
  return useQuery({ queryKey: keys.providers, queryFn: () => api.get<ProviderManifestDto[]>('/api/providers'), staleTime: Infinity });
}

export function useSources() {
  const api = useApi();
  const admin = useIsAdmin();
  return useQuery({ queryKey: keys.sources, queryFn: () => api.get<SourceDto[]>('/api/sources'), enabled: admin });
}

export function useSource(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: keys.source(id ?? ''), queryFn: () => api.get<SourceDto>(`/api/sources/${id}`), enabled: Boolean(id) });
}

export function useSaveSource() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: SourceWriteDto }) =>
      id ? api.patch<SourceDto>(`/api/sources/${id}`, body) : api.post<SourceDto>('/api/sources', body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteSource() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/api/sources/${id}`), onSuccess: () => invalidateAll(qc) });
}

export function useTestSource() {
  const api = useApi();
  return useMutation({
    mutationFn: ({ id, providerId, config }: { id?: string; providerId: string; config: Record<string, unknown> }) =>
      id
        ? api.post<ConnectionTestResultDto>(`/api/sources/${id}/test`, { config })
        : api.post<ConnectionTestResultDto>(`/api/providers/${providerId}/test`, { config }),
  });
}

export function useScan() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id?: string) => api.post<ScanStatusDto>(id ? `/api/sources/${id}/scan` : '/api/scan'),
    onSuccess: (status) => qc.setQueryData(keys.scan, status),
  });
}

/** Scan + match progress, polled faster while something is happening. Admin only. */
export function useScanStatus() {
  const api = useApi();
  const admin = useIsAdmin();
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.scan,
    enabled: admin,
    queryFn: async () => {
      const prev = qc.getQueryData<ScanStatusDto>(keys.scan);
      const next = await api.get<ScanStatusDto>('/api/scan/status');
      // When work finishes, the library changed: refresh views.
      if (prev && busy(prev) && !busy(next)) void qc.invalidateQueries({ queryKey: keys.library });
      return next;
    },
    refetchInterval: (q) => (q.state.data && busy(q.state.data) ? 3000 : 60_000),
  });
}

export function busy(s: ScanStatusDto): boolean {
  return Boolean(s.running) || s.queued.length > 0 || s.matching.pending > 0;
}

// ── admin: matching ────────────────────────────────────────────────────────

export function useFiles(status: MatchStatus) {
  return usePaged<LibraryFileDto>(keys.files(status), '/api/library/files', { status });
}

export function useTrackFiles(trackId: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.trackFiles(trackId ?? 0),
    queryFn: () => api.get<PageDto<LibraryFileDto>>('/api/library/files', { trackId: trackId!, limit: 50 }),
    enabled: trackId !== null,
  });
}

export function useCandidateSearch() {
  const api = useApi();
  return useMutation({
    mutationFn: ({ fileId, title, artist }: { fileId: number; title: string; artist: string }) =>
      api.get<MatchCandidateDto[]>(`/api/library/files/${fileId}/candidates`, { title, artist }),
  });
}

export function useApplyMatch() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId, recordingMbid, releaseMbid }: { fileId: number; recordingMbid: string; releaseMbid?: string | null }) =>
      api.post<LibraryFileDto>(`/api/library/files/${fileId}/match`, { recordingMbid, ...(releaseMbid ? { releaseMbid } : {}) }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useRematch() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: number) => api.post<LibraryFileDto>(`/api/library/files/${fileId}/rematch`),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useReleaseSearch() {
  const api = useApi();
  return useMutation({
    mutationFn: ({ q, artist }: { q: string; artist: string }) => api.get<ReleaseCandidateDto[]>('/api/match/releases', { q, artist }),
  });
}

export function useAlbumMatch() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ albumId, releaseMbid }: { albumId: number; releaseMbid: string }) =>
      api.post<AlbumDetailDto>(`/api/library/albums/${albumId}/match`, { releaseMbid }),
    onSuccess: () => invalidateAll(qc),
  });
}

function invalidateAll(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: keys.library });
  void qc.invalidateQueries({ queryKey: keys.sources });
  void qc.invalidateQueries({ queryKey: keys.scan });
}

/**
 * Subsonic / OpenSubsonic (Navidrome, Gonic, Airsonic-Advanced, …).
 *
 * API docs (checked 2026-11-01):
 *  - Subsonic: https://www.subsonic.org/pages/api.jsp
 *  - OpenSubsonic: https://opensubsonic.netlify.app/docs/ (endpoints/search3,
 *    getalbumlist2, getalbum, stream; responses/subsonic-response, child,
 *    error; extensions/apikeyauth)
 *
 * Auth: token auth (API ≥ 1.13.0): u, t = md5(password + salt), s = random
 * salt — never the plaintext/hex `p=` password. OpenSubsonic servers may
 * instead take `apiKey` (apiKeyAuthentication extension; must not be combined
 * with u/t/s). Error codes: 40 wrong credentials, 41 token auth unsupported
 * (LDAP), 42 mechanism unsupported, 43 conflicting mechanisms, 44 invalid API
 * key, 50 not authorized, 70 not found; 20/30 version mismatch.
 *
 * Listing: OpenSubsonic requires search3 with an empty query to return all
 * songs ("for offline sync"), paged by songCount/songOffset. Classic Subsonic
 * servers aren't guaranteed to, so we fall back to getAlbumList2
 * (alphabeticalByName, size ≤ 500, offset) + getAlbum per album.
 *
 * Streams: /rest/stream with format=raw (no transcoding). The URL carries
 * auth parameters, so it is never redirect-safe: the server always proxies.
 * On error, stream returns an XML/JSON document instead of audio (the
 * streaming layer rejects non-audio responses).
 */
import { audioMimeType, isAudioFile } from '@overtone/shared';
import { md5Hex, randomBytes, toHex } from '../../crypto.js';
import { ProviderError } from '../errors.js';
import { readJson, send } from '../http.js';
import type { CallOptions, FileTags, ProviderContext, ProviderPlugin, SourceFile, SourceProvider } from '../types.js';

export const SUBSONIC_API_VERSION = '1.16.1';
const CLIENT = 'Overtone';
const SONG_PAGE = 500;
const ALBUM_PAGE = 500;

export type SubsonicConfig = {
  url: string;
  username?: string;
  password?: string;
  apiKey?: string;
};

export const subsonicPlugin: ProviderPlugin<SubsonicConfig> = {
  manifest: {
    id: 'subsonic',
    name: 'Subsonic / Navidrome',
    description: 'A Navidrome, Gonic, Airsonic or other Subsonic-compatible server.',
    category: 'server',
    capabilities: { testConnection: true, redirectable: false },
    configSchema: {
      fields: [
        { key: 'url', type: 'url', label: 'Server URL', required: true, placeholder: 'https://navidrome.example.com' },
        { key: 'username', type: 'string', label: 'Username' },
        {
          key: 'password',
          type: 'secret',
          label: 'Password',
          help: 'Sent as a salted token (Subsonic token auth), never in plain text.',
        },
        {
          key: 'apiKey',
          type: 'secret',
          label: 'API key (OpenSubsonic)',
          help: 'Instead of username + password, for servers that issue API keys (needed for LDAP accounts on some servers).',
        },
      ],
    },
  },
  create(config, ctx) {
    return new SubsonicProvider(config, ctx);
  },
};

interface SubsonicSong {
  id: string;
  title?: string;
  album?: string;
  artist?: string;
  displayAlbumArtist?: string;
  albumArtists?: Array<{ name: string }>;
  track?: number;
  discNumber?: number;
  year?: number;
  genre?: string;
  size?: number;
  suffix?: string;
  contentType?: string;
  duration?: number;
  path?: string;
  created?: string;
  isDir?: boolean;
  isVideo?: boolean;
  type?: string;
  mediaType?: string;
  musicBrainzId?: string;
}

interface Envelope {
  'subsonic-response'?: {
    status: 'ok' | 'failed';
    version: string;
    type?: string;
    serverVersion?: string;
    openSubsonic?: boolean;
    error?: { code: number; message?: string };
    [k: string]: unknown;
  };
}

export class SubsonicProvider implements SourceProvider {
  readonly #base: string;
  readonly #c: SubsonicConfig;
  readonly #ctx: ProviderContext;
  #server: { openSubsonic: boolean; type?: string; serverVersion?: string; version: string } | undefined;

  constructor(config: SubsonicConfig, ctx: ProviderContext) {
    this.#base = String(config.url).replace(/\/+$/, '');
    this.#c = config;
    this.#ctx = ctx;
  }

  /** Auth query params: apiKey, or u + salted token. A fresh salt per request. */
  authParams(): URLSearchParams {
    const p = new URLSearchParams({ v: SUBSONIC_API_VERSION, c: CLIENT, f: 'json' });
    if (this.#c.apiKey) {
      p.set('apiKey', this.#c.apiKey);
      return p;
    }
    if (!this.#c.username || !this.#c.password) {
      throw new ProviderError('config', 'Subsonic: enter a username and password, or an API key');
    }
    const salt = toHex(randomBytes(8));
    p.set('u', this.#c.username);
    p.set('t', subsonicToken(this.#c.password, salt));
    p.set('s', salt);
    return p;
  }

  async #call<T extends object>(endpoint: string, params: Record<string, string | number>, what: string, signal: AbortSignal): Promise<T & Record<string, unknown>> {
    const q = this.authParams();
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    const res = await send(this.#ctx, `${this.#base}/rest/${endpoint}.view?${q}`, { signal }, what);
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `${what}: the server rejected the credentials`);
      if (res.status === 404) throw new ProviderError('config', `${what}: no Subsonic API at this URL (HTTP 404)`);
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after'));
        throw new ProviderError('rate_limited', `${what}: server rate limit reached`, retry > 0 ? { retryAfterMs: retry * 1000 } : {});
      }
      throw new ProviderError('unavailable', `${what}: server returned HTTP ${res.status}`);
    }
    let body: Envelope;
    try {
      body = await readJson<Envelope>(res, what);
    } catch {
      throw new ProviderError('config', `${what}: this doesn't look like a Subsonic server (expected a JSON response)`);
    }
    const r = body['subsonic-response'];
    if (!r) throw new ProviderError('config', `${what}: this doesn't look like a Subsonic server`);
    this.#server = { openSubsonic: r.openSubsonic === true, version: r.version, ...(r.type ? { type: r.type } : {}), ...(r.serverVersion ? { serverVersion: r.serverVersion } : {}) };
    if (r.status !== 'ok') throw subsonicError(r.error?.code ?? 0, r.error?.message, what);
    return r as unknown as T & Record<string, unknown>;
  }

  async testConnection({ signal }: CallOptions) {
    try {
      await this.#call('ping', {}, 'Connect', signal);
      const s = this.#server!;
      const name = s.type ? `${s.type}${s.serverVersion ? ` ${s.serverVersion}` : ''}` : 'Subsonic server';
      return {
        ok: true,
        message: `Connected to ${name} (API ${s.version}${s.openSubsonic ? ', OpenSubsonic' : ''}).`,
        details: { server: s.type ?? 'Subsonic', apiVersion: s.version, openSubsonic: String(s.openSubsonic) },
      };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, message: err.message };
      throw err;
    }
  }

  async *listLibrary({ signal }: CallOptions): AsyncIterable<SourceFile> {
    await this.#call('ping', {}, 'Connect', signal);
    const seen = new Set<string>();
    let yielded = 0;
    if (this.#server!.openSubsonic) {
      for (let offset = 0; ; offset += SONG_PAGE) {
        const r = await this.#call<{ searchResult3?: { song?: SubsonicSong[] } }>(
          'search3',
          { query: '', songCount: SONG_PAGE, songOffset: offset, artistCount: 0, albumCount: 0 },
          'List songs',
          signal,
        );
        const songs = r.searchResult3?.song ?? [];
        for (const s of songs) {
          const f = toSourceFile(s);
          if (f && !seen.has(f.id)) {
            seen.add(f.id);
            yielded++;
            yield f;
          }
        }
        if (songs.length < SONG_PAGE) break;
      }
      // A server that claims OpenSubsonic but ignores empty queries: fall through to the album crawl.
      if (yielded > 0) return;
    }
    for (let offset = 0; ; offset += ALBUM_PAGE) {
      const r = await this.#call<{ albumList2?: { album?: Array<{ id: string }> } }>(
        'getAlbumList2',
        { type: 'alphabeticalByName', size: ALBUM_PAGE, offset },
        'List albums',
        signal,
      );
      const albums = r.albumList2?.album ?? [];
      for (const a of albums) {
        const full = await this.#call<{ album?: { song?: SubsonicSong[] } }>('getAlbum', { id: a.id }, 'Read album', signal);
        for (const s of full.album?.song ?? []) {
          const f = toSourceFile(s);
          if (f && !seen.has(f.id)) {
            seen.add(f.id);
            yield f;
          }
        }
      }
      if (albums.length < ALBUM_PAGE) break;
    }
  }

  async resolveStream(fileId: string) {
    const q = this.authParams();
    q.delete('f');
    q.set('id', fileId);
    q.set('format', 'raw'); // original file, no transcoding
    // Credentials are in the query string: proxy only, never redirect.
    return { url: `${this.#base}/rest/stream.view?${q}`, redirectSafe: false };
  }
}

export function subsonicToken(password: string, salt: string): string {
  return md5Hex(`${password}${salt}`);
}

export function subsonicError(code: number, message: string | undefined, what: string): ProviderError {
  switch (code) {
    case 40:
      return new ProviderError('auth', `${what}: wrong username or password`);
    case 41:
      return new ProviderError('config', `${what}: this server doesn't support token authentication for this user (e.g. LDAP). Use an API key instead.`);
    case 42:
      return new ProviderError('config', `${what}: the server doesn't accept this login method. Try an API key, or username + password.`);
    case 43:
      return new ProviderError('config', `${what}: fill in either an API key or username + password, not both`);
    case 44:
      return new ProviderError('auth', `${what}: invalid API key`);
    case 50:
      return new ProviderError('auth', `${what}: this user isn't allowed to do that on the server`);
    case 70:
      return new ProviderError('not_found', `${what}: not found on the server`);
    case 20:
    case 30:
      return new ProviderError('config', `${what}: incompatible Subsonic API version (${message ?? 'version mismatch'})`);
    default:
      return new ProviderError('unavailable', `${what}: server error ${code}${message ? ` (${message})` : ''}`);
  }
}

/** Map a Subsonic "Child" song to a SourceFile with tags. Returns null for videos/dirs/non-audio. */
export function toSourceFile(s: SubsonicSong): SourceFile | null {
  if (s.isDir || s.isVideo || s.type === 'video' || s.mediaType === 'video') return null;
  const suffix = s.suffix?.toLowerCase();
  const fromPath = s.path?.split('/').pop();
  let name = fromPath && isAudioFile(fromPath) ? fromPath : `${s.title ?? s.id}${suffix ? `.${suffix}` : ''}`;
  if (!isAudioFile(name)) {
    if (!s.contentType?.startsWith('audio/')) return null;
    name = `${name}.${suffix ?? 'audio'}`;
  }
  const albumArtist = s.displayAlbumArtist || s.albumArtists?.[0]?.name;
  const tags: FileTags = {};
  if (s.title) tags.title = s.title;
  if (s.artist) tags.artist = s.artist;
  if (albumArtist) tags.albumArtist = albumArtist;
  if (s.album) tags.album = s.album;
  if (s.track) tags.trackNumber = s.track;
  if (s.discNumber) tags.discNumber = s.discNumber;
  if (s.year) tags.year = s.year;
  if (s.genre) tags.genre = [s.genre];
  if (s.duration) tags.durationMs = s.duration * 1000;
  if (s.musicBrainzId) tags.musicbrainz = { recordingId: s.musicBrainzId.toLowerCase() };
  const folder = [albumArtist ?? s.artist ?? 'Unknown Artist', s.album ?? 'Unknown Album'].map((x) => x.replace(/\//g, '∕'));
  const mimeType = s.contentType?.startsWith('audio/') ? s.contentType : audioMimeType(name);
  return {
    id: s.id,
    name,
    path: s.path && isAudioFile(s.path) ? s.path.replace(/^\/+/, '') : `${folder.join('/')}/${name}`,
    size: s.size ?? 0,
    ...(mimeType ? { mimeType } : {}),
    ...(s.created ? { modifiedAt: new Date(s.created) } : {}),
    ...(s.duration ? { durationMs: s.duration * 1000 } : {}),
    tags,
  };
}

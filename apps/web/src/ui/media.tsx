import { useState } from 'react';
import { Link } from 'react-router';
import type { AlbumDto, MatchStatus, SourceBadgeDto } from '@overtone/shared';
import { useApi } from '../app/context';
import { Icon } from './Icon';

type CoverSize = 250 | 500 | 1200;

/** Album art with a calm placeholder. Decorative by default (text is always adjacent). */
export function Cover({ url, size = 250, className = '', alt = '' }: { url: string | null; size?: CoverSize; className?: string; alt?: string }) {
  const api = useApi();
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div className={`cover ${className}`} role={alt ? 'img' : undefined} aria-label={alt || undefined}>
        <Icon name="album" size={className.includes('sm') ? 18 : 36} />
      </div>
    );
  }
  return (
    <img
      className={`cover ${className}`}
      src={api.url(`${url}&size=${size}`)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

const CATEGORY_LABEL: Record<SourceBadgeDto['category'], string> = { local: 'Local', server: 'Server', public: 'Archive', debrid: 'Debrid' };

export function SourceBadges({ sources }: { sources: SourceBadgeDto[] }) {
  if (!sources.length) return null;
  const label = `Available from ${sources.map((s) => s.sourceName).join(', ')}`;
  return (
    <span className="row" style={{ gap: 4, flex: 'none' }} title={label}>
      <span className="visually-hidden">{label}</span>
      {sources.map((s) => (
        <span key={s.sourceId} className="badge" aria-hidden="true">
          {CATEGORY_LABEL[s.category]}
        </span>
      ))}
    </span>
  );
}

export function MatchBadge({ status }: { status: MatchStatus }) {
  if (status === 'needs_review') return <span className="badge warn" title="Low-confidence MusicBrainz match">Check match</span>;
  if (status === 'unmatched') return <span className="badge warn" title="Not matched to MusicBrainz; shown from file tags">From tags</span>;
  return null;
}

export function AlbumCard({ album }: { album: AlbumDto }) {
  const by = album.artistCredit;
  return (
    <Link to={`/albums/${album.id}`} className="album-card">
      <Cover url={album.coverUrl} />
      {album.attention > 0 && (
        <span className="badge warn dot-badge" title="Some tracks need a match check">
          <span aria-hidden="true">!</span>
          <span className="visually-hidden">, some tracks need a match check</span>
        </span>
      )}
      <span className="title truncate">{album.title}</span>
      <span className="small muted truncate">
        <span className="visually-hidden">by </span>
        {by}
        {album.year ? ` · ${album.year}` : ''}
      </span>
    </Link>
  );
}

export function AlbumGrid({ albums, strip = false, label }: { albums: AlbumDto[]; strip?: boolean; label?: string }) {
  return (
    <ul className={strip ? 'album-strip' : 'album-grid'} aria-label={label}>
      {albums.map((a) => (
        <li key={a.id}>
          <AlbumCard album={a} />
        </li>
      ))}
    </ul>
  );
}

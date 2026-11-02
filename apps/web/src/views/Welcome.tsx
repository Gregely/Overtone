import { useEffect } from 'react';
import { Link } from 'react-router';
import type { AppMode } from '../api/client';
import { useProviders } from '../api/hooks';
import { Page } from '../layout/Page';
import { Icon } from '../ui/Icon';
import { QueryView } from '../ui/states';

/** First launch of the app: where should the library live? */
export function ModeChooser({ onChoose }: { onChoose: (mode: AppMode) => void }) {
  useEffect(() => {
    document.title = 'Welcome · Overtone';
  }, []);
  return (
    <main className="auth" id="main">
      <div className="card stack">
        <div className="brand">
          <Icon name="bars" /> Overtone
        </div>
        <h1>How do you want to use Overtone?</h1>
        <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          <li>
            <button type="button" className="choice" onClick={() => onChoose('standalone')}>
              <strong>Use on this device</strong> <span className="badge accent">Recommended</span>
              <span className="small muted">
                Everything runs on your phone: no server to set up and no account. Add music from this phone, your own music server, the Internet Archive or a
                debrid account.
              </span>
            </button>
          </li>
          <li>
            <button type="button" className="choice" onClick={() => onChoose('server')}>
              <strong>Connect to my server</strong> <span className="badge">Advanced</span>
              <span className="small muted">
                You run an Overtone server (for example on a Raspberry Pi) and want the same library on several devices. You'll need its address and an account.
              </span>
            </button>
          </li>
        </ul>
        <p className="small muted">You can change this later in Settings. Switching never deletes the other mode's library.</p>
      </div>
    </main>
  );
}

/** Plain-language descriptions for the "Add your first source" guide. */
const GUIDE: Record<string, { title: string; text: string; needs: string }> = {
  'device-folder': {
    title: 'Music on this phone',
    text: 'Files you already have on this phone or its SD card. Pick a folder; Overtone can read that folder and nothing else. Works offline.',
    needs: 'Needs: a folder with music files (MP3, FLAC, M4A, Ogg, Opus, WAV…).',
  },
  subsonic: {
    title: 'Your own music server',
    text: 'Navidrome, Airsonic, Gonic and other Subsonic-compatible servers you or a friend run.',
    needs: "Needs: the server's address, your username and password (or an API key).",
  },
  'internet-archive': {
    title: 'Internet Archive',
    text: 'Free, legal recordings from archive.org: public-domain and Creative Commons audio, such as live concerts and old records.',
    needs: 'Needs: nothing, or a collection name if you want a specific one.',
  },
  'real-debrid': { title: 'Real-Debrid account', text: 'Audio files already in your Real-Debrid account.', needs: 'Needs: a Real-Debrid account (log in with a code, or paste an API key).' },
  alldebrid: { title: 'AllDebrid account', text: 'Audio files already in your AllDebrid account.', needs: 'Needs: an AllDebrid account (log in with a PIN, or paste an API key).' },
  torbox: { title: 'TorBox account', text: 'Audio files already in your TorBox account.', needs: 'Needs: a TorBox account (log in with a code, or paste an API key).' },
  premiumize: { title: 'Premiumize account', text: 'Audio files already in your Premiumize cloud.', needs: 'Needs: a Premiumize account and its API key.' },
};

/** Shown after choosing standalone mode, and on Home while there are no sources. */
export function FirstSourceGuide({ compact = false }: { compact?: boolean }) {
  const providers = useProviders();
  const body = (
    <QueryView query={providers} label="Loading source types">
      {(list) => (
        <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Source types">
          {list.map((p) => {
            const g = GUIDE[p.id] ?? { title: p.name, text: p.description, needs: '' };
            return (
              <li key={p.id}>
                <Link to={`/settings/sources/new?provider=${p.id}`} className="choice">
                  <strong>{g.title}</strong>
                  <span className="small">{g.text}</span>
                  {g.needs && <span className="small muted">{g.needs}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </QueryView>
  );
  if (compact) return body;
  return (
    <Page title="Add your first source">
      <p className="muted">
        A source is somewhere your music already is. Overtone reads what's there, tidies up the names with MusicBrainz, and plays it. It never searches for,
        downloads or adds new content. Debrid accounts are read-only: only files already in your account are played.
      </p>
      {body}
      <p className="small muted">You can add more sources any time in Settings › Sources.</p>
    </Page>
  );
}

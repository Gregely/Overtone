import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { LibraryExportDto, LibraryImportResultDto, LibraryInfoDto } from '@overtone/shared';
import { ApiError } from '../api/client';
import { useLibraryInfo } from '../api/hooks';
import { useApi } from '../app/context';
import { useMode } from '../app/mode';
import { openTextFile, saveTextFile } from '../platform/files';
import { Dialog } from '../ui/Dialog';
import { formatBytes, plural, relativeTime } from '../ui/format';
import { Icon } from '../ui/Icon';
import { errorMessage } from '../ui/states';

/** Settings › Mode: what's active, and switching with a clear explanation of what happens to data. */
export function ModeSettings() {
  const { mode, canSwitch, switchMode } = useMode();
  const [confirm, setConfirm] = useState(false);
  if (!canSwitch && mode === 'server') return null;
  const other = mode === 'standalone' ? 'server' : 'standalone';
  return (
    <section className="card stack-sm" aria-labelledby="set-mode">
      <h2 id="set-mode">Mode</h2>
      <p>
        {mode === 'standalone' ? (
          <>
            <strong>On this device.</strong> Your library, sources and their keys are stored on this phone. No server is used.
          </>
        ) : (
          <>
            <strong>Connected to a server.</strong> Your library lives on your Overtone server.
          </>
        )}
      </p>
      {canSwitch && (
        <div>
          <button type="button" className="btn" onClick={() => setConfirm(true)}>
            {other === 'server' ? 'Connect to a server instead…' : 'Use on this device instead…'}
          </button>
        </div>
      )}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={other === 'server' ? 'Connect to a server?' : 'Use Overtone on this device?'}>
        {other === 'server' ? (
          <p>
            Overtone will show your server's library instead. The library on this phone, its sources and saved keys are <strong>kept, not deleted</strong>, and
            come back when you switch back. Nothing is copied to the server.
          </p>
        ) : (
          <p>
            Overtone will use a library stored on this phone instead of your server. Your server, its library and your sign-in are <strong>not changed</strong>;
            switch back any time. The first time, the on-device library is empty: add sources to fill it.
          </p>
        )}
        <div className="row">
          <button type="button" className="btn primary" onClick={() => void switchMode(other)}>
            Switch
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </section>
  );
}

/** Settings › Library (standalone): storage, scan/match status, export/import, reset. */
export function LibrarySettings() {
  const info = useLibraryInfo(true);
  return (
    <section className="card stack-sm" aria-labelledby="set-library">
      <h2 id="set-library">Library</h2>
      {info.data ? <LibraryFacts info={info.data} /> : info.error ? <p className="banner error">{errorMessage(info.error)}</p> : <p className="muted">Loading…</p>}
      <ExportImport />
      <ResetLibrary />
    </section>
  );
}

function LibraryFacts({ info }: { info: LibraryInfoDto }) {
  const storage = (info.databaseBytes ?? 0) + (info.artworkBytes ?? 0);
  const m = info.matching;
  return (
    <dl className="meta">
      <dt>Storage used</dt>
      <dd>
        {info.databaseBytes === null && info.artworkBytes === null ? 'unknown' : formatBytes(storage)}
        {info.artworkBytes ? <span className="small muted"> (artwork {formatBytes(info.artworkBytes)})</span> : null}
      </dd>
      <dt>Contents</dt>
      <dd>
        {plural(info.stats.tracks, 'track')}, {plural(info.stats.albums, 'album')} from {plural(info.sourceCount, 'source')}
      </dd>
      <dt>Last scan</dt>
      <dd>{info.scanning ? 'Scanning now…' : relativeTime(info.lastScanAt)}</dd>
      <dt>Matching</dt>
      <dd>
        {m.pending ? `${plural(m.pending, 'file')} waiting for MusicBrainz` : 'Up to date'}
        {m.needsReview || m.unmatched ? (
          <span className="small muted">
            {' '}
            · {m.needsReview} to review, {m.unmatched} unmatched
          </span>
        ) : null}
      </dd>
    </dl>
  );
}

function ExportImport() {
  const api = useApi();
  const qc = useQueryClient();
  const [withKeys, setWithKeys] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [importPass, setImportPass] = useState('');
  const [pendingImport, setPendingImport] = useState<LibraryExportDto | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const file = await api.post<LibraryExportDto>('/api/library/export', withKeys ? { passphrase } : {});
      const saved = await saveTextFile(`overtone-library-${file.exportedAt.slice(0, 10)}.json`, JSON.stringify(file));
      if (saved) setMsg({ ok: true, text: withKeys ? 'Exported, with keys encrypted by your passphrase.' : 'Exported (without keys or passwords).' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError && err.fields ? Object.values(err.fields).join(' ') : errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    setMsg(null);
    const f = await openTextFile();
    if (!f) return;
    try {
      setPendingImport(JSON.parse(f.text) as LibraryExportDto);
    } catch {
      setMsg({ ok: false, text: "That file isn't an Overtone library export." });
    }
  };

  const doImport = async () => {
    if (!pendingImport) return;
    setBusy(true);
    try {
      const r = await api.post<LibraryImportResultDto>('/api/library/import', { file: pendingImport, ...(importPass ? { passphrase: importPass } : {}) });
      setPendingImport(null);
      setImportPass('');
      await qc.invalidateQueries();
      setMsg({
        ok: true,
        text: `Imported ${plural(r.sources, 'source')} and ${plural(r.files, 'file')}.${r.secretsRestored ? '' : ' Re-enter keys or log in again for sources that need them.'}`,
      });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError && err.fields ? Object.values(err.fields).join(' ') : errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      <h3>Export and import</h3>
      <p className="small muted">
        A file with your sources' settings and your library (including fixed matches). Keys, passwords and logins are left out unless you protect them with a
        passphrase.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={withKeys} onChange={(e) => setWithKeys(e.target.checked)} /> Include keys and logins, encrypted
      </label>
      {withKeys && (
        <div className="field">
          <label htmlFor="exp-pass">Passphrase</label>
          <input id="exp-pass" className="input" type="password" autoComplete="new-password" minLength={8} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          <p className="help">At least 8 characters. You'll need it to import. It can't be recovered.</p>
        </div>
      )}
      <div className="row wrap">
        <button type="button" className="btn" onClick={() => void doExport()} disabled={busy || (withKeys && passphrase.length < 8)}>
          <Icon name="download" size={18} /> Export library
        </button>
        <button type="button" className="btn" onClick={() => void pick()} disabled={busy}>
          Import…
        </button>
      </div>
      {msg && (
        <p className={`banner ${msg.ok ? 'ok' : 'error'}`} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
      <Dialog open={pendingImport !== null} onClose={() => setPendingImport(null)} title="Replace your library?">
        <p>
          Importing <strong>replaces</strong> the sources and library on this device with the ones in the file
          {pendingImport ? ` (${plural(pendingImport.sources?.length ?? 0, 'source')}, exported ${relativeTime(pendingImport.exportedAt)})` : ''}. Your music files
          and accounts are not touched.
        </p>
        {pendingImport?.secrets && (
          <div className="field">
            <label htmlFor="imp-pass">Passphrase for the saved keys</label>
            <input id="imp-pass" className="input" type="password" autoComplete="off" value={importPass} onChange={(e) => setImportPass(e.target.value)} />
            <p className="help">Leave blank to import without keys.</p>
          </div>
        )}
        <div className="row">
          <button type="button" className="btn danger" onClick={() => void doImport()} disabled={busy}>
            {busy ? 'Importing…' : 'Replace library'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setPendingImport(null)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  );
}

function ResetLibrary() {
  const api = useApi();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/library/reset', {});
      await qc.invalidateQueries();
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-sm">
      <h3>Reset library</h3>
      <p className="small muted">Forget all tracks, albums and fixed matches and start over. Your sources stay; scan them again to rebuild.</p>
      <div>
        <button type="button" className="btn danger" onClick={() => setOpen(true)}>
          <Icon name="trash" size={18} /> Reset library…
        </button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Reset the library?">
        <p>
          This removes every track, album and artist from the library on this device, including matches you fixed by hand. Sources, keys and your music files are
          not touched. This can't be undone (export first if you might want it back).
        </p>
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button type="button" className="btn danger" disabled={busy} onClick={() => void reset()}>
            {busy ? 'Resetting…' : 'Reset library'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  );
}

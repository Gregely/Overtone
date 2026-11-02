import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { TorrentIndexerInfoDto, TorrentSourceDto, TorrentSourceKind, TorrentSourceTestResultDto, TorrentSourceWriteDto } from '@overtone/shared';
import { ApiError } from '../api/client';
import { useDeleteTorrentSource, useSaveTorrentSource, useTestTorrentSource, useTorrentSource, useTorrentSources } from '../api/hooks';
import { useIsAdmin } from '../app/context';
import { Page } from '../layout/Page';
import { Dialog } from '../ui/Dialog';
import { plural } from '../ui/format';
import { Icon } from '../ui/Icon';
import { EmptyState, errorMessage, QueryView, Spinner } from '../ui/states';

const KIND_LABEL: Record<TorrentSourceKind, string> = { prowlarr: 'Prowlarr', jackett: 'Jackett', torznab: 'Individual indexer' };

const KIND_DESC: Record<TorrentSourceKind, string> = {
  prowlarr: 'Connect a Prowlarr server to use all of its configured indexers.',
  jackett: 'Connect a Jackett server to use all of its configured indexers.',
  torznab: 'Add a single Torznab-compatible indexer by its endpoint URL.',
};

const KIND_DEFAULT_URL: Record<TorrentSourceKind, string> = {
  prowlarr: 'http://localhost:9696',
  jackett: 'http://localhost:9117',
  torznab: 'https://',
};

function AdminOnly({ children }: { children: React.ReactNode }) {
  const admin = useIsAdmin();
  if (!admin) return <Page title="Torrent sources"><p>Only admins can manage torrent sources.</p></Page>;
  return <>{children}</>;
}

export function TorrentSourcesView() {
  return (
    <AdminOnly>
      <TorrentSourcesList />
    </AdminOnly>
  );
}

function TorrentSourcesList() {
  const sources = useTorrentSources();
  return (
    <Page
      title="Torrent sources"
      actions={
        <Link to="/settings/torrent-sources/new" className="btn primary">
          <Icon name="plus" size={18} /> Add source
        </Link>
      }
    >
      <p className="muted">Indexers Overtone searches when you use “Find sources”. Connect Prowlarr or Jackett, or add an individual Torznab indexer.</p>
      <QueryView query={sources} label="Loading torrent sources">
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No torrent sources yet" icon="search">
              <p>Add an indexer to enable “Find sources”.</p>
            </EmptyState>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Torrent sources">
              {list.map((s) => (
                <TorrentSourceCard key={s.id} source={s} />
              ))}
            </ul>
          )
        }
      </QueryView>
    </Page>
  );
}

function TorrentSourceCard({ source: s }: { source: TorrentSourceDto }) {
  const del = useDeleteTorrentSource();
  const [confirm, setConfirm] = useState(false);
  const total = s.kind === 'torznab' ? 1 : s.indexers.length;
  const enabled = s.kind === 'torznab' ? (s.enabled ? 1 : 0) : s.indexers.filter((i) => i.enabled).length;
  const headingId = `tor-${s.id}`;
  return (
    <li className="card stack-sm" aria-labelledby={headingId}>
      <div className="row wrap">
        <h2 id={headingId}>{s.name}</h2>
        <span className="badge">{KIND_LABEL[s.kind]}</span>
        {!s.enabled && <span className="badge warn">Disabled</span>}
      </div>
      <p className="small muted">
        {plural(total, 'indexer')} · {enabled} enabled
      </p>
      {s.lastError && (
        <p className="banner" role="status">
          <Icon name="alert" size={18} /> {s.lastError}
        </p>
      )}
      <div className="row wrap">
        <Link to={`/settings/torrent-sources/${s.id}`} className="btn small" aria-label={`Edit ${s.name}`}>
          <Icon name="edit" size={16} /> Edit
        </Link>
        <button type="button" className="btn small danger" onClick={() => setConfirm(true)} aria-label={`Delete ${s.name}`}>
          <Icon name="trash" size={16} /> Delete
        </button>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Delete “${s.name}”?`}>
        <p>This removes the indexer connection. Your library and debrid accounts are not touched.</p>
        {del.error && <p className="banner error" role="alert">{errorMessage(del.error)}</p>}
        <div className="row">
          <button type="button" className="btn danger" disabled={del.isPending} onClick={() => del.mutate(s.id, { onSuccess: () => setConfirm(false) })}>
            Delete
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </li>
  );
}

// ── Add / edit ─────────────────────────────────────────────────────────────

export function TorrentSourceEditView() {
  return (
    <AdminOnly>
      <TorrentSourceEdit />
    </AdminOnly>
  );
}

function TorrentSourceEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const source = useTorrentSource(id);
  const save = useSaveTorrentSource();
  const test = useTestTorrentSource();

  const isEdit = Boolean(id);
  const [kind, setKind] = useState<TorrentSourceKind>('prowlarr');
  const [name, setName] = useState('');
  const [url, setUrl] = useState(KIND_DEFAULT_URL.prowlarr);
  const [apiKey, setApiKey] = useState('');
  const [indexers, setIndexers] = useState<TorrentIndexerInfoDto[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TorrentSourceTestResultDto | null>(null);

  // Seed from the saved source when editing.
  useEffect(() => {
    if (!source.data) return;
    setKind(source.data.kind);
    setName(source.data.name);
    setUrl(source.data.url);
    setIndexers(source.data.indexers);
  }, [source.data]);

  if (isEdit && source.isPending) return <Spinner label="Loading torrent source" />;
  if (isEdit && source.error) return <QueryView query={source}>{() => null}</QueryView>;

  const pickKind = (k: TorrentSourceKind) => {
    setKind(k);
    setUrl(KIND_DEFAULT_URL[k]);
    setIndexers([]);
    setTestResult(null);
  };

  const runTest = () => {
    setTestResult(null);
    test.mutate(
      { ...(isEdit ? { id } : {}), body: { kind, url, ...(apiKey ? { apiKey } : {}) } },
      {
        onSuccess: (res) => {
          setTestResult(res);
          if (res.indexers?.length) setIndexers(res.indexers);
        },
      },
    );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    const body: TorrentSourceWriteDto = {
      ...(isEdit ? {} : { kind }),
      name,
      url,
      ...(apiKey ? { apiKey } : {}),
      ...(kind !== 'torznab' ? { indexers } : {}),
    };
    save.mutate(
      { ...(isEdit ? { id } : {}), body },
      {
        onSuccess: () => navigate('/settings/torrent-sources'),
        onError: (err) => {
          if (err instanceof ApiError && err.fields) {
            setErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k.replace(/^config\./, ''), v])));
            setFormError('Please fix the highlighted fields.');
          } else setFormError(errorMessage(err));
        },
      },
    );
  };

  return (
    <Page title={isEdit ? `Edit ${name || 'torrent source'}` : 'Add torrent source'}>
      {!isEdit && (
        <fieldset className="field">
          <legend>Connection type</legend>
          {(['prowlarr', 'jackett', 'torznab'] as const).map((k) => (
            <label key={k} className="checkbox">
              <input type="radio" name="kind" checked={kind === k} onChange={() => pickKind(k)} />
              <span>
                {KIND_LABEL[k]} <span className="small muted">— {KIND_DESC[k]}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <form className="card stack" onSubmit={submit} noValidate>
        {formError && (
          <p className="banner error" role="alert">
            {formError}
          </p>
        )}

        {isEdit && (
          <p className="badge" style={{ justifySelf: 'start' }}>
            {KIND_LABEL[kind]}
          </p>
        )}

        <TextInput id="tor-name" label="Name" value={name} onChange={setName} error={errors.name} placeholder={KIND_LABEL[kind]} />
        <TextInput
          id="tor-url"
          label={kind === 'torznab' ? 'Endpoint URL' : 'Server URL'}
          value={url}
          onChange={setUrl}
          error={errors.url}
          placeholder={kind === 'torznab' ? 'https://indexer.example/api' : KIND_DEFAULT_URL[kind]}
          help={kind === 'torznab' ? 'The Torznab API endpoint, usually ending in /api.' : undefined}
        />
        <TextInput
          id="tor-key"
          label="API key"
          type="password"
          value={apiKey}
          onChange={setApiKey}
          error={errors.apiKey}
          autoComplete="new-password"
          placeholder={isEdit ? 'Leave blank to keep the stored key' : ''}
          help={isEdit ? 'Stored encrypted on the server; never shown again.' : undefined}
        />

        {testResult?.ok && kind !== 'torznab' && indexers.length > 0 && (
          <fieldset className="field">
            <legend>
              Indexers ({indexers.filter((i) => i.enabled).length} of {indexers.length} enabled)
            </legend>
            {indexers.map((idx) => (
              <label key={idx.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={idx.enabled}
                  onChange={(e) => setIndexers((s) => s.map((i) => (i.id === idx.id ? { ...i, enabled: e.target.checked } : i)))}
                />
                <span className="truncate">{idx.name}</span>
              </label>
            ))}
          </fieldset>
        )}

        {testResult && (
          <p className={`banner ${testResult.ok ? 'ok' : 'error'}`} role="status">
            <Icon name={testResult.ok ? 'check' : 'alert'} size={18} /> {testResult.message}
          </p>
        )}
        {test.error && (
          <p className="banner error" role="alert">
            {errorMessage(test.error)}
          </p>
        )}

        <div className="row wrap">
          <button type="submit" className="btn primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add source'}
          </button>
          <button type="button" className="btn" onClick={runTest} disabled={test.isPending}>
            {test.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <Link to="/settings/torrent-sources" className="btn ghost">
            Cancel
          </Link>
        </div>
      </form>
    </Page>
  );
}

function TextInput({
  id,
  label,
  value,
  onChange,
  error,
  help,
  type = 'text',
  placeholder,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  help?: string | undefined;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoCapitalize="off"
        spellCheck={false}
      />
      {help && (
        <p id={`${id}-help`} className="help">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}

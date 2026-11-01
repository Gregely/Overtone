import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ConfigField, ConnectionTestResultDto, ProviderManifestDto, SourceDto, SourceWriteDto, StreamMode } from '@overtone/shared';
import { ApiError } from '../api/client';
import { useDeleteSource, useProviders, useSaveSource, useScan, useScanStatus, useSource, useSources, useTestSource } from '../api/hooks';
import { useIsAdmin } from '../app/context';
import { Page } from '../layout/Page';
import { Dialog } from '../ui/Dialog';
import { plural, relativeTime } from '../ui/format';
import { Icon } from '../ui/Icon';
import { EmptyState, errorMessage, QueryView, Spinner } from '../ui/states';

const CATEGORY: Record<ProviderManifestDto['category'], string> = {
  local: 'On this server',
  server: 'Music servers',
  public: 'Public archives',
  debrid: 'Debrid accounts',
};

function AdminOnly({ children }: { children: React.ReactNode }) {
  const admin = useIsAdmin();
  if (!admin) return <Page title="Sources"><p>Only admins can manage sources.</p></Page>;
  return <>{children}</>;
}

export function SourcesView() {
  return (
    <AdminOnly>
      <SourcesList />
    </AdminOnly>
  );
}

function SourcesList() {
  const sources = useSources();
  const providers = useProviders();
  const scan = useScan();
  const status = useScanStatus();
  const providerName = (id: string) => providers.data?.find((p) => p.id === id)?.name ?? id;
  return (
    <Page
      title="Sources"
      actions={
        <div className="row">
          <button type="button" className="btn" onClick={() => scan.mutate(undefined)} disabled={scan.isPending}>
            <Icon name="refresh" size={18} /> Scan all
          </button>
          <Link to="/settings/sources/new" className="btn primary">
            <Icon name="plus" size={18} /> Add source
          </Link>
        </div>
      }
    >
      <QueryView query={sources} label="Loading sources">
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No sources yet" icon="library">
              <p>Add a folder, server or account to start building your library.</p>
            </EmptyState>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Sources">
              {list.map((s) => (
                <SourceCard
                  key={s.id}
                  source={s}
                  providerName={providerName(s.providerId)}
                  scanning={status.data?.running?.sourceId === s.id || Boolean(status.data?.queued.includes(s.id))}
                />
              ))}
            </ul>
          )
        }
      </QueryView>
    </Page>
  );
}

function SourceCard({ source: s, providerName, scanning }: { source: SourceDto; providerName: string; scanning: boolean }) {
  const scan = useScan();
  const test = useTestSource();
  const del = useDeleteSource();
  const [confirm, setConfirm] = useState(false);
  const headingId = `src-${s.id}`;
  return (
    <li className="card stack-sm" aria-labelledby={headingId}>
      <div className="row wrap">
        <h2 id={headingId}>{s.name}</h2>
        <span className="badge">{providerName}</span>
        {!s.enabled && <span className="badge warn">Disabled</span>}
        {s.streamMode === 'redirect' && <span className="badge">Direct streaming</span>}
      </div>
      <p className="small muted">
        {plural(s.fileCount, 'file')} · last scan {relativeTime(s.lastScanAt)}
        {scanning ? ' · scanning now…' : ''}
      </p>
      {s.lastError && (
        <p className="banner" role="status">
          <Icon name="alert" size={18} /> {s.lastError}
        </p>
      )}
      {test.data && <TestResult result={test.data} />}
      {test.error && (
        <p className="banner error" role="alert">
          {errorMessage(test.error)}
        </p>
      )}
      <div className="row wrap">
        <button type="button" className="btn small" onClick={() => scan.mutate(s.id)} disabled={scanning || scan.isPending || !s.enabled}>
          <Icon name="refresh" size={16} /> Scan now
        </button>
        <button type="button" className="btn small" onClick={() => test.mutate({ id: s.id, providerId: s.providerId, config: {} })} disabled={test.isPending}>
          {test.isPending ? 'Testing…' : 'Test connection'}
        </button>
        <Link to={`/settings/sources/${s.id}`} className="btn small" aria-label={`Edit ${s.name}`}>
          <Icon name="edit" size={16} /> Edit
        </Link>
        <button type="button" className="btn small danger" onClick={() => setConfirm(true)} aria-label={`Delete ${s.name}`}>
          <Icon name="trash" size={16} /> Delete
        </button>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Delete “${s.name}”?`}>
        <p>Its {plural(s.fileCount, 'file')} will disappear from your library. Your actual files and accounts are not touched.</p>
        {del.error && <p className="banner error" role="alert">{errorMessage(del.error)}</p>}
        <div className="row">
          <button type="button" className="btn danger" disabled={del.isPending} onClick={() => del.mutate(s.id, { onSuccess: () => setConfirm(false) })}>
            Delete source
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </li>
  );
}

function TestResult({ result }: { result: ConnectionTestResultDto }) {
  return (
    <div className={`banner ${result.ok ? 'ok' : 'error'}`} role="status">
      <Icon name={result.ok ? 'check' : 'alert'} size={18} />
      <span>
        {result.message}
        {result.details && Object.keys(result.details).length > 0 && (
          <span className="small"> ({Object.entries(result.details).map(([k, v]) => `${k}: ${v}`).join(', ')})</span>
        )}
      </span>
    </div>
  );
}

// ── Add / edit ─────────────────────────────────────────────────────────────

export function SourceEditView() {
  return (
    <AdminOnly>
      <SourceEdit />
    </AdminOnly>
  );
}

function SourceEdit() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const providers = useProviders();
  const source = useSource(id);
  if (providers.isPending || (id && source.isPending)) return <Spinner />;
  if (providers.error) return <QueryView query={providers}>{() => null}</QueryView>;
  if (id && source.error) return <QueryView query={source}>{() => null}</QueryView>;
  const providerId = source.data?.providerId ?? params.get('provider');
  const provider = providers.data!.find((p) => p.id === providerId);
  if (!provider) return <ProviderPicker providers={providers.data!} />;
  return <SourceForm provider={provider} source={source.data} />;
}

function ProviderPicker({ providers }: { providers: ProviderManifestDto[] }) {
  const groups = (Object.keys(CATEGORY) as Array<ProviderManifestDto['category']>)
    .map((c) => [c, providers.filter((p) => p.category === c)] as const)
    .filter(([, ps]) => ps.length);
  return (
    <Page title="Add a source">
      <p className="muted">Overtone only plays what's already in a source. It never searches for or downloads new content.</p>
      {groups.map(([cat, ps]) => (
        <section key={cat} aria-labelledby={`cat-${cat}`} className="stack-sm">
          <h2 id={`cat-${cat}`}>{CATEGORY[cat]}</h2>
          <ul className="sheet-actions card" style={{ padding: 6 }}>
            {ps.map((p) => (
              <li key={p.id}>
                <Link to={`/settings/sources/new?provider=${p.id}`}>
                  <span style={{ display: 'grid' }}>
                    <strong>{p.name}</strong>
                    <span className="small muted">{p.description}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Page>
  );
}

type FormValues = Record<string, string | boolean>;

function initialValues(fields: readonly ConfigField[], source?: SourceDto): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    if (f.type === 'secret') continue;
    const v = source?.config.values[f.key] ?? ('default' in f ? f.default : undefined);
    out[f.key] = f.type === 'boolean' ? Boolean(v) : v === undefined ? '' : String(v);
  }
  return out;
}

/** Turn form state into the API's config object, applying secret keep/clear semantics. */
export function buildConfig(
  fields: readonly ConfigField[],
  values: FormValues,
  secrets: Record<string, string>,
  clear: Record<string, boolean>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.hidden) continue;
    if (f.type === 'secret') {
      if (clear[f.key]) config[f.key] = null; // remove the stored value
      else if (secrets[f.key]) config[f.key] = secrets[f.key]; // replace it
      // otherwise omit: keep whatever is stored
      continue;
    }
    const v = values[f.key];
    if (f.type === 'boolean') config[f.key] = Boolean(v);
    else if (f.type === 'number') config[f.key] = v === '' ? '' : Number(v);
    else config[f.key] = v ?? '';
  }
  return config;
}

function SourceForm({ provider, source }: { provider: ProviderManifestDto; source?: SourceDto | undefined }) {
  const navigate = useNavigate();
  const save = useSaveSource();
  const test = useTestSource();
  const fields = useMemo(() => provider.configSchema.fields.filter((f) => !f.hidden), [provider]);
  const [name, setName] = useState(source?.name ?? provider.name);
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [streamMode, setStreamMode] = useState<StreamMode>(source?.streamMode ?? 'proxy');
  const [priority, setPriority] = useState(String(source?.priority ?? ''));
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, source));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const saved = new Set(source?.config.secretsSet ?? []);

  const config = () => buildConfig(fields, values, secrets, clear);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    const body: SourceWriteDto = { name, enabled, streamMode, config: config() };
    if (priority !== '') body.priority = Number(priority);
    if (!source) body.providerId = provider.id;
    save.mutate(
      { ...(source ? { id: source.id } : {}), body },
      {
        onSuccess: () => navigate('/settings/sources'),
        onError: (err) => {
          if (err instanceof ApiError && err.fields) {
            setErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k.replace(/^config\./, ''), v])));
            setFormError('Please fix the highlighted fields.');
          } else setFormError(errorMessage(err));
        },
      },
    );
  };

  const runTest = () => {
    test.reset();
    test.mutate({ ...(source ? { id: source.id } : {}), providerId: provider.id, config: config() });
  };

  return (
    <Page title={source ? `Edit ${source.name}` : `Add ${provider.name}`}>
      <p className="muted">{provider.description}</p>
      <form className="card stack" onSubmit={submit} noValidate>
        {formError && (
          <p className="banner error" role="alert">
            {formError}
          </p>
        )}
        <TextInput id="src-name" label="Name" value={name} onChange={setName} error={errors.name} required />

        {fields.map((f) => (
          <SchemaField
            key={f.key}
            field={f}
            value={values[f.key]}
            onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
            secret={secrets[f.key] ?? ''}
            onSecret={(v) => setSecrets((s) => ({ ...s, [f.key]: v }))}
            isSaved={saved.has(f.key)}
            clearing={Boolean(clear[f.key])}
            onClear={(c) => setClear((s) => ({ ...s, [f.key]: c }))}
            error={errors[f.key]}
          />
        ))}

        {provider.capabilities.redirectable && (
          <fieldset className="field">
            <legend>Streaming</legend>
            <label className="checkbox">
              <input type="radio" name="streamMode" checked={streamMode === 'proxy'} onChange={() => setStreamMode('proxy')} />
              Through this server (recommended)
            </label>
            <label className="checkbox">
              <input type="radio" name="streamMode" checked={streamMode === 'redirect'} onChange={() => setStreamMode('redirect')} />
              Directly from the source when the link carries no credentials
            </label>
            <p className="help">Direct streaming saves server bandwidth. Links containing keys are always proxied.</p>
            {errors.streamMode && <p className="error-text">{errors.streamMode}</p>}
          </fieldset>
        )}

        <details>
          <summary style={{ cursor: 'pointer', minHeight: 'var(--tap)', display: 'flex', alignItems: 'center' }}>Advanced</summary>
          <div className="stack-sm" style={{ paddingTop: 8 }}>
            <label className="checkbox">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
            </label>
            <TextInput
              id="src-priority"
              label="Priority"
              type="number"
              value={priority}
              onChange={setPriority}
              help="When a track is in several sources, the lowest number plays first. Leave blank for the default."
              error={errors.priority}
            />
          </div>
        </details>

        {test.data && <TestResult result={test.data} />}
        {test.error && (
          <p className="banner error" role="alert">
            {test.error instanceof ApiError && test.error.fields ? 'Fill in the required fields first.' : errorMessage(test.error)}
          </p>
        )}

        <div className="row wrap">
          <button type="submit" className="btn primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : source ? 'Save changes' : 'Add source'}
          </button>
          <button type="button" className="btn" onClick={runTest} disabled={test.isPending}>
            {test.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <Link to="/settings/sources" className="btn ghost">
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
  required,
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
  required?: boolean | undefined;
  placeholder?: string | undefined;
  autoComplete?: string;
}) {
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        className="input"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        aria-required={required || undefined}
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

/** Renders one configSchema field. Secret values are write-only: never prefilled, never shown. */
function SchemaField(props: {
  field: ConfigField;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
  secret: string;
  onSecret: (v: string) => void;
  isSaved: boolean;
  clearing: boolean;
  onClear: (c: boolean) => void;
  error?: string | undefined;
}) {
  const { field: f, error } = props;
  const id = `cfg-${f.key}`;
  switch (f.type) {
    case 'boolean':
      return (
        <div className="field">
          <label className="checkbox">
            <input type="checkbox" checked={Boolean(props.value)} onChange={(e) => props.onChange(e.target.checked)} aria-describedby={f.help ? `${id}-help` : undefined} />
            {f.label}
          </label>
          {f.help && (
            <p id={`${id}-help`} className="help">
              {f.help}
            </p>
          )}
          {error && <p className="error-text">{error}</p>}
        </div>
      );
    case 'select':
      return (
        <div className="field">
          <label htmlFor={id}>{f.label}</label>
          <select id={id} className="input" value={String(props.value ?? '')} onChange={(e) => props.onChange(e.target.value)} aria-invalid={error ? true : undefined}>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {f.help && <p className="help">{f.help}</p>}
          {error && <p className="error-text">{error}</p>}
        </div>
      );
    case 'secret':
      return (
        <div className="stack-sm">
          <TextInput
            id={id}
            label={f.label}
            type="password"
            autoComplete="new-password"
            value={props.secret}
            onChange={props.onSecret}
            required={f.required && !props.isSaved}
            placeholder={props.isSaved ? (props.clearing ? 'Will be removed' : 'Saved. Leave blank to keep') : (f.placeholder ?? '')}
            help={f.help ?? (props.isSaved ? 'Stored encrypted on the server; it is never shown again.' : undefined)}
            error={error}
          />
          {props.isSaved && !f.required && (
            <label className="checkbox small">
              <input type="checkbox" checked={props.clearing} onChange={(e) => props.onClear(e.target.checked)} /> Remove saved {f.label.toLowerCase()}
            </label>
          )}
        </div>
      );
    default:
      return (
        <TextInput
          id={id}
          label={f.label}
          type={f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}
          value={String(props.value ?? '')}
          onChange={props.onChange}
          required={f.required}
          placeholder={'placeholder' in f ? f.placeholder : undefined}
          help={f.help}
          error={error}
        />
      );
  }
}

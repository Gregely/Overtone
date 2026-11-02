import { useEffect, useState } from 'react';
import { DEFAULT_DISCOVERY_PREFERENCES, type DiscoveryPreferencesDto } from '@overtone/shared';
import { useDebridProviders, usePreferences, useSavePreferences } from '../api/hooks';
import { Icon } from '../ui/Icon';
import { errorMessage } from '../ui/states';

/** Settings › Find sources: discovery and retrieval preferences (admin only). */
export function DiscoverySettings() {
  const prefs = usePreferences();
  const save = useSavePreferences();
  const providers = useDebridProviders();
  const [form, setForm] = useState<DiscoveryPreferencesDto>({ ...DEFAULT_DISCOVERY_PREFERENCES });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (prefs.data) setForm(prefs.data);
  }, [prefs.data]);

  const update = (patch: Partial<DiscoveryPreferencesDto>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
  };

  const submit = () => save.mutate(form, { onSuccess: () => setSaved(true) });
  const reset = () => {
    setForm({ ...DEFAULT_DISCOVERY_PREFERENCES });
    setSaved(false);
    save.mutate({ ...DEFAULT_DISCOVERY_PREFERENCES }, { onSuccess: () => setSaved(true) });
  };

  const retrieval = (providers.data ?? []).filter((p) => p.retrieval);
  const unsupported = (providers.data ?? []).filter((p) => !p.retrieval);

  return (
    <section className="card stack-sm" aria-labelledby="set-discovery">
      <h2 id="set-discovery">Find sources</h2>
      <p className="muted small">Preferences for discovering releases and retrieving them through a debrid provider.</p>

      <fieldset className="field">
        <legend>Audio</legend>
        <div className="field">
          <label htmlFor="pref-format">Preferred format</label>
          <select id="pref-format" className="input" value={form.preferredFormat} onChange={(e) => update({ preferredFormat: e.target.value as DiscoveryPreferencesDto['preferredFormat'] })}>
            <option value="any">No preference</option>
            <option value="flac">FLAC</option>
            <option value="mp3">MP3</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="pref-bitrate">Minimum bitrate (kbps)</label>
          <input
            id="pref-bitrate"
            className="input"
            type="number"
            min={0}
            max={1000}
            value={form.minBitrateKbps ?? ''}
            onChange={(e) => update({ minBitrateKbps: e.target.value === '' ? null : Number(e.target.value) })}
            placeholder="No minimum"
          />
          <p className="help">Applies to lossy formats such as MP3. FLAC is always preferred over lossy at any bitrate.</p>
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>Debrid provider</legend>
        <div className="field">
          <label htmlFor="pref-provider">Preferred provider</label>
          <select id="pref-provider" className="input" value={form.preferredProvider} onChange={(e) => update({ preferredProvider: e.target.value })}>
            <option value="auto">Automatic</option>
            {retrieval.map((p) => (
              <option key={p.sourceId} value={p.sourceId}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {unsupported.length > 0 && <p className="small muted">{unsupported.map((p) => p.name).join(' · ')} · Coming soon</p>}
        <label className="checkbox">
          <input type="checkbox" checked={form.rememberLastProvider} onChange={(e) => update({ rememberLastProvider: e.target.checked })} /> Remember the last provider used
        </label>
      </fieldset>

      <fieldset className="field">
        <legend>Discovery</legend>
        <label className="checkbox">
          <input type="checkbox" checked={form.prioritizeCached} onChange={(e) => update({ prioritizeCached: e.target.checked })} /> Prioritise cached releases
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.hideUncached} onChange={(e) => update({ hideUncached: e.target.checked })} /> Hide uncached releases
        </label>
        <div className="field">
          <label htmlFor="pref-scope">Default search scope</label>
          <select id="pref-scope" className="input" value={form.searchScope} onChange={(e) => update({ searchScope: e.target.value as DiscoveryPreferencesDto['searchScope'] })}>
            <option value="auto">Automatic</option>
            <option value="track">Individual track</option>
            <option value="album">Complete album</option>
          </select>
        </div>
      </fieldset>

      {save.error && (
        <p className="banner error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}
      {saved && (
        <p className="banner ok" role="status">
          Preferences saved.
        </p>
      )}

      <div className="row wrap">
        <button type="button" className="btn primary" onClick={submit} disabled={save.isPending}>
          <Icon name="check" size={18} /> {save.isPending ? 'Saving…' : 'Save preferences'}
        </button>
        <button type="button" className="btn ghost" onClick={reset}>
          Restore defaults
        </button>
      </div>
    </section>
  );
}

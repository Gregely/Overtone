/**
 * TorBox import diagnostics: shows, stage by stage, where files from a TorBox
 * account stop on their way into the library.
 *
 *   docker compose exec overtone node apps/server/dist/tools/diagnose-torbox.js
 *   npm run diagnose:torbox                       (from a source checkout)
 *
 * Uses the TorBox source(s) already configured in Overtone (the key is read
 * from the encrypted secret store and never printed), or TORBOX_API_KEY when
 * set. Read-only: the real database is opened read-only and the test import
 * runs in a throwaway in-memory database. Output contains file and folder
 * names from your account; it never contains the API key.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCore,
  createDatabase,
  MemoryBlobStore,
  MemorySecretStore,
  syncHandleDriver,
  type Database as CoreDatabase,
  type Logger,
  type SecretStore,
} from '@overtone/core';
import { fileExtension, isAudioFile } from '@overtone/shared';
import Database from 'better-sqlite3';
import { parseSecretKey } from '../config.js';
import { deriveKey } from '../crypto/keys.js';
import { SecretBox } from '../crypto/secret-box.js';
import { openDatabase, coreDatabase } from '../db/index.js';
import { EncryptedColumnSecretStore } from '../platform.js';

const API = 'https://api.torbox.app/v1/api';
const KINDS = ['torrents', 'usenet', 'webdl'] as const;
const PAGE = 1000;

export interface DiagnoseOptions {
  /** The real database (opened read-only by the CLI). Null when there is none. */
  database: CoreDatabase | null;
  secrets: SecretStore | null;
  /** Used instead of stored keys when set. */
  apiKey?: string | undefined;
  fetch?: typeof fetch;
  apiBase?: string;
  print: (line: string) => void;
  timeoutMs?: number;
}

interface SourceRow {
  id: string;
  name: string;
  enabled: number;
  last_scan_at: number | null;
  last_error: string | null;
}

interface RawItem {
  id?: unknown;
  name?: unknown;
  download_state?: unknown;
  download_finished?: unknown;
  download_present?: unknown;
  files?: unknown;
}

export async function diagnoseTorBox(o: DiagnoseOptions): Promise<void> {
  const keys = new Set<string>();
  const print = (line: string) => {
    let out = line;
    for (const k of keys) if (k.length >= 4) out = out.split(k).join('[api key]');
    o.print(out);
  };
  const doFetch = o.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const apiBase = o.apiBase ?? API;
  const timeoutMs = o.timeoutMs ?? 90_000;

  print('Overtone TorBox diagnostics (read-only; your library is not changed)');

  // ── 1. What Overtone has stored ────────────────────────────────────────────
  section(print, '1. TorBox sources configured in Overtone');
  let apiKey = o.apiKey?.trim() || undefined;
  if (apiKey) keys.add(apiKey);
  if (!o.database) {
    print('No Overtone database found (check OVERTONE_DATA_DIR).');
  } else {
    const rows = await o.database.all<SourceRow>(`SELECT id, name, enabled, last_scan_at, last_error FROM sources WHERE provider_id = 'torbox' ORDER BY created_at`);
    if (!rows.length) print('No TorBox source is configured. Add one in Settings › Sources.');
    for (const s of rows) {
      const one = async (sql: string) => (await o.database!.get<{ n: number }>(sql, [s.id]))!.n;
      const files = await one('SELECT COUNT(*) AS n FROM source_files WHERE source_id = ?');
      const untagged = await one(`SELECT COUNT(*) AS n FROM source_files WHERE source_id = ? AND tags_status = 'pending'`);
      const noTrack = await one('SELECT COUNT(*) AS n FROM source_files WHERE source_id = ? AND track_id IS NULL');
      const tracks = await one('SELECT COUNT(DISTINCT t.id) AS n FROM available_tracks t JOIN source_files sf ON sf.track_id = t.id WHERE sf.source_id = ?');
      print(`- "${s.name}" (id ${s.id}): ${s.enabled ? 'enabled' : 'DISABLED (its files are hidden from the library)'}`);
      print(`  last scan: ${s.last_scan_at ? new Date(s.last_scan_at).toISOString() : 'never'}${s.last_error ? ` — error: ${s.last_error}` : ''}`);
      print(`  stored files: ${files} (waiting for tags: ${untagged}, without a track: ${noTrack}); tracks shown in the library: ${tracks}`);
      if (!apiKey && o.secrets) {
        try {
          const secrets = await o.secrets.get(s.id);
          for (const v of Object.values(secrets)) keys.add(v);
          if (secrets.apiKey) apiKey = secrets.apiKey;
          else print('  this source has no stored API key / login');
        } catch (err) {
          print(`  could not decrypt this source's key (${(err as Error).message}). Is OVERTONE_SECRET_KEY the same as the server's?`);
        }
      }
    }
  }
  if (!apiKey) {
    print('');
    print('No TorBox key available. Set TORBOX_API_KEY, or run this where Overtone runs (same data dir and OVERTONE_SECRET_KEY).');
    return;
  }
  const auth = { authorization: `Bearer ${apiKey}`, 'user-agent': 'Overtone-diagnostics' };

  const get = async (url: string) => {
    const started = Date.now();
    try {
      const res = await doFetch(url, { headers: auth, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      const body = parseJson(text);
      return { status: res.status, ms: Date.now() - started, bytes: text.length, body, text };
    } catch (err) {
      return { status: 0, ms: Date.now() - started, bytes: 0, body: null, text: '', error: `${(err as Error).name}: ${(err as Error).message}` };
    }
  };

  // ── 2. Account ─────────────────────────────────────────────────────────────
  section(print, '2. Account (what "Test connection" checks)');
  const me = await get(`${apiBase}/user/me`);
  print(describeCall(me));
  const meData = me.body?.data as { email?: string; plan?: number; premium_expires_at?: string } | null | undefined;
  if (meData) print(`account: ${meData.email ?? '?'}, plan ${meData.plan ?? '?'}, premium until ${meData.premium_expires_at ?? '?'}`);

  // ── 3. Raw TorBox lists ────────────────────────────────────────────────────
  section(print, '3. What TorBox returns (raw)');
  let rawAudio = 0;
  for (const kind of KINDS) {
    const items: RawItem[] = [];
    for (let offset = 0, page = 0; page < 50; offset += PAGE, page++) {
      const r = await get(`${apiBase}/${kind}/mylist?bypass_cache=true&offset=${offset}&limit=${PAGE}`);
      print(`${kind} page ${page + 1}: ${describeCall(r)}`);
      const data = r.body?.data;
      if (!Array.isArray(data)) {
        if (data !== null && data !== undefined) print(`  ! data is ${typeof data}, expected a list`);
        break;
      }
      items.push(...(data as RawItem[]));
      if (data.length < PAGE) break;
    }
    const states = count(items.map((i) => `state=${String(i.download_state)} finished=${String(i.download_finished)} present=${String(i.download_present)}`));
    const files = items.flatMap((i) => (Array.isArray(i.files) ? (i.files as Array<{ name?: unknown; short_name?: unknown }>) : []));
    const fileNames = files.map((f) => String(f.short_name || f.name || ''));
    const audio = fileNames.filter((n) => isAudioFile(n)).length;
    rawAudio += audio;
    print(`  ${items.length} ${kind}, ${files.length} files, ${audio} audio by extension`);
    for (const [k, n] of Object.entries(states)) print(`    ${n} × ${k}`);
    if (files.length) print(`    extensions: ${fmtCounts(count(fileNames.map((n) => fileExtension(n) || '(none)')), 12)}`);
    const withoutFiles = items.filter((i) => !Array.isArray(i.files) || !(i.files as unknown[]).length).length;
    if (withoutFiles) print(`    ! ${withoutFiles} item(s) have no file list`);
    for (const i of items.slice(0, 5)) {
      const fl = Array.isArray(i.files) ? (i.files as Array<{ id?: unknown; name?: unknown; short_name?: unknown }>) : [];
      print(`    • ${String(i.name)} [state=${String(i.download_state)}, finished=${String(i.download_finished)}, present=${String(i.download_present)}, ${fl.length} files]`);
      for (const f of fl.slice(0, 3)) print(`        file id=${JSON.stringify(f.id)} name=${JSON.stringify(f.name)} short_name=${JSON.stringify(f.short_name)}`);
    }
  }

  // ── 4. Overtone's own pipeline, into a throwaway database ──────────────────
  section(print, '4. Test import with Overtone\'s TorBox code (in-memory, nothing saved)');
  const logs: Array<{ level: string; msg: string; data: object }> = [];
  const capture = (level: string): Logger['info'] => (obj, msg) => void logs.push({ level, msg: msg ?? '', data: obj });
  const logger: Logger = { debug: () => undefined, info: capture('info'), warn: capture('warn'), error: capture('error'), child: () => logger };
  const mem = coreDatabase(openDatabase(':memory:'));
  const core = createCore({
    db: mem,
    secrets: new MemorySecretStore(),
    blobs: new MemoryBlobStore(),
    version: 'diagnostics',
    contact: 'https://github.com/gregely/overtone',
    logger,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    builtins: {},
  });
  try {
    const src = await core.api.createSource({ providerId: 'torbox', name: 'TorBox (diagnostics)', config: { apiKey, probeTags: false } }, 1);
    const report = await core.scanner.scanSource(src.id);
    print(`scan: listed ${report.added + report.changed + report.unchanged} audio files, error: ${report.error ?? 'none'}`);
    for (const l of logs) {
      if (/torbox listing|debrid listing|scan failed|tagging/.test(l.msg)) print(`  [${l.level}] ${l.msg} ${JSON.stringify(stripIds(l.data))}`);
    }
    const tracks = await core.api.tracks({ limit: 10, sort: 'recent' }, { coverUrl: () => null, categoryOf: () => 'debrid' });
    print(`library would show ${tracks.total} tracks${tracks.total ? ', e.g.:' : ''}`);
    for (const t of tracks.items) print(`  • ${t.artistCredit} — ${t.title}${t.album ? ` (${t.album.title})` : ''}`);
    const first = tracks.items[0];
    if (first) {
      const s = await core.api.search(first.title, { coverUrl: () => null, categoryOf: () => 'debrid' });
      print(`search "${first.title}": ${s.tracks.length} track(s) found`);
    }
  } finally {
    await core.close().catch(() => undefined);
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  section(print, 'Summary');
  if (me.status !== 200) print('- TorBox rejected or failed the account check: fix the key / login first.');
  else if (rawAudio === 0) print('- TorBox returned no audio files (by extension) in any list. Overtone only imports audio.');
  else print(`- TorBox returned ${rawAudio} audio file(s). Compare with the test import above and the stored counts in section 1.`);
  print('Paste this output (it contains file names, not your key) when reporting the problem.');
}

type Envelope = { success?: unknown; error?: unknown; detail?: unknown; data?: unknown };

function parseJson(text: string): Envelope | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Envelope) : null;
  } catch {
    return null;
  }
}

function section(print: (l: string) => void, title: string): void {
  print('');
  print(`── ${title} ${'─'.repeat(Math.max(3, 70 - title.length))}`);
}

function describeCall(r: { status: number; ms: number; bytes: number; body: Envelope | null; text: string; error?: string }): string {
  if (r.error) return `request failed after ${r.ms} ms: ${r.error}`;
  const b = r.body;
  if (!b) return `HTTP ${r.status}, ${r.ms} ms, not JSON: ${JSON.stringify(r.text.slice(0, 200))}`;
  const data = Array.isArray(b.data) ? `list of ${b.data.length}` : b.data === null ? 'null' : typeof b.data;
  return `HTTP ${r.status}, ${r.ms} ms, ${r.bytes} bytes, success=${String(b.success)}, error=${String(b.error)}, detail=${JSON.stringify(b.detail)}, data=${data}`;
}

function count(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function fmtCounts(c: Record<string, number>, n: number): string {
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

function stripIds(o: object): object {
  const { sourceId: _s, provider: _p, ...rest } = o as Record<string, unknown>;
  return rest;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dataDir = path.resolve(process.env.OVERTONE_DATA_DIR || './data');
  const file = path.join(dataDir, 'overtone.db');
  let database: CoreDatabase | null = null;
  let secrets: SecretStore | null = null;
  if (existsSync(file)) {
    const handle = new Database(file, { readonly: true, fileMustExist: true });
    database = createDatabase(syncHandleDriver(handle as never));
    try {
      secrets = new EncryptedColumnSecretStore(database, new SecretBox(deriveKey(parseSecretKey(process.env), 'secrets')));
    } catch (err) {
      console.log(`(cannot read stored keys: ${(err as Error).message})`);
    }
  }
  await diagnoseTorBox({ database, secrets, apiKey: process.env.TORBOX_API_KEY, print: (l) => console.log(l) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

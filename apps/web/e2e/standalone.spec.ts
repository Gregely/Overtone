/**
 * Standalone mode in a plain browser: @overtone/core runs in the page with
 * sql.js (SQLite in WebAssembly) and talks to the (fake) sources directly.
 * The Overtone server only serves the static app here; the test asserts the
 * app never calls its API.
 *
 * The Android-specific parts (Capacitor SQLite, Keystore, native HTTP, the
 * "This device" folder picker, the foreground service) can't run in a
 * browser; see docs/android.md for the on-device checklist.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function expectAccessible(page: Page, label: string) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    return axe.run(document, { resultTypes: ['violations'] });
  });
  const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${label}`).toEqual([]);
}

/** The library database bytes, as sql.js saved them to IndexedDB. */
async function savedDatabase(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('overtone-library', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('kv').objectStore('kv').get('db');
          get.onsuccess = () => resolve(new TextDecoder('latin1').decode(get.result as Uint8Array));
          get.onerror = () => reject(get.error);
        };
      }),
  );
}

test('standalone: no server and no login; add a source, scan, play directly, settings, persist, reset', async ({ page, baseURL }) => {
  const port = Number(new URL(baseURL!).port);
  const fakes = `http://127.0.0.1:${port + 1}`;
  await page.addInitScript((f) => {
    // Developer switch that offers standalone mode in a browser, pointed at fake MusicBrainz / Cover Art Archive.
    if (!localStorage.getItem('overtone.dev.standalone')) {
      localStorage.setItem('overtone.dev.standalone', JSON.stringify({ musicbrainzUrl: `${f}/ws/2`, coverArtUrl: f }));
    }
  }, fakes);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text());
  });
  const serverApiCalls: string[] = [];
  const streamRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/stream.view')) streamRequests.push(r.url());
    const u = new URL(r.url());
    if (Number(u.port) === port && u.pathname.startsWith('/api/')) serverApiCalls.push(u.pathname);
  });

  // First launch: choose where the library lives.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'How do you want to use Overtone?' })).toBeVisible();
  await expectAccessible(page, 'mode chooser');
  await page.getByRole('button', { name: /Use on this device/ }).click();

  // Guided "Add your first source", in plain language.
  await expect(page.getByRole('heading', { name: 'Add your first source', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /Internet Archive.*public-domain/ })).toBeVisible();
  await expectAccessible(page, 'first source guide');

  // Redirect/proxy settings don't apply on the device: hidden even for a redirectable provider.
  await page.getByRole('link', { name: /Internet Archive/ }).click();
  await expect(page.getByRole('heading', { name: 'Add Internet Archive' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Streaming' })).toHaveCount(0);
  await page.goBack();

  await page.getByRole('link', { name: /Your own music server/ }).click();
  await page.getByLabel(/Server URL/).fill(`${fakes}/subsonic`);
  await page.getByLabel('Username').fill('e2e');
  await page.getByLabel('Password', { exact: true }).fill('e2e-pass');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected to fakesonic 1.0 (API 1.16.1, OpenSubsonic).' })).toBeVisible();
  await page.getByRole('button', { name: 'Add source' }).click();
  await expect(page.getByRole('heading', { name: 'Sources', level: 1 })).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Subsonic / Navidrome' })).toBeVisible();

  // Scanned on the device (tags from the listing; MusicBrainz knows nothing, so they stay tag-matched).
  // Navigate inside the app: a page load would restart the in-page library (and its scan).
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Library' }).click();
  await page.getByRole('link', { name: 'Tracks' }).click();
  await expect(page.getByRole('list', { name: 'Tracks' }).getByText('Server Song One'), errors.join('\n')).toBeVisible({ timeout: 30_000 });

  // Plays straight from the source: no Overtone stream proxy.
  await page.getByRole('button', { name: /^Play Server Song One by/ }).click();
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState), { timeout: 15_000 }).toBe('playing');
  expect(streamRequests.some((u) => u.startsWith(`${fakes}/subsonic/rest/stream.view?`))).toBe(true);
  expect(serverApiCalls.filter((p) => p.startsWith('/api/stream'))).toEqual([]);
  await page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Pause' }).click();

  // The library is saved to IndexedDB (within ~250 ms of a change), and the
  // password isn't in it: it's in the encrypted secret store.
  await expect.poll(() => savedDatabase(page).then((db) => db.includes('Server Song One')), { timeout: 5_000 }).toBe(true);
  expect(await savedDatabase(page)).not.toContain('e2e-pass');

  // Settings (a fresh page load): mode, library facts; no server or account sections.
  await page.goto('/settings');
  await expect(page.getByRole('region', { name: 'Mode' }).getByText('On this device.')).toBeVisible();
  const library = page.getByRole('region', { name: 'Library' });
  await expect(library.getByText(/2 tracks, 1 album from 1 source/)).toBeVisible();
  await expect(library.getByText('Storage used')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expectAccessible(page, 'standalone settings');

  // Export leaves secrets out.
  const [download] = await Promise.all([page.waitForEvent('download'), library.getByRole('button', { name: 'Export library' }).click()]);
  const exported = readFileSync((await download.path())!, 'utf8');
  expect(JSON.parse(exported)).toMatchObject({ format: 'overtone-library', sources: [{ providerId: 'subsonic', config: { username: 'e2e' } }] });
  expect(exported).not.toContain('e2e-pass');


  // Everything survives a reload (no mode question, no login), and the saved password still works.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.goto('/library/tracks');
  await page.getByRole('button', { name: /^Play Server Song Two by/ }).click();
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState), { timeout: 15_000 }).toBe('playing');
  await page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Pause' }).click();

  // Reset library (with confirmation): tracks go, the source stays.
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Reset library…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset library' }).click();
  await expect(page.getByRole('region', { name: 'Library' }).getByText(/0 tracks, 0 albums from 1 source/)).toBeVisible();

  expect(serverApiCalls).toEqual([]);
});

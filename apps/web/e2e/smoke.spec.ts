import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const USER = { username: 'smoke', password: 'smoke-password-1' };

/** Fail on serious/critical accessibility violations. */
async function expectAccessible(page: Page, label: string) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    return axe.run(document, { resultTypes: ['violations'] });
  });
  const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${label}`).toEqual([]);
}

/** First run creates the account; later runs (other project, reused server) sign in. */
async function signIn(page: Page) {
  await page.goto('/');
  const welcome = page.getByRole('heading', { name: 'Welcome' });
  const signin = page.getByRole('heading', { name: 'Sign in' });
  await expect(welcome.or(signin)).toBeVisible();
  // Server URL defaults to this origin and is shown on the auth screen.
  await expect(page.getByText(new URL(page.url()).origin)).toBeVisible();
  await expectAccessible(page, 'auth screen');
  await page.getByLabel('Username').fill(USER.username);
  await page.getByLabel('Password', { exact: true }).fill(USER.password);
  if (await welcome.isVisible()) {
    await page.getByLabel('Confirm password').fill(USER.password);
    await page.getByRole('button', { name: 'Create account' }).click();
  } else {
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('setup, browse, play with lock-screen metadata, fix a match, manage sources', async ({ page }) => {
  await signIn(page);

  // Library fills in from the scan; the matched album shows its cover.
  const album = page.getByRole('link', { name: /Album One by Test Artist/ }).first();
  await expect(album).toBeVisible({ timeout: 20_000 });
  await expectAccessible(page, 'home');

  await album.click();
  await expect(page.getByRole('heading', { name: 'Album One', level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Tracks on Album One' }).getByRole('listitem')).toHaveCount(4);
  await expectAccessible(page, 'album');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const bar = page.getByRole('region', { name: 'Player' });
  await expect(bar.getByRole('link', { name: /Now playing: Opening by Test Artist/ })).toBeVisible();

  // Media Session: title + absolute artwork URLs (for the lock screen / notification).
  await expect
    .poll(() => page.evaluate(() => ({ title: navigator.mediaSession.metadata?.title, state: navigator.mediaSession.playbackState })))
    .toEqual({ title: 'Opening', state: 'playing' });
  const artwork = await page.evaluate(() => navigator.mediaSession.metadata?.artwork.map((a) => a.src) ?? []);
  expect(artwork).toHaveLength(2);
  for (const src of artwork) {
    expect(src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/artwork\/release\/\d+\?at=.+&size=(250|500)$/);
    expect((await page.request.get(src)).status()).toBe(200);
  }

  // Audio actually advances.
  await bar.getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Now playing', level: 1 })).toBeVisible();
  await expect.poll(async () => Number(await page.getByRole('slider', { name: 'Seek' }).inputValue()), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expectAccessible(page, 'now playing');
  await page.getByRole('button', { name: 'Next track' }).click();
  await expect(page.getByRole('heading', { name: 'Track Two', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();

  // The untagged file is in the library from its filename, flagged, and fixable.
  // (Both projects share one server: the first fixes it, the second sees the fix persisted.)
  await page.goto('/library/tracks');
  const row = page.getByRole('listitem').filter({ hasText: 'Unknown Song' });
  if (test.info().project.name === 'mobile') {
    await expect(row.getByText('From tags')).toBeVisible();
    await row.getByRole('button', { name: 'More actions for Unknown Song' }).click();
    await page.getByRole('button', { name: /Fix match/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix match: Unknown Song' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Title').fill('Third Light');
    await dialog.getByLabel('Artist').fill('Test Artist');
    await dialog.getByRole('button', { name: 'Search MusicBrainz' }).click();
    await dialog.getByRole('button', { name: /Use this for Third Light from Album One/ }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
  await expect(row).toHaveCount(0);

  // Settings > Sources: test, and secrets are write-only in the add form.
  await page.goto('/settings/sources');
  const source = page.getByRole('listitem', { name: 'Music' });
  await source.getByRole('button', { name: 'Test connection' }).click();
  await expect(source.getByRole('status').filter({ hasText: /Found \d+ audio files/ })).toBeVisible();
  await expectAccessible(page, 'sources');
  await page.getByRole('link', { name: 'Add source' }).click();
  await page.getByRole('link', { name: /Real-Debrid/ }).click();
  const key = page.getByLabel(/API key/);
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveValue('');
  await expectAccessible(page, 'add source');
});

test('offline: the shell loads from the service worker and explains the server is unreachable', async ({ page, context }) => {
  await signIn(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // make sure this page is controlled by the SW
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: "Can't reach the server" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

  await context.setOffline(false);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
});

test('sign out and back in; server URL is editable on the login screen', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByRole('button', { name: /Change server/ }).click();
  await page.getByLabel('Server address').fill('http://127.0.0.1:1');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('alert')).toContainText("Can't reach an Overtone server");
  await page.getByLabel('Server address').fill(new URL(page.url()).origin);
  await page.getByRole('button', { name: 'Connect' }).click();

  await page.getByLabel('Username').fill(USER.username);
  await page.getByLabel('Password', { exact: true }).fill(USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Signing back in returns to where you were.
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
});

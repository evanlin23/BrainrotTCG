import { readdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded } from './support';
import { accessRequest } from './stagingAccess';

/*
 * The real build, served as a host serves it, at whichever BASE_PATH the run built for: the
 * GitHub Pages subpath by default, and the root in CI's BASE_PATH=/ run (docs/HOSTING.md).
 *
 * Direct reads use the `request` fixture, a separate request context with its own sockets, not
 * page.request: that shares the browser context's pool with monitor()'s route.fetch, so a socket it
 * keeps alive could be handed to a monitored request as the server closes it (#1046).
 */

const SET = { id: 'web-ancients', name: 'Web Ancients' };

/** Same-origin requests the page makes, by path under the base. */
const requests = (page: Page, baseURL: string) => {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(baseURL).origin) seen.push(url.pathname);
  });
  return seen;
};

test('the app shell, its code and its link-preview picture all load from the base path', async ({ page, request, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  const seen = requests(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectDecoded(page.locator('.pack-shell img'), 2);
  const base = new URL(baseURL!).pathname;
  // Everything the shell loads is hashed under assets/, bar the icons beside index.html.
  for (const path of seen) expect(path, path).toMatch(new RegExp(`^${base}(?:$|assets/[^/]+-[\\w-]{8}\\.\\w+$|[\\w.-]+\\.(?:svg|png)$)`));
  expect(seen.filter((path) => path.endsWith('.js')).length).toBeGreaterThan(0);

  // The picture the share tags name is served, as a 1200x630 JPEG, at this host's own path.
  const meta = (key: string) => page.locator(`meta[property="${key}"], meta[name="${key}"]`).getAttribute('content');
  const image = (await meta('og:image'))!;
  expect(await meta('twitter:image')).toBe(image);
  expect(await meta('twitter:card')).toBe('summary_large_image');
  const local = new URL(new URL(image).pathname.replace(/^.*?og-image/, 'og-image'), baseURL).href;
  const response = await request.get(local, accessRequest(local));
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/jpeg');
  expect([await meta('og:image:width'), await meta('og:image:height')]).toEqual(['1200', '630']);
  expect(errors).toEqual([]);
});

test("a set's link opens the packs screen on that set, and leaves the address clean", async ({ page, request, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  const setUrl = new URL(`s/${SET.id}/`, baseURL).href;
  const setPage = await request.get(setUrl, accessRequest(setUrl));
  expect(setPage.status()).toBe(200);
  expect(await setPage.text()).toContain(`<meta property="og:title" content="${SET.name}`);
  await page.goto(`./s/${SET.id}/`);
  const current = page.locator('.set-current-name');
  await expect(current).toHaveText(SET.name);
  await expect(page).toHaveURL(baseURL!);
  await expectDecoded(page.locator('.pack-shell img'), 2);

  // A set link followed inside the app picks that set too, but keeps the history entry the browser
  // added for it (useSetLink), so Back still steps back to the plain address. An unknown set stays put.
  await page.evaluate(() => { location.hash = '#/set/vine-and-dank'; });
  await expect(current).toHaveText('Vine & Dank');
  await expect(page).toHaveURL(`${baseURL}#/set/vine-and-dank`);
  // Each set's stage fetches its own pack art; the next change must not cancel it mid-flight.
  await expectDecoded(page.locator('.pack-shell img'), 2);
  await page.evaluate(() => { location.hash = '#/set/not-a-set'; });
  await expect(page).toHaveURL(`${baseURL}#/set/not-a-set`);
  await expect(current).toHaveText('Vine & Dank');
  await page.goBack();
  await expect(page).toHaveURL(`${baseURL}#/set/vine-and-dank`);
  await page.goBack();
  await expect(page).toHaveURL(baseURL!);
  await expect(current).toHaveText('Vine & Dank');
  expect(errors).toEqual([]);
});

test("a set's link, loaded cold while its pack art is still downloading, never asks for another set's pack art", async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  const packArt = /\/assets\/pack-[\w-]+\.webp$/;
  const asked = new Set<string>();
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (packArt.test(path)) asked.add(path);
  });
  // Hold every pack picture until the packs screen has settled on the set, so a request for the wrong
  // set's would still be in flight, as on a slow connection, when the app switches.
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route(packArt, async (route) => {
    await released;
    await route.fallback();
  });
  await page.goto(`./s/${SET.id}/`, { waitUntil: 'commit' });
  await expect(page.locator('.set-current-name')).toHaveText(SET.name);
  release();
  await expectDecoded(page.locator('.pack-shell img'), 2);
  // Only the linked set's picture was asked for: the default set's was never rendered.
  const shown = await page.locator('.pack-shell img').first().evaluate((image) => new URL((image as HTMLImageElement).src).pathname);
  expect([...asked]).toEqual([shown]);
  expect(errors).toEqual([]);
});

test('a first visit, with nothing cached, shows its pack and the cards it opens, and fetches few card pictures', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const seen = requests(page, baseURL!);
  await page.goto('./');
  await expectDecoded(page.locator('.pack-shell img'), 2);
  await page.getByRole('button', { name: /^Open pack/ }).click();
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
  await expectDecoded(page.locator('.summary-cards img'), 5);
  const pictures = new Set(seen.filter((path) => path.endsWith('.webp')));
  expect(pictures.size).toBeGreaterThan(0);
  // A pack's art, its back and five cards (with their finishes), not the whole catalogue.
  // dist is the build the web server just made and serves.
  const all = readdirSync('dist/assets').filter((file) => file.endsWith('.webp')).length;
  expect(pictures.size).toBeLessThan(all / 10);
  expect(errors).toEqual([]);
});

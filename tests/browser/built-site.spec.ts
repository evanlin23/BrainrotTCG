import { readdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded } from './support';

/*
 * The real build, served as a host serves it, at whichever BASE_PATH the run built for: the
 * GitHub Pages subpath by default, and the root in CI's BASE_PATH=/ run (docs/HOSTING.md).
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

test('the app shell, its code and its link-preview picture all load from the base path', async ({ page, baseURL }) => {
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
  const response = await page.request.get(local);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/jpeg');
  expect([await meta('og:image:width'), await meta('og:image:height')]).toEqual(['1200', '630']);
  expect(errors).toEqual([]);
});

test("a set's link opens the packs screen on that set, and leaves the address clean", async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  const setPage = await page.request.get(new URL(`s/${SET.id}/`, baseURL).href);
  expect(setPage.status()).toBe(200);
  expect(await setPage.text()).toContain(`<meta property="og:title" content="${SET.name}`);
  await page.goto(`./s/${SET.id}/`);
  const current = page.locator('.set-current-name');
  await expect(current).toHaveText(SET.name);
  await expect(page).toHaveURL(baseURL!);

  // A set link followed inside the app does the same; an unknown set stays put.
  await page.evaluate(() => { location.hash = '#/set/vine-and-dank'; });
  await expect(current).toHaveText('Vine & Dank');
  await expect(page).toHaveURL(baseURL!);
  await page.evaluate(() => { location.hash = '#/set/not-a-set'; });
  await expect(page).toHaveURL(baseURL!);
  await expect(current).toHaveText('Vine & Dank');
  expect(errors).toEqual([]);
});

test('a first visit, with nothing cached, shows its pack and the cards it opens, and fetches few card pictures', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const seen = requests(page, baseURL!);
  await page.goto('./');
  await expectDecoded(page.locator('.pack-shell img'), 2);
  await page.getByRole('button', { name: 'Open pack', exact: true }).click();
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

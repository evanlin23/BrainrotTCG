import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { monitor } from './support';

// A lazy page or sheet gets only the CSS its own chunk imports. These journeys open each one first on a
// cold load, before any other screen could have pulled a shared stylesheet in, and check that the
// classes it renders are styled.

const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors.json', import.meta.url), 'utf8')) as {
  profiles: { note: string; profile: string; name: string }[];
};

/** The page or sheet fits the viewport, so its content scrolls inside it instead of stretching it. */
async function expectBounded(page: Page, dialog: Locator) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
}

test('the Profile page is styled when it is the first page opened', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click();
  const profile = page.getByRole('main', { name: 'Profile', exact: true });
  await expect(profile.getByText(/^Player ID #/)).toBeVisible();
  // The pack foil swatches use a full-size foil overlay that only their own rules contain.
  await profile.locator('#rewards summary').click();
  const swatch = profile.locator('.foil-swatch').first();
  await expect(swatch).toBeVisible({ timeout: 15000 });
  await expect(swatch).toHaveCSS('position', 'relative');
  await expectBounded(page, profile);
  await expect(profile.locator('.profile-save-note')).toHaveCSS('display', 'flex');
  expect(errors).toEqual([]);
});

test('a shared profile styles its best pulls when it is the first sheet opened', async ({ page, baseURL }) => {
  // Opening a profile link verifies its Argon2id tickets in a worker, which is slow on a cold mobile run.
  test.setTimeout(120000);
  const vector = vectors.profiles.find(({ note }) => note === 'one set')!;
  const errors = await monitor(page, baseURL!);
  await page.goto(`./#/profile/${vector.profile}`);
  const profile = page.getByRole('dialog', { name: vector.name, exact: true });
  const rows = profile.locator('.pull-row');
  await expect(rows.first()).toBeVisible({ timeout: 90000 });
  for (const row of await rows.all()) {
    await expect(row).toHaveCSS('display', 'grid');
    expect((await row.boundingBox())!.height).toBeLessThan(200);
  }
  await expectBounded(page, profile);
  expect(errors).toEqual([]);
});

test('the pack summary labels and its card viewer are styled on a cold load', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  const pack = page.getByRole('button', { name: /^Open a .* pack$/ });
  await pack.focus();
  await page.keyboard.press('Space');
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.pack-summary .collection-label').first()).toHaveCSS('font-weight', '700');
  // The close-up is the first sheet this load opens, so only the main bundle's CSS is in place.
  await page.locator('.summary-card').first().click();
  const card = page.locator('.card-viewer .card-viewer-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveCSS('position', 'relative');
  const box = (await card.boundingBox())!;
  expect(box.height).toBeLessThan(page.viewportSize()!.height);
  expect(errors).toEqual([]);
});

test('a broken shared link styles its note', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await page.goto('./#/pull/abc');
  await expect(page.locator('.share-note')).toHaveCSS('display', 'flex');
  expect(errors).toEqual([]);
});

import { test, expect, type Page } from '@playwright/test';
import { expectDecoded, expectRecordedPack, monitor, snapshot } from './support';

// Two tabs of one player (#73). The tab that opens a pack stores it; the other tab hears about it,
// says its save changed, keeps its pack sealed and writes nothing, until a reload brings it current.

const STALE = 'This save changed in another tab';
const openPack = (page: Page) => page.getByRole('button', { name: 'Open pack', exact: true });

async function packsScreen(page: Page) {
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectDecoded(page.locator('.pack-shell img'), 2);
}

test('a second tab of the same player stops opening packs once the first stores one', async ({ context, page, baseURL }) => {
  test.setTimeout(90000);
  const errors = await monitor(page, baseURL!);
  await packsScreen(page);
  const other = await context.newPage();
  const otherErrors = await monitor(other, baseURL!);
  await packsScreen(other);
  await expect(other.getByRole('alert')).toHaveCount(0);

  // The first tab opens and stores its pack.
  await page.bringToFront();
  await openPack(page).click();
  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectRecordedPack(page);
  const stored = await snapshot(page);

  // The other tab heard the write and says why it can't go on.
  await other.bringToFront();
  const warning = other.getByRole('alert').filter({ hasText: STALE });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  // Its pack stays sealed and says so, and nothing it holds overwrites the first tab's save.
  await openPack(other).click();
  await expect(other.locator('.pack-refusal-text')).toHaveText(/^Your save changed in another tab, so this pack stayed sealed\./);
  await expect(other.locator('.card-reveal-area')).toHaveCount(0);
  await other.waitForTimeout(500);
  expect(await snapshot(other)).toEqual(stored);

  // A reload brings it current: no warning, the stored pack counted once, and the next ticket opens.
  await warning.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(other.locator('.app-logo')).toBeVisible();
  await expect(other.getByRole('alert').filter({ hasText: STALE })).toHaveCount(0);
  await expectDecoded(other.locator('.pack-shell img'), 2);
  await openPack(other).click();
  await other.locator('button.reveal-skip').click();
  await expect(other.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expect.poll(async () => (await snapshot(other)).history?.map((record) => record.n).sort()).toEqual([0, 1]);
  expect((await snapshot(other)).stats.packsOpened).toBe(2);
  expect(errors).toEqual([]);
  expect(otherErrors).toEqual([]);
});

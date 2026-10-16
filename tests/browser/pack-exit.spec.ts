import { test, expect } from '@playwright/test';
import { monitor, snapshot } from './support';

test('browser Back mid-reveal returns to the packs screen, keeps the pack and stays on the site', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const start = page.url();
  const packShell = page.getByRole('button', { name: 'Open pack', exact: true });
  const close = page.getByRole('button', { name: 'Back to packs', exact: true });
  const length = await page.evaluate(() => history.length);

  for (const pack of [1, 2]) {
    await packShell.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5');
    await expect(close).toBeEnabled();
    // One entry per pack: a second pack replaces the first's, it doesn't stack on it.
    expect(await page.evaluate(() => history.length)).toBe(length + 1);

    await page.goBack();
    await expect(packShell).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.card-reveal-area')).toHaveCount(0);
    await expect(close).toHaveCount(0);
    await expect(page.locator('.app-logo')).toBeVisible();
    expect(page.url(), 'Back left the page or changed its address').toBe(start);
    await expect.poll(async () => (await snapshot(page)).stats?.packsOpened).toBe(pack);
    await expect(page.locator('.toast').filter({ hasText: 'Pack kept' })).toBeVisible();
  }

  // Forward onto the old entry reopens nothing.
  await page.goForward();
  await page.waitForTimeout(500);
  await expect(packShell).toBeVisible();
  await expect(page.locator('.card-reveal-area')).toHaveCount(0);
  expect((await snapshot(page)).stats.packsOpened).toBe(2);
  expect(errors).toEqual([]);
});

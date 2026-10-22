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

test('browser Back from the summary lands on a fully drawn packs screen, keeps the pack once, and Forward and Back behave', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const start = page.url();
  const packShell = page.getByRole('button', { name: 'Open pack', exact: true });
  const packs = async () => (await snapshot(page)).stats.packsOpened;
  // The wrapper art is drawn: its stage is opaque and in place, and the art has a real size on screen.
  const drawn = async () => {
    await expect(packShell).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.evaluate(() => {
      const stage = document.querySelector('.pack-display');
      const art = document.querySelector<HTMLImageElement>('.pack-shell .pack-half-bottom > img');
      if (!stage || !art) return 'missing';
      const box = art.getBoundingClientRect();
      const shown = Number(getComputedStyle(stage).opacity) === 1 && getComputedStyle(stage).transform === 'none';
      return shown && art.complete && art.naturalWidth > 0 && box.width > 0 && box.height > 0 ? 'drawn' : 'not drawn';
    }), { message: 'the wrapper art is not drawn', timeout: 5000 }).toBe('drawn');
    await expect(page.locator('.card-reveal-area')).toHaveCount(0);
    expect(page.url(), 'the address changed').toBe(start);
  };

  await packShell.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Skip opening animation' }).click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 15000 });

  await page.goBack();
  await drawn();
  await expect.poll(packs).toBe(1);

  // Forward onto the old entry reopens nothing; Back again lands on the same screen. Nothing is counted twice.
  await page.goForward();
  await page.waitForTimeout(500);
  await drawn();
  await page.goBack();
  await drawn();
  expect(await packs()).toBe(1);
  expect(errors).toEqual([]);
});

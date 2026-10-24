import { test, expect } from '@playwright/test';
import { monitor, snapshot, untilIdle } from './support';

test('browser Back mid-reveal returns to the packs screen, keeps the pack and stays on the site', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  // The page's clock is Playwright's, running, so it can be held while the notice is checked below.
  await page.clock.install();
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const start = page.url();
  const packShell = page.getByRole('button', { name: /^Open pack/ });
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

    // The notice leaves by its own timer, TOAST_MS after it shows, and the next toast takes its place. The
    // checks below can take longer than that on a loaded machine, so the page's clock stops before Back
    // and runs again once the notice has been seen.
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
    await page.goBack();
    await expect(packShell).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.card-reveal-area')).toHaveCount(0);
    await expect(close).toHaveCount(0);
    await expect(page.locator('.app-logo')).toBeVisible();
    expect(page.url(), 'Back left the page or changed its address').toBe(start);
    await expect.poll(async () => (await snapshot(page)).stats?.packsOpened).toBe(pack);
    await expect(page.locator('.toast').filter({ hasText: 'Pack kept' })).toBeVisible();
    await page.clock.resume();
  }

  // Forward onto the old entry reopens nothing.
  await page.goForward();
  await untilIdle(page);
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
  const packShell = page.getByRole('button', { name: /^Open pack/ });
  const packs = async () => (await snapshot(page)).stats.packsOpened;
  // The wrapper art is drawn: its stage is opaque and in place, and the art has a real size on screen.
  // Anything else names each condition that fails, with what it saw.
  const drawn = async () => {
    await expect(packShell).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.evaluate(() => {
      const stage = document.querySelector('.pack-display');
      const art = document.querySelector<HTMLImageElement>('.pack-shell .pack-half-bottom > img');
      if (!stage || !art) return `missing:${stage ? '' : ' stage'}${art ? '' : ' art'}`;
      const box = art.getBoundingClientRect();
      const { opacity, transform } = getComputedStyle(stage);
      const failing = [
        Number(opacity) === 1 ? '' : `opacity ${opacity}`,
        transform === 'none' ? '' : `transform ${transform}`,
        art.complete ? '' : 'complete false',
        art.naturalWidth > 0 ? '' : `naturalWidth ${art.naturalWidth}`,
        box.width > 0 && box.height > 0 ? '' : `box ${box.width}x${box.height}`,
      ].filter(Boolean);
      return failing.length === 0 ? 'drawn' : `not drawn: ${failing.join(', ')}`;
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
  await untilIdle(page);
  await drawn();
  await page.goBack();
  await drawn();
  expect(await packs()).toBe(1);
  expect(errors).toEqual([]);
});

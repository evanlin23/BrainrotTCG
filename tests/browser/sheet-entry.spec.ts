import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

// A lazy sheet shows a loading placeholder until its chunk arrives. The loaded screen must take the
// placeholder's place without replaying the entrance: one fade of the backdrop, one rise of the panel.

declare global {
  interface Window { sheetEntrances: { part: 'panel' | 'backdrop'; deferred: boolean }[] }
}

/** Records every entrance animation that starts on a sheet panel or backdrop. */
async function countEntrances(page: Page) {
  await page.addInitScript(() => {
    window.sheetEntrances = [];
    document.addEventListener('animationstart', (event) => {
      const target = event.target as Element;
      const part = target.classList.contains('sheet-backdrop') ? 'backdrop' : target.classList.contains('sheet') ? 'panel' : null;
      if (part) window.sheetEntrances.push({ part, deferred: target.classList.contains('sheet--deferred') });
    }, true);
  });
}

const entrances = async (page: Page) => {
  const list = await page.evaluate(() => window.sheetEntrances);
  return {
    panel: list.filter(({ part }) => part === 'panel').length,
    backdrop: list.filter(({ part }) => part === 'backdrop').length,
    placeholder: list.some(({ deferred }) => deferred),
  };
};

const SCREENS = [
  { tab: 'My cards', chunk: '**/assets/CollectionBrowser-*.js' },
  { tab: 'Rankings', chunk: '**/assets/HallOfFamePage-*.js' },
];

for (const { tab, chunk } of SCREENS) {
  test(`${tab} enters once while its chunk is slow`, async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!);
    await countEntrances(page);
    // Page routes run before monitor's context route.
    await page.route(chunk, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: tab, exact: true }).click();
    await expect(page.locator('.sheet--deferred')).toBeVisible();
    await expect(page.locator('.sheet--deferred')).toHaveCount(0, { timeout: 15000 });
    const dialog = page.getByRole('dialog', { name: tab, exact: true });
    await expect(dialog).toBeVisible();
    // Long enough for a replayed entrance to start.
    await page.waitForTimeout(500);
    expect(await entrances(page)).toEqual({ panel: 1, backdrop: 1, placeholder: true });
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('pointing at My cards fetches it, so it opens with no placeholder', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await countEntrances(page);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const tab = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'My cards', exact: true });
  const fetched = page.waitForResponse(/\/assets\/CollectionBrowser-[^/]+\.js$/);
  await tab.hover();
  await fetched;
  await tab.click();
  await expect(page.getByRole('dialog', { name: 'My cards', exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await entrances(page)).toEqual({ panel: 1, backdrop: 1, placeholder: false });
  expect(errors).toEqual([]);
});

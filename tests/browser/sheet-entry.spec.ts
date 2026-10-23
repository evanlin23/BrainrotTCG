import { test, expect, type Page } from '@playwright/test';
import { monitor, untilIdle } from './support';

// Cards and Rankings are pages: while a slow chunk loads, a skeleton holds the page's place (rows for
// Rankings) and no sheet opens or animates in, so nothing flashes. Pointing at a tab fetches its chunk.

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
  { tab: 'Cards', chunk: '**/assets/CollectionBrowser-*.js', skeleton: '.page-skeleton--blocks', content: '.collection' },
  { tab: 'Rankings', chunk: '**/assets/HallOfFamePage-*.js', skeleton: '.page-skeleton--rows', content: '.hall-of-fame' },
];

for (const { tab, chunk, skeleton, content } of SCREENS) {
  test(`${tab} holds its page with a skeleton while its chunk is slow, with no sheet`, async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await countEntrances(page);
    // Page routes run before monitor's context route.
    await page.route(chunk, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: tab, exact: true }).click();
    const main = page.getByRole('main', { name: tab, exact: true });
    await expect(main).toBeVisible();
    await expect(main.locator(skeleton)).toBeVisible();
    await expect(main.locator('.page-skeleton')).toHaveCount(0, { timeout: 15000 });
    await expect(main.locator(content).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // An entrance starts with the render that shows the sheet, so it has started once the page is idle.
    await untilIdle(page);
    expect(await entrances(page)).toEqual({ panel: 0, backdrop: 0, placeholder: false });
    expect(errors).toEqual([]);
  });
}

test('pointing at Cards fetches it, so it opens with no skeleton', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('.page-skeleton')) document.documentElement.dataset.sawSkeleton = 'yes';
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const tab = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Cards', exact: true });
  const fetched = page.waitForResponse(/\/assets\/CollectionBrowser-[^/]+\.js$/);
  await tab.hover();
  // Importing the same module again settles once the first import has evaluated, so the loader holds it
  // before the click.
  const chunkUrl = (await fetched).url();
  await page.evaluate((href) => import(/* @vite-ignore */ href).then(() => undefined), chunkUrl);
  await tab.click();
  const main = page.getByRole('main', { name: 'Cards', exact: true });
  await expect(main.locator('.collection')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.sawSkeleton ?? 'no')).toBe('no');
  expect(errors).toEqual([]);
});

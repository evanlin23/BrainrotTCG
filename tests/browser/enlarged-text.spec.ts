import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor } from './support';

// Enlarged text on the narrowest phone (#681, #682): the Cards page's unstarted-era rows and the empty
// Profile's first-pack button wrap inside the page instead of running off its right edge.

const pageNamed = (page: Page, name: string) => page.getByRole('main', { name, exact: true });

/** Scales the root font like a player's text-size setting, and waits for fonts to settle. */
async function scaleText(page: Page, percent: number) {
  await page.addStyleTag({ content: `html { font-size: ${percent}% !important; }` });
  await page.evaluate(() => document.fonts.ready);
}

/** `target` and everything inside it stays within the page width, and the page itself doesn't scroll sideways. */
const insidePage = (page: Page, target: Locator, width: number) => expect.poll(async () => {
  const overflow = await target.evaluate((root, width) => {
    const out: string[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const box = el.getBoundingClientRect();
      if (box.width && (box.left < -0.5 || box.right > width + 0.5)) out.push(`${el.className} ${box.left.toFixed(0)}..${box.right.toFixed(0)}`);
    }
    return out;
  }, width);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  return { overflow, scroll: Math.max(scroll, width) };
}).toEqual({ overflow: [], scroll: width });

/** No element in `target` hides part of its own content behind an overflow clip. */
const unclipped = (target: Locator) => expect.poll(() => target.evaluate((root) =>
  [root, ...Array.from(root.querySelectorAll('*'))].filter((el) => {
    const { overflowX, overflowY } = getComputedStyle(el);
    const clips = [overflowX, overflowY].some((value) => value !== 'visible');
    return clips && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  }).map((el) => el.className),
)).toEqual([]);

for (const width of [320, 390]) {
  for (const percent of [100, 200]) {
    test(`Cards: unstarted eras fit a ${width} px phone at ${percent}% text (#681)`, async ({ page, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
      await page.setViewportSize({ width, height: 700 });
      const errors = await monitor(page, baseURL!, 0, { returning: true });
      await page.goto('./#/cards');
      const later = pageNamed(page, 'Cards').locator('.collection-later');
      await expect(later).toBeVisible();
      await scaleText(page, percent);
      const rows = later.locator('li');
      expect(await rows.count()).toBeGreaterThan(0);
      for (const row of await rows.all()) {
        // Name, era and count are all there, with the whole count text.
        await expect(row.locator('.collection-later-name')).not.toBeEmpty();
        await expect(row.locator('.collection-later-era')).not.toBeEmpty();
        await expect(row.locator('.collection-later-count')).toHaveText(/^0\/\d+$/);
      }
      await insidePage(page, later, width);
      await unclipped(later);
      // The control is the ordinary layout: one short line per era at default text.
      if (percent === 100) {
        const heights = await rows.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
        expect(Math.max(...heights)).toBeLessThan(60);
      }
      expect(errors).toEqual([]);
    });
  }
}

test('Cards: Spring Breakdown keeps its count on screen at 320 px and 200% text (#681)', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
  await page.setViewportSize({ width: 320, height: 640 });
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./#/cards');
  const row = pageNamed(page, 'Cards').locator('.collection-later li', { hasText: 'Spring Breakdown' });
  await expect(row).toBeVisible();
  await scaleText(page, 200);
  const count = row.locator('.collection-later-count');
  await expect.poll(async () => {
    const box = (await count.boundingBox())!;
    return box.x >= 0 && box.x + box.width <= 320;
  }).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(errors).toEqual([]);
});

for (const width of [320, 390]) {
  for (const percent of [100, 200]) {
    test(`Profile: the empty first-pack action fits a ${width} px phone at ${percent}% text (#682)`, async ({ page, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
      await page.setViewportSize({ width, height: 700 });
      // A new player: no saved packs, so Profile shows its empty state.
      const errors = await monitor(page, baseURL!);
      await page.goto('./#/profile');
      const action = pageNamed(page, 'Profile').getByRole('button', { name: 'Open your first pack', exact: true });
      await expect(action).toBeVisible();
      await scaleText(page, percent);
      await action.scrollIntoViewIfNeeded();
      await insidePage(page, action, width);
      await unclipped(action);
      // The whole label is painted: the button grows to hold wrapped lines instead of cutting the text.
      await expect.poll(() => action.evaluate((button) => button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1)).toBe(true);
      expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      if (percent === 100) {
        // The ordinary look: one line, not stretched to the page.
        const box = (await action.boundingBox())!;
        expect(box.width).toBeLessThan(260);
        expect(box.height).toBeLessThan(60);
      }
      // It still goes to the pack screen.
      await action.click();
      await expect(page.getByRole('button', { name: /^Open pack/ })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}

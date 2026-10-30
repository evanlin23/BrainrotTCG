import { test, expect, type Page } from '@playwright/test';
import { expectStill, monitor } from './support';

/**
 * The Card guide link stays centred under the pack whether or not the next goal (#212) is in its row (the owner's
 * call): the goal takes the space to the right of the centred link, and a row without room for it on that side
 * shows no goal rather than shift or squeeze the guide.
 */

async function open(page: Page, baseURL: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  const errors = await monitor(page, baseURL, 1, { returning: true });
  await page.goto('./');
  await expect(page.locator('.card-guide-link')).toBeVisible();
  // An unread announcement has the row first (its own layout, News.css); this is about the goal, so take it out.
  await page.evaluate(() => document.querySelector('.news-banner')?.remove());
  await expect(page.locator('.news-banner')).toHaveCount(0);
  await expectStill(page.locator('.pack-display'), 'the pack has settled');
  return errors;
}

const measure = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => {
    const el = document.querySelector(selector);
    if (!el || getComputedStyle(el).display === 'none') return null;
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  };
  return { pack: box('.pack-display')!, guide: box('.card-guide-link')!, goal: box('.pack-milestone'), row: box('.card-guide-entry')! };
});

const centre = (box: { x: number; width: number }) => box.x + box.width / 2;

const SIZES = [
  { name: 'a Pixel 5 phone', project: 'mobile-chromium', width: 393, height: 851, goal: false },
  { name: 'a 768px tablet', project: 'desktop-chromium', width: 768, height: 1024, goal: true },
  { name: 'a 1280 x 800 desktop', project: 'desktop-chromium', width: 1280, height: 800, goal: true },
] as const;

for (const size of SIZES) {
  test(`keeps the guide centred under the pack with and without the goal on ${size.name}`, async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== size.project, 'One project per width.');
    const errors = await open(page, baseURL!, size.name === 'a Pixel 5 phone' ? { width: size.width, height: size.height } : size);
    const withGoal = await measure(page);
    expect(await page.locator('.pack-milestone').count(), 'the goal is in the row').toBe(1);
    if (size.goal) {
      expect(withGoal.goal, 'the goal is shown where the row has room for it').not.toBeNull();
      // Right of the guide link, in the same row, inside the screen.
      expect(withGoal.goal!.x).toBeGreaterThanOrEqual(withGoal.guide.x + withGoal.guide.width - 0.5);
      expect(withGoal.goal!.x + withGoal.goal!.width).toBeLessThanOrEqual(size.width);
      expect(withGoal.goal!.y).toBeGreaterThanOrEqual(withGoal.pack.y + withGoal.pack.height - 0.5);
      expect(withGoal.goal!.height).toBeLessThanOrEqual(withGoal.row.height + 0.5);
    } else {
      expect(withGoal.goal, 'a row too narrow for the goal beside a centred guide shows none').toBeNull();
    }
    expect(Math.abs(centre(withGoal.guide) - centre(withGoal.pack)), 'guide centre vs pack centre, with the goal').toBeLessThanOrEqual(1);

    await page.evaluate(() => document.querySelector('.pack-milestone')!.remove());
    const without = await measure(page);
    expect(Math.abs(centre(without.guide) - centre(without.pack)), 'guide centre vs pack centre, without the goal').toBeLessThanOrEqual(1);
    // Taking the goal out moves nothing: the row, the pack and the guide stay where they were.
    expect(without).toEqual({ ...withGoal, goal: null });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    expect(errors).toEqual([]);
  });
}

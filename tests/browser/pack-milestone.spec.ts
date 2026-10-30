import { test, expect, type Page } from '@playwright/test';
import { monitor, scaleText } from './support';

/**
 * The next goal (#212) shares the Card guide's row under the pack, after the announcement it yields to, so it
 * adds no height of its own: it can't change the pack's size or position or the nav's, or cover the pack, its
 * tear line or the toast, and opening the pack stays the biggest thing on screen. It steps aside where the
 * row is too narrow for it and on a phone on its side, and nothing in it moves.
 */

async function open(page: Page, baseURL: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  const errors = await monitor(page, baseURL, 1, { returning: true });
  await page.goto('./');
  return errors;
}

/** An announcement, when one is unread, has the row first; the goal waits for it to be dismissed. */
async function clearNews(page: Page) {
  await expect(page.locator('.card-guide-link')).toBeVisible();
  const dismiss = page.getByRole('button', { name: 'Dismiss announcement' });
  if (await dismiss.isVisible()) await dismiss.click();
  // Where the row is too narrow or short for the announcement it is hidden, not dismissed: take it out, so
  // what the goal does there is its own rule and not the announcement's.
  else await page.evaluate(() => document.querySelector('.news-banner')?.remove());
  await expect(page.locator('.news-banner')).toHaveCount(0);
}

const layout = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => {
    const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
    return { x, y, width, height };
  };
  return { pack: box('.pack-display'), header: box('.app-header'), nav: box('.app-nav'), row: box('.card-guide-entry') };
});

/** The pack falls in on load: wait until it stops moving before measuring anything. */
async function settled(page: Page) {
  let last = -1;
  await expect.poll(async () => {
    const top = (await page.locator('.pack-display').evaluate((el) => el.getBoundingClientRect().top));
    const still = top === last;
    last = top;
    return still;
  }).toBe(true);
}

for (const [width, height, percent] of [[390, 844, 100], [360, 640, 100], [320, 568, 100], [320, 568, 200]] as const) {
  test(`sits in the guide's row without moving anything on a ${width} x ${height} phone at ${percent}% text`, async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
    const errors = await open(page, baseURL!, { width, height });
    if (percent !== 100) await scaleText(page, percent);
    await settled(page);
    const withNews = await layout(page);
    await clearNews(page);
    await settled(page);
    // Dismissing the news (or none being unread) moved nothing, with the goal in its place or not.
    expect(await layout(page)).toEqual(withNews);

    const goal = page.locator('.card-guide-entry .pack-milestone');
    if (width === 320) {
      // No room beside the guide link: it shows nothing rather than squeeze it.
      await expect(goal).toBeHidden();
    } else {
      await expect(goal).toBeVisible();
      const [box, guide, row, pack] = [(await goal.boundingBox())!, (await page.locator('.card-guide-link').boundingBox())!, withNews.row, withNews.pack];
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeLessThanOrEqual(row.height + 0.5);
      // Inside the row, level with the guide link, clear of it, of the pack and of the screen's edges.
      expect(box.x).toBeGreaterThanOrEqual(guide.x + guide.width - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(pack.y + pack.height - 0.5);
      // No second row, and no animation of its own to run.
      expect(await goal.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
}

test('steps aside on a phone on its side, where the pack has no room to spare', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
  const errors = await open(page, baseURL!, { width: 740, height: 360 });
  await expect(page.locator('.app-logo')).toBeVisible();
  await clearNews(page);
  await expect(page.locator('.card-guide-entry .pack-milestone')).toBeHidden();
  expect(errors).toEqual([]);
});

test('on a desktop window it names the goal and goes to the rewards, and the pack stays where it was', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A desktop layout check.');
  const errors = await open(page, baseURL!, { width: 1280, height: 800 });
  await settled(page);
  const before = await layout(page);
  await clearNews(page);
  const goal = page.locator('.card-guide-entry .pack-milestone');
  await expect(goal).toBeVisible();
  expect(await layout(page)).toEqual(before);
  await expect(goal).toContainText('odds stay the same');
  await goal.click();
  await expect(page).toHaveURL(/profile/);
  expect(errors).toEqual([]);
});

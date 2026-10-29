import { test, expect, type Page } from '@playwright/test';
import { monitor, scaleText } from './support';

/**
 * The news banner (#58) shares the Card guide's row under the pack, so it adds no height of its own: it can't
 * change the pack's size or position or the nav's, or cover the pack or its tear line, and dismissing it
 * moves none of them. It steps aside where the row is too narrow for it and on a phone on its side.
 * Dismissing it hands focus to the logo.
 */
// The banner reads the announcements the build ships (src/content/news.json), so these run against the
// latest one: its words may change, the room it may take may not.

async function open(page: Page, baseURL: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  const errors = await monitor(page, baseURL, 0, { returning: true });
  await page.goto('./');
  return errors;
}

const rect = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
  const { top, bottom, height } = el.getBoundingClientRect();
  return { top, bottom, height };
});

const settled = async (page: Page) => {
  // The pack falls in on load: wait until it stops moving before measuring anything.
  let last = -1;
  await expect.poll(async () => {
    const top = (await rect(page, '.pack-display')).top;
    const still = top === last;
    last = top;
    return still;
  }).toBe(true);
};

async function layout(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, y, width, height };
    };
    return { pack: box('.pack-display'), header: box('.app-header'), nav: box('.app-nav'), row: box('.card-guide-entry') };
  });
}

for (const [width, height, percent] of [[390, 844, 100], [360, 640, 100], [320, 568, 100], [320, 568, 200]] as const) {
  test(`shares the guide's row without moving anything on a ${width} x ${height} phone at ${percent}% text`, async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
    const errors = await open(page, baseURL!, { width, height });
    if (percent !== 100) await scaleText(page, percent);
    await expect(page.locator('.card-guide-link')).toBeVisible();
    // The banner is on the page once its news has loaded; whether it is shown depends on the room.
    await expect(page.locator('.news-banner')).toHaveCount(1);
    await settled(page);
    const before = await layout(page);
    const guide = (await page.locator('.card-guide-link').boundingBox())!;
    expect(guide.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    const banner = page.locator('.news-banner');
    if (width === 320) {
      // No room beside the guide link: it shows nothing rather than squeeze it.
      await expect(banner).toBeHidden();
    } else {
      await expect(banner).toBeVisible();
      const box = (await banner.boundingBox())!;
      // Inside the row, level with the guide link, clear of it and of the screen's edges.
      expect(box.height).toBeLessThanOrEqual(before.row.height + 0.5);
      expect(box.x).toBeGreaterThanOrEqual(guide.x + guide.width - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(before.pack.y + before.pack.height - 0.5);
      const dismiss = (await page.locator('.news-banner-dismiss').boundingBox())!;
      expect(dismiss.width).toBeGreaterThanOrEqual(44);
      expect(dismiss.height).toBeGreaterThanOrEqual(44);
      await page.locator('.news-banner-dismiss').click();
      await expect(banner).toHaveCount(0);
      // Dismissing moved nothing: the pack, the header, the nav and the row are where they were.
      expect(await layout(page)).toEqual(before);
    }
    expect(errors).toEqual([]);
  });
}

test('steps aside on a phone on its side, where the pack has no room to spare', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
  const errors = await open(page, baseURL!, { width: 740, height: 360 });
  await expect(page.locator('.app-logo')).toBeVisible();
  // It is on the page (its news has loaded) and the app's own short-screen rule hides it: not merely absent yet.
  await expect(page.locator('.news-banner')).toHaveCount(1);
  await expect(page.locator('.news-banner')).toBeHidden();
  expect((await rect(page, '.pack-display')).height).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});

test('dismissing hands focus to the logo and the choice is kept across a reload', async ({ page, baseURL }) => {
  const errors = await open(page, baseURL!, { width: 390, height: 844 });
  const dismiss = page.getByRole('button', { name: 'Dismiss announcement' });
  await dismiss.focus();
  await dismiss.press('Enter');
  await expect(page.locator('.news-banner')).toHaveCount(0);
  await expect(page.locator('h1.app-logo')).toBeFocused();
  await page.reload();
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(page.locator('.news-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
});

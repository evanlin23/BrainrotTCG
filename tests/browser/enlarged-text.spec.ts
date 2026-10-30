import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor, scaleText } from './support';

// Enlarged text on the narrowest phone (#681, #682, #765): the Cards page's unstarted-era rows, the empty
// Profile's first-pack button and Settings' Motion row wrap inside the page instead of running off its right edge.

const pageNamed = (page: Page, name: string) => page.getByRole('main', { name, exact: true });

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
    test(`Cards: unstarted eras fit a ${width} px phone at ${percent}% text (#681)`, { tag: '@mobile-only' }, async ({ page, baseURL }) => {
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

for (const percent of [100, 200]) {
  test(`Cards: search and filter controls fit a 320 px phone at ${percent}% text, 44 px high (#756)`, { tag: '@mobile-only' }, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./#/cards');
    const cards = pageNamed(page, 'Cards');
    const controls = cards.getByRole('search');
    await expect(controls).toBeVisible();
    await scaleText(page, percent);
    // The Clear search and Clear filters buttons only exist while something is filtered.
    await controls.getByRole('searchbox').fill('zzzz');
    await controls.getByRole('button', { name: 'Missing only' }).click();
    await expect(cards.getByRole('status')).toHaveText('No cards match the active filters.');
    await insidePage(page, cards, 320);
    await unclipped(controls);
    const heights = await controls.locator('input, select, button').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(heights.length).toBe(9);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    const clearWidths = await controls.getByRole('button', { name: 'Clear search' }).evaluate((el) => el.getBoundingClientRect().width);
    expect(clearWidths).toBeGreaterThanOrEqual(44);
    expect(errors).toEqual([]);
  });
}

test('Cards: Spring Breakdown keeps its count on screen at 320 px and 200% text (#681)', { tag: '@mobile-only' }, async ({ page, baseURL }) => {
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
    test(`Profile: the empty first-pack action fits a ${width} px phone at ${percent}% text (#682)`, { tag: '@mobile-only' }, async ({ page, baseURL }) => {
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

for (const width of [320, 390]) {
  for (const percent of [100, 200]) {
    test(`Settings: the Motion row fits a ${width} px phone at ${percent}% text and works by keyboard (#765)`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 700 });
      const errors = await monitor(page, baseURL!);
      await page.goto('./#/settings');
      const group = pageNamed(page, 'Settings').getByRole('radiogroup', { name: 'Motion', exact: true });
      await expect(group).toBeVisible();
      await scaleText(page, percent);
      const row = group.locator('xpath=ancestor::*[contains(@class, "settings-row")]');
      await group.scrollIntoViewIfNeeded();
      await insidePage(page, row, width);
      await unclipped(row);

      const radios = group.getByRole('radio');
      await expect(radios).toHaveText(['Auto', 'Reduced']);
      for (const radio of await radios.all()) {
        expect((await radio.boundingBox())!.height, 'a choice is a touch target').toBeGreaterThanOrEqual(44);
        // The whole label is painted: the choice grows to hold wrapped lines instead of cutting the text.
        await expect.poll(() => radio.evaluate((button) => button.scrollWidth <= button.clientWidth + 1)).toBe(true);
      }
      // The choices sit below the text, or beside it when there is room, and never over it.
      const [desc, choices] = await Promise.all([row.locator('.settings-desc').boundingBox(), group.boundingBox()]);
      const overlaps = choices!.x < desc!.x + desc!.width && choices!.x + choices!.width > desc!.x && choices!.y < desc!.y + desc!.height && choices!.y + choices!.height > desc!.y;
      expect(overlaps, 'the choices cover the description').toBe(false);

      // Keyboard: one Tab stop on the chosen choice, and the arrows move the choice.
      const [auto, reduced] = await radios.all();
      await auto.focus();
      await page.keyboard.press('ArrowRight');
      await expect(reduced).toBeFocused();
      await expect(reduced).toHaveAttribute('aria-checked', 'true');
      await expect(auto).toHaveAttribute('aria-checked', 'false');
      await page.keyboard.press('ArrowLeft');
      await expect(auto).toBeFocused();
      await expect(auto).toHaveAttribute('aria-checked', 'true');
      expect(errors).toEqual([]);
    });
  }
}

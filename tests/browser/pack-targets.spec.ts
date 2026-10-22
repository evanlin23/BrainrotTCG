import { test, expect, type Page } from '@playwright/test';
import { expectDecoded, expectStill, fingerFor, monitor } from './support';

/**
 * Motor access (#803). A swipe let go short of opening answers: the pack springs back, the hint says
 * to go farther or tap the pack, and the click the swipe ends in opens nothing; a tap and Space on the
 * pack still open it. The
 * small controls the issue measured keep at least 44 CSS px of hit area at 390px wide and at 200% zoom
 * (a 195px-wide viewport) and with the text doubled, and nothing runs off the side.
 */

const TARGET = 44;
const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });
const settingsButton = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true });

/** The width x height of every element matching each selector, as the page lays it out. */
async function sizes(page: Page, selectors: string[]) {
  return page.evaluate((list) => list.flatMap((selector) => {
    const found = Array.from(document.querySelectorAll(selector));
    return found.map((el) => {
      const { width, height } = el.getBoundingClientRect();
      return { selector, width, height };
    });
  }), selectors);
}

function expectTargets(found: { selector: string; width: number; height: number }[], selectors: string[]) {
  for (const selector of selectors) {
    const matches = found.filter((entry) => entry.selector === selector);
    expect(matches.length, `${selector} is on the page`).toBeGreaterThan(0);
    for (const { width, height } of matches) {
      expect(width, `${selector} width`).toBeGreaterThanOrEqual(TARGET - 0.5);
      expect(height, `${selector} height`).toBeGreaterThanOrEqual(TARGET - 0.5);
    }
  }
}

test('a swipe let go short springs back with a hint, and the pack still opens by tap and key', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const shell = page.locator('.pack-shell');
  // The fall-in has landed before the press below is aimed at where the pack rests.
  await expectDecoded(shell.locator('img'), 2);
  await expectStill(shell, 'the pack to land');
  await shell.scrollIntoViewIfNeeded();

  // The answer lasts under two seconds, so record it as it appears instead of racing the timer.
  await page.evaluate(() => {
    const seen: { hint: string | null; clicked: boolean } = { hint: null, clicked: false };
    (window as unknown as { __short: typeof seen }).__short = seen;
    // The release ends in a click on the pack too: it must not count as a tap.
    document.addEventListener('click', () => { seen.clicked = true; }, { capture: true });
    const note = () => {
      if (seen.hint || !document.querySelector('.pack-shell.is-short')) return;
      seen.hint = document.querySelector('.swipe-hint-text')?.textContent ?? '';
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });

  const box = (await shell.boundingBox())!;
  const y = box.y + box.height * 0.19;
  const finger = await fingerFor(page, hasTouch);
  // 9% of the pack's width: well over the 10px slop on a narrow pack, but short of the 12% a release needs.
  await finger.press(box.x + box.width * 0.4, y);
  for (let step = 1; step <= 6; step++) await finger.move(box.x + box.width * (0.4 + (0.09 * step) / 6), y);
  await finger.release();

  // A touch drag ends in no click; a mouse one does, and the pack must not take it as a tap.
  await page.waitForFunction((clickToo) => {
    const seen = (window as unknown as { __short: { hint: string | null; clicked: boolean } }).__short;
    return !!seen.hint && (seen.clicked || !clickToo);
  }, !hasTouch);
  const seen = await page.evaluate(() => (window as unknown as { __short: { hint: string } }).__short);
  expect(seen.hint).toMatch(/^(Swipe farther, or tap the pack|Drag farther, or click the pack)$/);
  await expect(shell).not.toHaveClass(/\bis-cut\b/);

  await openPack(page).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
  expect(errors).toEqual([]);
});

for (const [name, width, height, bigText] of [
  ['390px wide', 390, 844, false],
  ['200% browser zoom (195px wide)', 195, 422, false],
  ['200% text on a 390px phone', 390, 844, true],
] as const) {
  test(`the small controls keep 44px hit areas at ${name}`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height });
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    if (bigText) await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });

    const home = ['.app-utilities button[aria-label="Settings"]', '.set-step', '.card-guide-link', '[data-pack-open]'];
    expectTargets(await sizes(page, home), home);

    await settingsButton(page).click();
    await expect(page.locator('.page-close')).toBeVisible();
    expectTargets(await sizes(page, ['.page-close']), ['.page-close']);
    await page.locator('.page-close').click();

    await openPack(page).click();
    await expect(page.locator('.pack-close')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('button.reveal-skip')).toBeVisible({ timeout: 15000 });
    expectTargets(await sizes(page, ['.pack-close', 'button.reveal-skip']), ['.pack-close', 'button.reveal-skip']);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
}

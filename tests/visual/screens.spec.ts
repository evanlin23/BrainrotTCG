import { test, expect, type Page } from '@playwright/test';
import { GROUPED_TOAST_MS, TOAST_MS } from '../../src/constants/config';
import { monitor, expectDecoded, expectPackDropped, expectSummaryTakesClicks } from '../browser/support';

/**
 * Reviewed screenshots of the core screens (#745): a new player's first pack, its summary, the share
 * sheet for that pull and the Cards page it fills, at a phone width (Pixel 5 emulation at scale 1,
 * not a real phone) and on desktop. Run in the pinned container only (playwright.visual.config.ts).
 *
 * An image only says the screen looks as it did when someone last approved it. The browser specs
 * still own behaviour: what is focused, hit or announced, and how the layout reflows.
 *
 * Every wait is for a state the page reports (a role, a decoded image, a computed style, a settled
 * attribute), then toHaveScreenshot takes shots until two in a row agree before comparing.
 *
 * The first pack's toasts are left out: they leave on their own timers, so a shot with one up would
 * depend on how fast the runner is. The summary is shot once both have gone (a state, waited for
 * like any other), and toast-clearance.spec.ts checks what they cover.
 */

/**
 * A fixed noon for Date, so a date the screens print is the same every run. Timers and animation
 * frames stay real: with them faked, a jump past a toast's timer leaves Motion's exit animation
 * stuck, so a fake clock can't run the toasts out.
 */
const NOW = new Date('2026-06-15T12:00:00Z');

/** Waits out the first pack's toasts: the grouped unlocks, then the level-up, each on its own timer. */
async function waitOutToasts(page: Page) {
  const toast = page.locator('.toast');
  await expect(toast).toContainText('achievements unlocked');
  // Bounded by the two toasts' own times plus a margin; it ends as soon as the second has gone.
  await expect(toast).toHaveCount(0, { timeout: GROUPED_TOAST_MS + TOAST_MS + 10_000 });
}

/** Every webfont the page asked for has loaded, so no shot is taken with a fallback face. */
const fontsLoaded = (page: Page) => page.evaluate(async () => {
  await document.fonts.ready;
  let pending = 0;
  document.fonts.forEach((font) => { if (font.status !== 'unloaded' && font.status !== 'loaded') pending += 1; });
  return pending;
});

test('a new player\'s first pack, its summary, the share sheet and the Cards page', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const errors = await monitor(page, baseURL!);
  await page.clock.setFixedTime(NOW);
  await page.goto('./');

  const packShell = page.getByRole('button', { name: /^Open pack/ });
  await expect(packShell).toBeVisible();
  await expectPackDropped(page);
  await expectDecoded(page.locator('.pack-display img'), await page.locator('.pack-display img').count());
  expect(await fontsLoaded(page)).toBe(0);
  await expect.soft(page).toHaveScreenshot('first-pack.png');

  await packShell.focus();
  await page.keyboard.press('Space');
  // By keyboard, so the pointer never rests where a toast lands: one under it would stay up.
  await page.locator('button.reveal-skip').focus({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30_000 });
  await expectDecoded(page.locator('.summary-cards img'), 5);
  await expectSummaryTakesClicks(page);
  await waitOutToasts(page);
  expect(await fontsLoaded(page)).toBe(0);
  await expect.soft(page).toHaveScreenshot('summary.png');

  await page.locator('.summary-actions').getByRole('button', { name: 'Share', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Share your pull', exact: true });
  await expect(sheet.locator('.sheet--deferred')).toHaveCount(0);
  const shared = sheet.getByRole('img', { name: "The image you'll share", exact: true });
  await expectDecoded(shared, 1);
  expect(await fontsLoaded(page)).toBe(0);
  await expect.soft(page).toHaveScreenshot('share-sheet.png');

  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.goto('./#/cards');
  const cards = page.getByRole('main', { name: 'Cards', exact: true });
  await expect(cards.locator('.page-skeleton')).toHaveCount(0);
  await expect(cards.getByRole('button', { name: /, \d+ owned/ }).first()).toBeVisible();
  const art = cards.locator('img');
  await expectDecoded(art, await art.count());
  expect(await fontsLoaded(page)).toBe(0);
  await expect.soft(page).toHaveScreenshot('cards.png');

  expect(errors).toEqual([]);
});

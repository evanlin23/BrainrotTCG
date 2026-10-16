import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor, expectDecoded, fingerFor, type Finger } from './support';

// A short swipe along the tear line opens the pack when it's released (#312). The phone project
// swipes with touch events in Pixel 5 emulation, which is not a real phone.

/** Opens the app and returns the sealed pack, scrolled into view with its art loaded. */
async function sealedPack(page: Page) {
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.getByRole('button', { name: /^Open a .* pack$/ });
  await expectDecoded(packShell.locator('img'), 2);
  await packShell.scrollIntoViewIfNeeded();
  return packShell;
}

/**
 * Presses the tear line at the first fraction of the pack's width, moves through the rest in small
 * steps, and checks the stroke is still cutting, not yet torn, before it's released.
 */
async function swipeTearLine(page: Page, packShell: Locator, finger: Finger, ...across: number[]) {
  const box = (await packShell.boundingBox())!;
  const y = box.y + box.height * 0.19;
  const xAt = (fraction: number) => box.x + box.width * fraction;
  // The press must land on the pack itself: its top bar can sit over the tear line on a phone.
  const onPack = await page.evaluate(([x, py]) => !!document.elementFromPoint(x, py)?.closest('.pack-shell'), [xAt(across[0]), y]);
  expect(onPack, 'the swipe starts on the pack').toBe(true);

  await finger.press(xAt(across[0]), y);
  for (let leg = 1; leg < across.length; leg++) {
    for (let step = 1; step <= 6; step++) {
      await finger.move(xAt(across[leg - 1] + ((across[leg] - across[leg - 1]) * step) / 6), y);
    }
  }
  await expect(packShell).toHaveClass(/\bis-cutting\b/);
  await expect(packShell).not.toHaveClass(/\bis-cut\b/);
  await finger.release();
}

test('a 30% swipe along the tear line opens the pack on release', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const packShell = await sealedPack(page);
  await swipeTearLine(page, packShell, await fingerFor(page, hasTouch), 0.35, 0.65);
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
});

test('a swipe that goes over and comes back opens the pack on release', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const packShell = await sealedPack(page);
  await swipeTearLine(page, packShell, await fingerFor(page, hasTouch), 0.3, 0.55, 0.3);
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
});

import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor, expectDecoded, fingerFor, type Finger } from './support';

// A short swipe along the tear line opens the pack when it's released (#312). The phone project
// swipes with touch events in Pixel 5 emulation, which is not a real phone.

/** Opens the app and returns the sealed pack, scrolled into view with its art loaded. */
async function sealedPack(page: Page) {
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.locator('.pack-shell');
  await expectDecoded(packShell.locator('img'), 2);
  await packShell.scrollIntoViewIfNeeded();
  return packShell;
}

/**
 * Presses the tear line at the first fraction of the pack's width, moves through the rest in small
 * steps, and checks the stroke is still cutting, not yet torn, before it's released. The full swipes
 * below span 29% of the pack's width: past RELEASE_CUT_RATIO (20%) so release tears it, and short of
 * DRAG_CUT_RATIO (never under 30%) so the stroke is still cutting, not torn, until then.
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
  await swipeTearLine(page, packShell, await fingerFor(page, hasTouch), 0.35, 0.64);
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

test('a tap on the tear line pulses the swipe hint, then a swipe still opens (#485)', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const packShell = await sealedPack(page);
  const box = (await packShell.boundingBox())!;
  const finger = await fingerFor(page, hasTouch);
  await finger.press(box.x + box.width / 2, box.y + box.height * 0.19);
  await finger.release();
  await expect(packShell).toHaveClass(/\bis-tapped\b/);
  await expect(packShell).not.toHaveClass(/\bis-cut\b/);
  await swipeTearLine(page, packShell, finger, 0.35, 0.64);
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
});

interface SeamSeen { cutting: boolean; line: boolean; spark: boolean }
type SeamWindow = Window & { seamSeen?: SeamSeen };

/** Records whether the pack ever shows a cut in progress: the cutting state, the seam or a spark. */
async function watchForCut(packShell: Locator) {
  await packShell.evaluate((shell) => {
    const seen: SeamSeen = { cutting: false, line: false, spark: false };
    (window as SeamWindow).seamSeen = seen;
    new MutationObserver(() => {
      seen.cutting ||= shell.classList.contains('is-cutting');
      seen.line ||= !!shell.querySelector('.cut-line-svg, .cut-line');
      seen.spark ||= !!shell.querySelector('.drag-spark');
    }).observe(shell, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  });
}

/** Checks a gesture drew nothing and left the pack sealed. */
async function expectNoCut(page: Page, packShell: Locator) {
  // Long enough for a release that would open the pack to have started the tear.
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as SeamWindow).seamSeen)).toEqual({ cutting: false, line: false, spark: false });
  await expect(packShell).not.toHaveClass(/\bis-cut\b/);
  await expect(page.locator('.card-reveal-area')).toHaveCount(0);
}

// Gestures that aren't a swipe along the seam never cut or draw (#267), at a phone's size. Desktop
// drives them with a mouse, the phone project with touch.
test.describe('at a phone size', () => {
  test.use({ viewport: { width: 393, height: 727 } });

  test('a drag down from the tear line neither cuts nor draws', async ({ page, baseURL, hasTouch }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    const packShell = await sealedPack(page);
    const box = (await packShell.boundingBox())!;
    const x = box.x + box.width * 0.5;
    const y = box.y + box.height * 0.19;
    const onPack = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('.pack-shell'), [x, y]);
    expect(onPack, 'the drag starts on the pack').toBe(true);
    await watchForCut(packShell);

    const finger = await fingerFor(page, hasTouch);
    await finger.press(x, y);
    // Down the pack with a little sideways drift, as a thumb scrolling would.
    for (let step = 1; step <= 6; step++) await finger.move(x + step * 2, y + step * 20);
    await finger.release();
    await expectNoCut(page, packShell);

    // The pack still opens with a real swipe.
    await swipeTearLine(page, packShell, finger, 0.35, 0.64);
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  });

  test('a swipe that starts off the tear line neither cuts nor draws, even when it reaches it', async ({ page, baseURL, hasTouch }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    const packShell = await sealedPack(page);
    const box = (await packShell.boundingBox())!;
    const xAt = (fraction: number) => box.x + box.width * fraction;
    const tearY = box.y + box.height * 0.19;
    // Further below the tear line than its widest tolerance (52px), on the art.
    const startY = tearY + 80;
    const onPack = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('.pack-shell'), [xAt(0.15), startY]);
    expect(onPack, 'the swipe starts on the pack').toBe(true);
    await watchForCut(packShell);

    const finger = await fingerFor(page, hasTouch);
    await finger.press(xAt(0.15), startY);
    // The press missed the seam, so the pack shows where to swipe.
    await expect(packShell).toHaveClass(/\bis-nudged\b/);
    // Plainly across, rising onto the tear line by the end.
    for (let step = 1; step <= 8; step++) await finger.move(xAt(0.15 + (0.7 * step) / 8), startY + ((tearY - startY) * step) / 8);
    await finger.release();
    await expectNoCut(page, packShell);

    await swipeTearLine(page, packShell, finger, 0.35, 0.64);
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  });
});

import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectDecoded, expectRecordedPack, fingerFor, monitor, snapshot, untilIdle } from './support';

// The page goes to the background and comes back, or the window resizes, in the middle of opening a
// pack (#186). Nothing goes blank, nothing opens by itself, and a pack that was being opened still
// finishes and saves once. Headless Chromium never hides its page, so the test sets the page's
// visibility and sends the events a phone sends when the app is switched away and back.

/** Sends what a tab switch or app switch sends: blur, hidden and pagehide, then the way back. */
async function background(page: Page) {
  await page.evaluate(() => {
    const set = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    window.dispatchEvent(new Event('blur'));
    set('hidden');
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    set('visible');
    window.dispatchEvent(new Event('focus'));
  });
}

/** Turns the window to a small phone and back, as a rotation or a split screen would. */
async function resize(page: Page) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 568 });
  // The header hides while a pack is open, so the app itself is what must still show.
  await expect(page.locator('.app')).toBeVisible();
  await page.setViewportSize(size);
}

async function sealedPack(page: Page) {
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.locator('.pack-shell');
  await expectDecoded(packShell.locator('img'), 2);
  await packShell.scrollIntoViewIfNeeded();
  return packShell;
}

const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });

/** Still sealed: the pack and its button show, no reveal started and nothing was saved. */
async function expectSealed(page: Page, packShell: Locator) {
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(packShell).toBeVisible();
  await expect(packShell).not.toHaveClass(/\bis-cut\b/);
  await expect(openPack(page)).toBeEnabled();
  await expect(page.locator('.card-reveal-area')).toHaveCount(0);
  expect((await snapshot(page)).history).toBeNull();
}

/** Opens the pack with a swipe along its tear line, from 35% to 65% of its width. */
async function swipeOpen(page: Page, packShell: Locator, hasTouch: boolean) {
  const box = (await packShell.boundingBox())!;
  const y = box.y + box.height * 0.19;
  const finger = await fingerFor(page, hasTouch);
  await finger.press(box.x + box.width * 0.35, y);
  for (let step = 1; step <= 6; step++) await finger.move(box.x + box.width * (0.35 + 0.05 * step), y);
  await finger.release();
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
}

test('a sealed pack stays sealed through a trip to the background and a resize', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const packShell = await sealedPack(page);
  await background(page);
  await resize(page);
  await background(page);
  // An automatic open would have started by the time the page is idle (#374 removed it).
  await untilIdle(page);
  await expectSealed(page, packShell);
  // The pack measures itself again after the resize, so a swipe still opens it.
  await packShell.scrollIntoViewIfNeeded();
  await swipeOpen(page, packShell, hasTouch);
  expect(errors).toEqual([]);
});

test('a swipe cut off by the background leaves the pack sealed, and the next swipe opens it', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const packShell = await sealedPack(page);
  const box = (await packShell.boundingBox())!;
  const y = box.y + box.height * 0.19;
  const finger = await fingerFor(page, hasTouch);
  await finger.press(box.x + box.width * 0.35, y);
  for (let step = 1; step <= 3; step++) await finger.move(box.x + box.width * (0.35 + 0.05 * step), y);
  await expect(packShell).toHaveClass(/\bis-cutting\b/);
  await background(page);
  await expect(packShell).not.toHaveClass(/\bis-cutting\b/);
  // The finger finishes its stroke and lifts after the app came back: the stroke was ended, so no cut.
  for (let step = 4; step <= 6; step++) await finger.move(box.x + box.width * (0.35 + 0.05 * step), y);
  await finger.release();
  await untilIdle(page);
  await expectSealed(page, packShell);
  await swipeOpen(page, packShell, hasTouch);
  expect(errors).toEqual([]);
});

test('an opening pack keeps its card through the background and a resize, then saves once', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await sealedPack(page);
  await openPack(page).click();
  const count = page.locator('.pack-top-count');
  await expect(count).toHaveText('Card 1 of 5', { timeout: 15000 });
  await background(page);
  await resize(page);
  await background(page);
  await untilIdle(page);
  // Not blank, and not moved on by itself: the same card is up and on screen.
  await expect(count).toHaveText('Card 1 of 5');
  await expect(page.locator('.reveal-card')).toBeInViewport();
  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await background(page);
  await expect(page.locator('.summary-card')).toHaveCount(5);
  await expectRecordedPack(page);
  expect(errors).toEqual([]);
});

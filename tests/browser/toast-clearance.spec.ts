import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * Toasts and the pack's X (#614): on a phone, focus mode hides the header, so the toast region used to
 * sit over the "Back to packs" X on the summary and take its press (a tap opened Profile). A fresh
 * player's first pack queues a grouped-achievements toast and then a level-up; with one still up, the
 * X is the element at its own centre and a tap on it goes back to packs. Phone emulation (touch,
 * Chromium), not a physical phone.
 */

const PHONES = [{ width: 360, height: 640 }, { width: 390, height: 844 }];

test.skip(({ isMobile }) => !isMobile, 'phone widths only');

async function toSummaryWithToast(page: Page, baseURL: string) {
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expect(page.locator('.toast')).toBeVisible({ timeout: 15000 });
  return errors;
}

/** The X's rectangle and what a touch at its centre would hit, measured while the toast is up. */
const measure = (page: Page) => page.evaluate(() => {
  const close = document.querySelector('.pack-close')!.getBoundingClientRect();
  const toast = document.querySelector('.toast')!.getBoundingClientRect();
  const at = document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2);
  return {
    hit: at?.closest('.pack-close') ? 'close' : (at?.closest('.toast') ? 'toast' : (at?.className ?? 'nothing')),
    overlaps: toast.left < close.right && toast.right > close.left && toast.top < close.bottom && toast.bottom > close.top,
    toastTop: toast.top,
    closeBottom: close.bottom,
  };
});

for (const viewport of PHONES) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`the summary's X stays reachable under a toast at ${viewport.width}px, ${reducedMotion === 'reduce' ? 'reduced' : 'normal'} motion`, async ({ page, baseURL }) => {
      test.setTimeout(120000);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion });
      const errors = await toSummaryWithToast(page, baseURL!);

      // While each toast is still up (never waiting for it to expire): clear of the X, which takes the touch.
      // The grouped achievements come first, then the level-up.
      for (const kicker of [/achievements? unlocked/i, /^Level up$/]) {
        await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 30000 });
        const seen = await measure(page);
        expect(seen.hit).toBe('close');
        expect(seen.overlaps).toBe(false);
        expect(seen.toastTop).toBeGreaterThanOrEqual(seen.closeBottom);
      }
      const close = await page.locator('.pack-close').boundingBox();
      await page.touchscreen.tap(close!.x + close!.width / 2, close!.y + close!.height / 2);

      // Back to packs, not Profile.
      await expect(page.getByRole('button', { name: /^Open pack/ })).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.profile-section')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}

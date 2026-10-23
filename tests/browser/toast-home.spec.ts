import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * The achievement toast on the home screen (#803). The first visit back after a pack's summary still has
 * the toast up, and it used to hang over the set picker, so a tap meant for a set step opened Profile
 * instead. The home screen fills the viewport, so the toast takes a row of its own: with it up, nothing
 * the player can press is under it, and the centre of each control still reaches that control. Held by
 * focus (a focused toast never expires), so no step races its timer.
 */

const VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

/** Every control on the home screen, as the page lays it out. */
const CONTROLS = ['.set-step', '.set-current', '.pack-shell', '.card-guide-link', '.app-utilities button', '.app-nav-item'];

/** The controls the toast overlaps, and those whose centre a touch would hand to something else. */
const blocked = (page: Page) => page.evaluate((selectors) => {
  const toast = document.querySelector('.toast')!.getBoundingClientRect();
  const problems: string[] = [];
  for (const selector of selectors) {
    for (const [index, el] of Array.from(document.querySelectorAll(selector)).entries()) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const label = `${selector}[${index}]`;
      if (toast.left < box.right && toast.right > box.left && toast.top < box.bottom && toast.bottom > box.top) problems.push(`${label} is under the toast`);
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!at || !el.contains(at)) problems.push(`${label} loses its centre to ${at?.closest('.toast') ? 'the toast' : at?.className}`);
    }
  }
  return problems;
}, CONTROLS);

for (const viewport of VIEWPORTS) {
  test(`a toast on the home screen covers no control at ${viewport.width}px`, async ({ page, baseURL }) => {
    test.setTimeout(90000);
    await page.setViewportSize(viewport);
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await page.getByRole('button', { name: /^Open pack/ }).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
    await page.locator('button.reveal-skip').click({ timeout: 15000 });
    await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
    // The toast from the summary is still up on the way home.
    await page.getByRole('button', { name: /Next pack/ }).click();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.set-current')).toBeVisible();
    await toast.focus();

    await expect.poll(() => blocked(page), { message: 'no control is under the toast' }).toEqual([]);
    expect(errors).toEqual([]);
  });
}

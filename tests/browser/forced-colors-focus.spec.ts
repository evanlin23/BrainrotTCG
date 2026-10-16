import { test, expect } from '@playwright/test';
import { monitor } from './support';

// Forced colours (Windows High Contrast) drop box-shadows, so the shared focus ring would vanish.
// Every control also carries a transparent outline, which forced colours paint in a system colour
// (#312 S5). Tab through the pack screen and check each stop shows a real outline.
test.use({ forcedColors: 'active' });

test('shows a visible focus outline on every Tab stop of the pack screen in forced colours', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A keyboard check; the desktop project has the keyboard.');
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const pack = page.getByRole('button', { name: /^Open a .* pack$/ });
  await expect(pack).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);

  const stops: string[] = [];
  for (let tab = 0; tab < 40 && !(await pack.evaluate((el) => el === document.activeElement)); tab++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || !el.matches(':focus-visible')) return null;
      const style = getComputedStyle(el);
      return {
        name: `${el.tagName.toLowerCase()}.${el.className}: ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}`,
        style: style.outlineStyle,
        width: parseFloat(style.outlineWidth),
        color: style.outlineColor,
      };
    });
    if (!focused) continue;
    stops.push(focused.name);
    expect(focused.style, focused.name).not.toBe('none');
    expect(focused.width, focused.name).toBeGreaterThanOrEqual(2);
    expect(focused.color, focused.name).not.toMatch(/^(transparent|rgba\(\d+, \d+, \d+, 0\))$/);
  }
  // The walk reached the pack through the header, nav and set picker, not one lucky stop.
  await expect(pack).toBeFocused();
  expect(stops.length).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

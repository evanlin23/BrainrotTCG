import { test, expect } from '@playwright/test';
import { expectPackDropped } from './support';

// On a desktop window the pack stage starts on a whole pixel. The header above it is as tall as the logo,
// and the logo's size follows the window's width; where that came to a half pixel (85.5px at 1280 wide),
// the stage's fade painted its contents rounded up on one run and down on the next, so the first-pack
// screenshots never repeated (#1129). These widths cover the logo's ramp (900px to about 1060px at the
// default 16px text, then 18px text from 1024px) and its full size, on tall and short windows.
const WINDOWS = [
  { width: 1280, height: 800 },
  { width: 1100, height: 800 },
  { width: 1152, height: 800 },
  { width: 1192, height: 800 },
  { width: 1024, height: 600 },
  { width: 1440, height: 900 },
];

for (const size of WINDOWS) {
  test(`the pack stage starts on a whole pixel at ${size.width}x${size.height} (#1129)`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'A desktop window check; the desktop-chromium project runs it.');
    await page.setViewportSize(size);
    await page.goto('./');
    await expectPackDropped(page);
    const top = await page.locator('.pack-display').evaluate((el) => el.getBoundingClientRect().top);
    expect(top).toBe(Math.round(top));
  });
}

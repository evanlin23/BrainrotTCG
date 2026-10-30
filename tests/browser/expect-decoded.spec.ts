import { test, expect } from '@playwright/test';
import { expectDecoded } from './support';

test.describe('expectDecoded (#1314)', () => {
  test('resolves when img.decode() hangs but element is complete with naturalWidth > 0', async ({ page }) => {
    await page.setContent(`
      <div id="container">
        <img data-state="ready" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>" />
      </div>
    `);

    // Override img.decode to simulate WebKit hang (never resolving promise)
    await page.evaluate(() => {
      const img = document.querySelector('img')!;
      img.decode = () => new Promise(() => {}); // never resolves
    });

    const start = Date.now();
    await expectDecoded(page.locator('#container img'), 1, { timeout: 500 });
    const elapsed = Date.now() - start;

    // Resolves via fallback within the bounded limit instead of hanging until test timeout
    expect(elapsed).toBeLessThan(2500);
  });

  test('fails fast when decode hangs and fallback check fails', async ({ page }) => {
    await page.setContent(`
      <div id="container">
        <img data-state="ready" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>" />
      </div>
    `);

    // Allow poll to pass, then simulate decode hang with failed fallback check
    await page.evaluate(() => {
      const img = document.querySelector('img')!;
      img.decode = () => {
        Object.defineProperty(img, 'naturalWidth', { get: () => 0 });
        return new Promise(() => {});
      };
    });

    await expect(
      expectDecoded(page.locator('#container img'), 1, { timeout: 500 }),
    ).rejects.toThrow(/Image decode failed/);
  });
});

import { test, expect } from '@playwright/test';
import { expectDecoded } from './support';

test.describe('expectDecoded (#1314)', () => {
  test('resolves on timeout fallback when img.decode() hangs but element is complete', async ({ page }) => {
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

    await expectDecoded(page.locator('#container img'), 1, { timeout: 300 });

    // Verifies the timeout fallback fired and logged an annotation
    expect(test.info().annotations.some((a) => a.type === 'img-decode-timeout')).toBe(true);
  });

  test('rethrows when img.decode() rejects with an error', async ({ page }) => {
    await page.setContent(`
      <div id="container">
        <img data-state="ready" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>" />
      </div>
    `);

    // Allow poll to pass, then simulate decode rejection
    await page.evaluate(() => {
      const img = document.querySelector('img')!;
      img.decode = () => Promise.reject(new DOMException('Corrupt image bytes', 'EncodingError'));
    });

    await expect(
      expectDecoded(page.locator('#container img'), 1, { timeout: 300 }),
    ).rejects.toThrow(/Image decode failed: Corrupt image bytes.*data: placeholder/);
  });

  test('fails when decode times out and fallback check fails', async ({ page }) => {
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
      expectDecoded(page.locator('#container img'), 1, { timeout: 300 }),
    ).rejects.toThrow(/Image decode failed/);
  });
});

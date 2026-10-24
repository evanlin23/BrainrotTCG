import { test, expect } from '@playwright/test';
import { untilIdle } from './support';

// requestIdleCallback is never promised to run without a deadline: Chromium grants idle time only
// between frames. The packs screen animates for good, and on a loaded machine its frames come back to
// back, so the idle step of `untilIdle` starved for a minute and hung pack-exit.spec's first test after
// a Forward. This keeps every frame's work longer than a frame, so no idle period ever opens; without
// the deadline the wait never returns and the test times out.
test.setTimeout(20000);

test('untilIdle returns in a page whose frames never leave idle time', async ({ page }) => {
  await page.setContent('<style>@keyframes spin { to { transform: rotate(1turn); } }</style><div style="animation: spin 1s linear infinite">x</div>');
  await page.evaluate(() => {
    const burn = () => {
      const end = performance.now() + 40;
      while (performance.now() < end) { /* hold the frame */ }
      requestAnimationFrame(burn);
    };
    requestAnimationFrame(burn);
  });
  await untilIdle(page);
});

test('untilIdle returns in a quiet page', async ({ page }) => {
  await page.setContent('<p>quiet</p>');
  await untilIdle(page);
  expect(await page.evaluate(() => document.body.textContent)).toBe('quiet');
});

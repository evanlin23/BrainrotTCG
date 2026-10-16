import { test, expect, type Page } from '@playwright/test';
import { expectRecordedPack, monitor } from './support';

/**
 * The pack's real controls (#312 S4): an Open pack button under the pack opens it like a finished
 * swipe, the pack itself is no longer a fake button, a keyboard alone gets from the page's load to
 * the summary with focus always on the stage's control, and at 200% text on a 320x568 phone the
 * dealt card keeps a usable stage. 200% text is emulated by doubling the root font size the rem
 * tokens use.
 */

const openPack = (page: Page) => page.getByRole('button', { name: 'Open pack', exact: true });

/** Samples, every frame from now on, whether focus has fallen back to the page's body. */
async function watchFocus(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { lostFocus: string[] };
    w.lostFocus = [];
    const sample = () => {
      if (document.activeElement === document.body || !document.activeElement) {
        w.lostFocus.push(document.querySelector('.pack-summary') ? 'summary' : document.querySelector('.card-reveal-area') ? 'reveal' : 'pack');
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  return () => page.evaluate(() => (window as unknown as { lostFocus: string[] }).lostFocus);
}

test('clicking Open pack opens the pack through the same reveal and save as a swipe', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  // The pack is a picture and a gesture surface, not a fake button; the button under it is real.
  const shell = page.locator('.pack-shell');
  await expect(shell).toBeVisible();
  expect(await shell.evaluate((el) => [el.getAttribute('role'), el.getAttribute('tabindex'), el.getAttribute('aria-label')])).toEqual([null, null, null]);
  await expect(openPack(page)).toBeVisible();
  await expect(openPack(page)).toBeEnabled();

  await openPack(page).click();
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
  await expect(page.locator('.reveal-card:focus')).toHaveAttribute('aria-label', 'Flip card 1 of 5');

  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectRecordedPack(page);
  expect(errors).toEqual([]);
});

test('a keyboard alone goes from the page\'s load to the summary, and focus never falls to the page', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  const button = openPack(page);
  await expect(button).toBeVisible();
  let tabs = 0;
  while (!(await button.evaluate((el) => el === document.activeElement))) {
    expect(++tabs, 'Tab never reached the Open pack button').toBeLessThan(40);
    await page.keyboard.press('Tab');
  }
  const lostFocus = await watchFocus(page);

  // Enter on the button opens it; Space flips each card and Enter moves on.
  await page.keyboard.press('Enter');
  const card = page.locator('.reveal-card:focus');
  const live = page.locator('.sr-only[aria-live="polite"]');
  for (let n = 1; n <= 5; n++) {
    await expect(card).toHaveAttribute('aria-label', `Flip card ${n} of 5`, { timeout: 15000 });
    await page.keyboard.press('Space');
    await expect(card).toHaveAttribute('aria-label', new RegExp(`Card ${n} of 5: `), { timeout: 10000 });
    // One polite region speaks for every stage.
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText(new RegExp(`^Card ${n} of 5: `));
    await page.keyboard.press('Enter');
  }

  // The summary's heading takes focus, so the next Tab starts from the result.
  await expect(page.locator('.summary-title')).toBeFocused({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5);
  expect(await lostFocus(), 'focus fell to the page during these stages').toEqual([]);
  expect(errors).toEqual([]);
});

test('at 200% text on a 320x568 phone the dealt card keeps a usable stage', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 320, height: 568 });
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });

  const button = openPack(page);
  await expect(button).toBeInViewport();
  await button.focus();
  await page.keyboard.press('Space');
  const card = page.locator('.reveal-card:focus');
  await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
  await expect(card).toBeVisible();

  const boxes = await page.evaluate(() => {
    const box = (selector: string) => {
      const { top, bottom, left, right, height, width } = document.querySelector(selector)!.getBoundingClientRect();
      return { top, bottom, left, right, height, width };
    };
    return { stage: box('.active-card-container'), card: box('.reveal-card') };
  });
  // Was 0px tall: the rows around the card took the whole stage (#312).
  expect(boxes.stage.height, JSON.stringify(boxes)).toBeGreaterThan(0);
  // Big enough to see and press: several touch targets tall, inside the stage and the screen.
  expect(boxes.card.height, JSON.stringify(boxes)).toBeGreaterThanOrEqual(3 * 44);
  expect(boxes.card.top).toBeGreaterThanOrEqual(boxes.stage.top - 1);
  expect(boxes.card.bottom).toBeLessThanOrEqual(boxes.stage.bottom + 1);
  expect(boxes.card.left).toBeGreaterThanOrEqual(0);
  expect(boxes.card.right).toBeLessThanOrEqual(320);
  expect(boxes.card.bottom).toBeLessThanOrEqual(568);

  // The rows under it scroll into reach, and nothing runs off the side.
  await expect(page.locator('button.reveal-skip')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('aria-label', /^Next card\. Card 1 of 5: /, { timeout: 10000 });
  expect(errors).toEqual([]);
});

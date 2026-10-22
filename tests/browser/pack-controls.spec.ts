import { test, expect, type Page } from '@playwright/test';
import { expectRecordedPack, fingerFor, monitor, snapshot } from './support';

/**
 * The pack's one control (#312 S4, #628): the pack itself is a button named "Open pack, {set}", and a
 * tap, a click, Space or Enter with focus on it open it like a finished swipe; Space or Enter anywhere
 * else never does. A keyboard alone gets from the page's load to the summary with focus always on the
 * stage's control, and at 200% text on a 320x568 phone the dealt card keeps a usable stage. 200% text
 * is emulated by doubling the root font size the rem tokens use.
 */

const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });

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

  // The pack is the one control, named for its set, with no second Open pack button beside it.
  const shell = page.locator('.pack-shell');
  await expect(shell).toBeVisible();
  expect(await shell.evaluate((el) => [el.getAttribute('role'), el.getAttribute('tabindex'), el.getAttribute('aria-label')])).toEqual(['button', '0', expect.stringMatching(/^Open pack, .+/)]);
  await expect(openPack(page)).toHaveCount(1);
  await expect(openPack(page)).toBeVisible();
  await expect(openPack(page)).toBeEnabled();
  await expect(page.locator('main button')).toHaveCount(0);

  await openPack(page).click();
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
  await expect(page.locator('.reveal-card:focus')).toHaveAttribute('aria-label', 'Flip card 1 of 5');

  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectRecordedPack(page);
  expect(errors).toEqual([]);
});

test('clicks piling up on the pack open it once and spend one pack', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const pack = openPack(page);
  await expect(pack).toBeVisible();

  // Three clicks in one task, as a held-down or hammered click lands: one opening, not three.
  await pack.evaluate((el) => {
    const control = el as HTMLElement;
    control.click();
    control.click();
    control.click();
  });
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectRecordedPack(page);
  expect(errors).toEqual([]);
});

test('Space and Enter open the pack only with focus on it, never from the page around it', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const pack = openPack(page);
  await expect(pack).toBeVisible();

  // Focus on the page itself: both keys are the page's own, and the pack stays sealed.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await expect(pack).toHaveAttribute('aria-label', /^Open pack, /);
  await expect(page.locator('.pack-shell.is-cut')).toHaveCount(0);

  // With focus on the pack, one press opens it once.
  await pack.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
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
    expect(++tabs, 'Tab never reached the pack').toBeLessThan(40);
    await page.keyboard.press('Tab');
  }
  const lostFocus = await watchFocus(page);

  // Enter on the pack opens it; Space flips each card and Enter moves on.
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

test('a drag that ends where it began never opens the pack, but a click on it still does', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const shell = page.locator('.pack-shell');
  await expect(shell).toBeVisible();

  // Pressed below the start band, so the swipe cuts nothing, dragged well past a tap and back to
  // where it began: the release is a tap by position alone, but the finger was no tap.
  const box = (await shell.boundingBox())!;
  const x = box.x + box.width * 0.4;
  const y = box.y + box.height * 0.7;
  const finger = await fingerFor(page, hasTouch);
  await finger.press(x, y);
  for (let step = 1; step <= 4; step++) await finger.move(x + 20 * step, y);
  for (let step = 3; step >= 0; step--) await finger.move(x + 20 * step, y);
  await finger.release();
  await expect(shell).toHaveAttribute('aria-label', /^Open pack, /);
  await expect(page.locator('.pack-shell.is-cut')).toHaveCount(0);
  await expect(page.locator('.card-reveal-area')).toHaveCount(0);
  expect((await snapshot(page)).history).toBeNull();

  // The same spot, tapped, opens it.
  await finger.press(x, y);
  await finger.release();
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
  expect(errors).toEqual([]);
});

test('the pack\'s focus ring stays inside the pack and the screen', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const pack = openPack(page);
  await expect(pack).toBeVisible();
  for (let tabs = 0; !(await pack.evaluate((el) => el === document.activeElement)); tabs++) {
    expect(tabs, 'Tab never reached the pack').toBeLessThan(40);
    await page.keyboard.press('Tab');
  }

  // The ring is the pack's ::after, drawn inset from its edge; its outer edge is the inset less its spread.
  const ring = await pack.evaluate((el) => {
    const edge = el.getBoundingClientRect();
    const after = getComputedStyle(el, '::after');
    const spreads = Array.from(after.boxShadow.matchAll(/rgba?\([^)]*\) (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px/g), (m) => Number(m[4]));
    const out = Math.max(0, ...spreads) - Number.parseFloat(after.top);
    const display = el.closest('.pack-display')!.getBoundingClientRect();
    return {
      spreads, out,
      left: edge.left - out, right: edge.right + out, top: edge.top - out, bottom: edge.bottom + out,
      display: { left: display.left, right: display.right, top: display.top, bottom: display.bottom },
      viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
    };
  });
  expect(ring.spreads.length, JSON.stringify(ring)).toBeGreaterThan(0);
  // Both rects round to a fraction of a pixel.
  expect(ring.left, JSON.stringify(ring)).toBeGreaterThanOrEqual(Math.max(0, ring.display.left) - 0.5);
  expect(ring.right, JSON.stringify(ring)).toBeLessThanOrEqual(Math.min(ring.viewport.width, ring.display.right) + 0.5);
  expect(ring.top, JSON.stringify(ring)).toBeGreaterThanOrEqual(Math.max(0, ring.display.top) - 0.5);
  expect(ring.bottom, JSON.stringify(ring)).toBeLessThanOrEqual(Math.min(ring.viewport.height, ring.display.bottom) + 0.5);
  expect(errors).toEqual([]);
});

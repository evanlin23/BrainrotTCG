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

/**
 * Flips the first card, optionally at 320x568 with a 32px root font, and waits for the labels under it.
 * The wrapped rarity row must grow with its labels instead of painting over the provenance line (#799).
 */
async function revealFirstCard(page: Page, baseURL: string, largeText: boolean) {
  if (largeText) await page.setViewportSize({ width: 320, height: 568 });
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  if (largeText) await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await page.evaluate(() => document.fonts.ready);
  await openPack(page).focus();
  await page.keyboard.press('Space');
  const card = page.locator('.reveal-card:focus');
  await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('aria-label', /^Next card\. Card 1 of 5: /, { timeout: 10000 });
  await expect(page.locator('.reveal-rarity > *').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return errors;
}

/** The rarity row, each label in it and the provenance line, as boxes in the page's scroll space. */
const labelBoxes = (page: Page) => page.evaluate(() => {
  const rect = (el: Element) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { top: top + window.scrollY, bottom: bottom + window.scrollY };
  };
  const row = document.querySelector('.reveal-rarity')!;
  return {
    row: { ...rect(row), scrollHeight: row.scrollHeight, clientHeight: row.clientHeight },
    labels: Array.from(row.children).map((el) => ({ text: el.textContent, ...rect(el) })),
    provenance: rect(document.querySelector('.reveal-provenance')!),
  };
});

/** The row contains its labels, and none of them paints over the provenance line below. */
async function expectLabelsApart(page: Page) {
  await expect.poll(async () => {
    const { row, labels, provenance } = await labelBoxes(page);
    const overlapping = labels.filter((l) => l.bottom > provenance.top + 0.5 && l.top < provenance.bottom - 0.5).map((l) => l.text);
    const outside = labels.filter((l) => l.bottom > row.bottom + 0.5).map((l) => l.text);
    return { overlapping, outside, rowHoldsContent: row.scrollHeight <= row.clientHeight + 1, labels: labels.length > 0 };
  }, { timeout: 10000 }).toEqual({ overlapping: [], outside: [], rowHoldsContent: true, labels: true });
}

test('at 200% text on a 320x568 phone the revealed labels stay clear of the provenance line (#799)', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await revealFirstCard(page, baseURL!, true);
  await expectLabelsApart(page);
  // Scrolling to the rows under the card moves them together, so it neither repairs nor breaks the gap.
  await page.locator('.card-reveal-area').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expectLabelsApart(page);
  await expect(page.locator('button.reveal-skip')).toBeInViewport();
  expect(errors).toEqual([]);
});

test('a wrapped modifier and New badge still clear the provenance line at 200% text (#799)', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await revealFirstCard(page, baseURL!, true);
  // A pack is fixed by its ticket, so add the widest labels a card can carry (finish, misprint, New) to the row.
  await page.evaluate(() => {
    const row = document.querySelector('.reveal-rarity')!;
    for (const text of ['DIAMOND finish', 'Misprint', 'New']) {
      const label = row.firstElementChild!.cloneNode(true) as HTMLElement;
      label.textContent = text;
      row.appendChild(label);
    }
  });
  await expectLabelsApart(page);
  await page.locator('.card-reveal-area').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expectLabelsApart(page);
  expect(errors).toEqual([]);
});

test('at the default text size the revealed labels also clear the provenance line (#799 control)', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await revealFirstCard(page, baseURL!, false);
  await expectLabelsApart(page);
  expect(errors).toEqual([]);
});

test('the hint names the pack summary on the last card, and Space then opens it (#790)', async ({ page, baseURL, isMobile }) => {
  test.setTimeout(90000);
  // The phone project has a coarse pointer, so its hints are the touch wording; Space still drives it.
  const words = isMobile
    ? { flip: 'Tap card to flip', next: 'Swipe or tap for the next card', summary: 'Swipe or tap to see the pack summary' }
    : { flip: 'Click or press Space to flip', next: 'Click or press Space for the next card', summary: 'Click or press Space to see the pack summary' };
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await openPack(page).focus();
  await page.keyboard.press('Enter');
  const card = page.locator('.reveal-card:focus');
  const hint = page.locator('.tip-text');
  for (let n = 1; n <= 5; n++) {
    await expect(card).toHaveAttribute('aria-label', `Flip card ${n} of 5`, { timeout: 15000 });
    await expect(hint).toHaveText(words.flip);
    await page.keyboard.press('Space');
    await expect(card).toHaveAttribute('aria-label', new RegExp(`Card ${n} of 5: `), { timeout: 10000 });
    // A good pull holds the input for a moment ("Big pull!"); the hint then says what the press opens.
    await expect(hint).toHaveText(n < 5 ? words.next : words.summary, { timeout: 10000 });
    await page.keyboard.press('Space');
  }
  await expect(page.locator('.summary-title')).toBeFocused({ timeout: 15000 });
  expect(errors).toEqual([]);
});

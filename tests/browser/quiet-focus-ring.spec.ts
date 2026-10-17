import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor, expectDecoded, expectStill, fingerFor, type Finger } from './support';

/**
 * As a pack opens, the app moves focus by script: onto each card, then the result. Chromium rings
 * script focus that no click put there, and a phone's taps rarely focus anything, so a player opening
 * by touch or mouse saw a yellow ring round each card and took it for a selection (#312). The ring
 * stays for keyboard players who navigate: Tab, arrows, Home/End, Page keys and Escape set
 * data-input="keyboard" (components/ui/inputModality.ts). Space and Enter, which only drive the game,
 * set "press" and draw no yellow ring, but a keyboard player's control is never left with focus you
 * can't see: it wears a thin neutral outline (tokens.css --focus-outline-quiet, WCAG 2.4.7), and a
 * heading or note only script focuses wears nothing. Before any input it rings, for a screen reader or
 * switch that moves focus with no key the page hears.
 * The phone check is Chromium's touch emulation at a 390px phone size, not a real phone.
 */

/** The shared ring's outer edge (tokens.css --focus-ring). A rarity edge is 2px, never this. */
const RING = 'rgb(255, 210, 63) 0px 0px 0px 4px';
/** The quiet outline's colour (tokens.css --text-muted), on the controls Space or Enter left focused. */
const QUIET_OUTLINE = 'rgb(182, 176, 186)';

/** What an element shows as a ring: its outline and box-shadow, and its ::after's (the reveal card's ring). */
const ringOf = (target: Locator) => target.evaluate((el) => {
  const own = getComputedStyle(el);
  return {
    focusVisible: el.matches(':focus-visible'),
    input: document.documentElement.dataset.input,
    outline: own.outlineStyle,
    outlineColor: own.outlineColor,
    outlineWidth: own.outlineWidth,
    outlineOffset: own.outlineOffset,
    shadows: `${own.boxShadow} | ${getComputedStyle(el, '::after').boxShadow}`,
  };
});

async function expectNoRing(target: Locator, what: string, input = 'pointer') {
  const ring = await ringOf(target);
  expect(ring.input, `${what}: input`).toBe(input);
  expect(ring.outline, `${what}: outline`).toBe('none');
  expect(ring.shadows, `${what}: box-shadow`).not.toContain(RING);
  return ring;
}

/** The ring is there. Buttons ease their box-shadow in, so it's read once that has settled. */
async function expectRing(target: Locator, what: string, input = 'keyboard') {
  await expect.poll(async () => (await ringOf(target)).shadows, { message: what }).toContain(RING);
  expect(await ringOf(target), what).toMatchObject({ focusVisible: true, input });
}

/** A heading or note script focused after Space or Enter: not a control, so nothing shows. */
const expectNoRingAfterPress = (target: Locator, what: string) => expectNoRing(target, what, 'press');

/** A control left focused by Space or Enter: no yellow ring, but a thin neutral outline, so focus is never invisible. */
async function expectQuietOutlineAfterPress(target: Locator, what: string) {
  const ring = await ringOf(target);
  expect(ring, `${what}: focus`).toMatchObject({ focusVisible: true, input: 'press' });
  expect(ring.shadows, `${what}: box-shadow`).not.toContain(RING);
  expect(ring, `${what}: a neutral outline`).toMatchObject({
    outline: 'solid',
    outlineColor: QUIET_OUTLINE,
    outlineWidth: '2px',
    outlineOffset: '3px',
  });
  return ring;
}

const selectedText = (page: Page) => page.evaluate(() => document.getSelection()?.toString() ?? '');

/**
 * Before any input the page counts as keyboard, so script focus would ring; on the first-pack screen
 * nothing has focus yet, so no ring shows until the first press quiets it.
 */
async function expectNothingRingedAtBoot(page: Page) {
  expect(await page.evaluate(() => ({
    input: document.documentElement.dataset.input,
    focused: document.activeElement === document.body ? 'nothing' : document.activeElement?.outerHTML.slice(0, 80),
    ringed: document.querySelectorAll(':focus-visible').length,
  }))).toEqual({ input: 'keyboard', focused: 'nothing', ringed: 0 });
}

/** The fixture player at nonce 21, which deals no big pull to hold the reveal. Before monitor's own seed. */
const seedNonce21 = (page: Page, baseURL: string) => page.addInitScript((origin) => {
  if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
  localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 21, createdAt: 1 }));
  localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
}, new URL(baseURL).origin);

async function sealedPack(page: Page, baseURL: string) {
  await seedNonce21(page, baseURL);
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.locator('.pack-shell');
  await expectDecoded(packShell.locator('img'), 2);
  await packShell.scrollIntoViewIfNeeded();
  await expectStill(packShell, 'the pack stops moving');
  return { errors, packShell };
}

/** Tears the pack along its tear line. A swipe presses nothing focusable, so the card's focus is all script. */
async function swipeOpen(packShell: Locator, finger: Finger) {
  const box = (await packShell.boundingBox())!;
  const y = box.y + box.height * 0.19;
  await finger.press(box.x + box.width * 0.3, y);
  for (let step = 1; step <= 8; step++) await finger.move(box.x + box.width * (0.3 + (0.4 * step) / 8), y);
  await finger.release();
}

/** A long press low on the target, then a short drag, as a phone starts its own selections. */
async function longPressDrag(page: Page, finger: Finger, target: Locator) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.7;
  await finger.press(x, y);
  await page.waitForTimeout(800);
  for (let step = 1; step <= 5; step++) await finger.move(x + step * 6, y);
  await finger.release();
}

/** A quick sideways flick across the middle of the card, far enough to swipe a face-up card away. */
async function flick(finger: Finger, card: Locator) {
  const box = (await card.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.6;
  await finger.press(x, y);
  for (let step = 1; step <= 5; step++) await finger.move(x - step * 30, y);
  await finger.release();
}

/** A mouse drag from the target's text off its edge: how a mouse starts a selection, and no click. */
async function dragOff(finger: Finger, target: Locator) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.7;
  await finger.press(x, y);
  for (let step = 1; step <= 8; step++) await finger.move(x + ((box.width / 2 + 40) * step) / 8, y);
  await finger.release();
}

/** Flips and moves past all five cards with `press`, checking the focused card after each step. */
async function revealAll(page: Page, press: (card: Locator) => Promise<void>, check: (card: Locator, what: string) => Promise<unknown>) {
  const card = page.locator('.reveal-card:focus');
  for (let n = 1; n <= 5; n++) {
    await expect(card).toHaveAttribute('aria-label', `Flip card ${n} of 5`, { timeout: 15000 });
    await check(card, `card ${n}, face down`);
    await press(card);
    await expect(card).toHaveAttribute('aria-label', n < 5 ? /^Next card\. / : /^See the pack summary\. /, { timeout: 10000 });
    await check(card, `card ${n}, face up`);
    await press(card);
  }
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5);
}

/**
 * The card viewer hands focus back to the summary card that opened it, by script. On iOS a tap
 * focuses no button, so that is the case Chromium rings here: script focus after script focus.
 */
async function scriptFocus(target: Locator) {
  await target.evaluate((el: HTMLElement) => el.focus());
  await expect(target).toBeFocused();
}

test.describe('opened by touch, 390px phone emulation', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('no ring on the cards, the pack or the result, and a long press selects nothing', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone check; the phone project runs it.');
    test.setTimeout(90000);
    const { errors, packShell } = await sealedPack(page, baseURL!);
    const finger = await fingerFor(page, true);
    await expectNothingRingedAtBoot(page);

    // The swipe is the first press: from it on the page counts as pointer, and card 1's script focus is quiet.
    await swipeOpen(packShell, finger);
    const card = page.locator('.reveal-card:focus');
    await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
    // The case the phone showed: Chromium counts this focus as visible, and only the CSS keeps it quiet.
    expect((await expectNoRing(card, 'card 1')).focusVisible).toBe(true);
    await longPressDrag(page, finger, card);
    expect(await selectedText(page)).toBe('');

    await revealAll(page, (target) => target.tap(), expectNoRing);
    const title = page.locator('.summary-title');
    await expectNoRing(title, 'the result');
    const summaryCard = page.locator('.summary-card').first();
    await scriptFocus(summaryCard);
    expect((await expectNoRing(summaryCard, 'a summary card')).focusVisible).toBe(true);
    await longPressDrag(page, finger, summaryCard);
    expect(await selectedText(page)).toBe('');
    expect(errors).toEqual([]);
  });

  // Chromium flings a sideways flick even where the card lets the page pan only up and down, and spent
  // the next tap stopping that fling, so the card never saw it (#504). A swipe's own click guard ate the
  // next card's tap too. Both taps here come as soon as the card is there.
  test('a tap right after a flick on the face-down card, or right after a swipe, still flips it', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone check; the phone project runs it.');
    test.setTimeout(60000);
    const { errors, packShell } = await sealedPack(page, baseURL!);
    const finger = await fingerFor(page, true);
    await swipeOpen(packShell, finger);
    const card = page.locator('.reveal-card:focus');
    await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
    await expectStill(card, 'card 1 is dealt');

    // Face down the card doesn't drag, so the flick is nothing, and the tap flips it.
    await flick(finger, card);
    await card.tap();
    await expect(card).toHaveAttribute('aria-label', /^Next card\. Card 1 of 5: /);
    await expectStill(card, 'card 1 is face up');

    // Face up the flick swipes it away, and the next card's tap is a tap, not the end of the swipe.
    await flick(finger, card);
    await expect(card).toHaveAttribute('aria-label', 'Flip card 2 of 5');
    await card.tap();
    await expect(card).toHaveAttribute('aria-label', /^Next card\. Card 2 of 5: /);
    expect(errors).toEqual([]);
  });
});

test('opened by mouse: no ring on the cards, the pack or the result, and a drag selects nothing', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A mouse check; the desktop project has the mouse.');
  test.setTimeout(90000);
  const { errors, packShell } = await sealedPack(page, baseURL!);
  const finger = await fingerFor(page, false);
  await expectNothingRingedAtBoot(page);

  await swipeOpen(packShell, finger);
  const card = page.locator('.reveal-card:focus');
  await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
  await expectNoRing(card, 'card 1');
  await dragOff(finger, card);
  expect(await selectedText(page)).toBe('');

  await revealAll(page, (target) => target.click(), expectNoRing);
  await expectNoRing(page.locator('.summary-title'), 'the result');
  const summaryCard = page.locator('.summary-card').first();
  await scriptFocus(summaryCard);
  await expectNoRing(summaryCard, 'a summary card');
  await dragOff(finger, summaryCard);
  expect(await selectedText(page)).toBe('');
  expect(errors).toEqual([]);
});

test('opened with Space alone: no yellow ring, but focus stays visible on the cards and the pack', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A keyboard check; the desktop project has the keyboard.');
  test.setTimeout(90000);
  const { errors } = await sealedPack(page, baseURL!);
  // The first Space opens the pack from the sealed screen, cutting it with no button pressed.
  await page.keyboard.press('Space');
  await revealAll(page, () => page.keyboard.press('Space'), expectQuietOutlineAfterPress);
  // The result is a heading, not a control: nothing shows on it.
  await expectNoRingAfterPress(page.locator('.summary-title'), 'the result');
  // Space again closes the result; the control focus lands on next wears the quiet outline, not the ring.
  await page.keyboard.press('Space');
  await expect(page.locator('.pack-summary')).toBeHidden();
  await expectQuietOutlineAfterPress(page.locator('.pack-open-button'), 'Open pack once the result closes');
  expect(errors).toEqual([]);
});

test('opened by keyboard: Tab rings, Space is quiet, Tab rings again, until a click', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A keyboard check; the desktop project has the keyboard.');
  test.setTimeout(90000);
  const { errors } = await sealedPack(page, baseURL!);
  const pack = page.getByRole('button', { name: 'Open pack', exact: true });
  for (let tabs = 0; !(await pack.evaluate((el) => el === document.activeElement)); tabs++) {
    expect(tabs, 'Tab never reached the Open pack button').toBeLessThan(40);
    await page.keyboard.press('Tab');
  }
  await expectRing(pack, 'Open pack');

  // Space is down but not yet released (a button clicks on keyup), so Open pack still holds the focus
  // Tab gave it: it keeps its ring.
  await page.keyboard.down('Space');
  expect(await page.evaluate(() => document.documentElement.dataset.input)).toBe('press');
  await expectRing(pack, 'Open pack while Space is held', 'press');
  await page.keyboard.up('Space');
  await revealAll(page, () => page.keyboard.press('Space'), expectQuietOutlineAfterPress);
  const title = page.locator('.summary-title');
  await expect(title).toBeFocused();
  await expectNoRingAfterPress(title, 'the result');

  // Tab brings the ring back on whatever it reaches.
  await page.keyboard.press('Tab');
  const tabbed = page.locator(':focus');
  await expectRing(tabbed, 'the control Tab reached');
  const summaryCard = page.locator('.summary-card').first();
  // The ring goes between the card's rarity edge and its shadow; neither is lost to base.css's ring rule.
  const ownShadow = (target: Locator) => target.evaluate((el) => getComputedStyle(el).boxShadow);
  const ringShadow = await ownShadow(tabbed);
  const restingShadow = await ownShadow(summaryCard);
  expect(restingShadow).toContain('rgba(0, 0, 0, 0) 0px 0px 0px 0px');
  await scriptFocus(summaryCard);
  await expectRing(summaryCard, 'a summary card');
  expect(await ownShadow(summaryCard)).toBe(restingShadow.replace('rgba(0, 0, 0, 0) 0px 0px 0px 0px', ringShadow));

  // A click anywhere hands the page back to the pointer, and the same script focus goes quiet.
  await page.locator('.summary-title').click();
  await scriptFocus(summaryCard);
  await expectNoRing(summaryCard, 'a summary card after a click');
  expect(errors).toEqual([]);
});

test('before any input, focus the app moves keeps its ring', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One check is enough; the desktop project runs it.');
  test.setTimeout(60000);
  const { errors } = await sealedPack(page, baseURL!);
  await expectNothingRingedAtBoot(page);
  // A screen reader, switch or voice control can move focus with no key or press the page hears.
  const pack = page.getByRole('button', { name: 'Open pack', exact: true });
  await scriptFocus(pack);
  await expectRing(pack, 'Open pack, focused before any input');
  expect(errors).toEqual([]);
});

import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectSummaryTakesClicks, fingerFor, monitor, recordShownToasts } from './support';

/**
 * Achievement toasts under a thumb (phone feedback on #803: it blocks things, will not go away, and a
 * tap on it did nothing). A tap opens what it is for, even when the finger drifts a few pixels; a swipe up
 * or sideways follows the finger and sends it away for good, as does its own X (which opens nothing); a toast the player has seen does not come back
 * every time a sheet closes; and none shows over the pack while it is torn and revealed, or covers the pack's X,
 * the headline, the cards or the buttons at any phone size. Phone emulation (touch, Chromium), not a physical
 * phone; the mobile-chromium project runs it (the desktop one leaves it out, in playwright.config.ts). A toast
 * is held from the moment it shows, so none times out between steps, and the page's own clock is
 * waited on, never a fixed pause.
 */

const TOUCH_TARGET = 44;

/** Portrait and landscape phones, small to large. */
const PHONES = [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 640, height: 360 },
  { width: 844, height: 390 },
];

/**
 * Puts the focus on the toast, as the keyboard would: a keystroke first, so the focus counts as the
 * keyboard's (a pointer's does not). Each toast is already held from the moment it shows (the page
 * does it, see toSummaryWithToast), so this is for the steps that need the focus.
 */
const hold = async (page: Page) => {
  await page.keyboard.press('Shift');
  await page.locator('.toast-open').focus();
};

/**
 * A fresh player's first pack, skipped to its summary, with the grouped toast up and held. With `clock`,
 * the page's clock is Playwright's (still running), so a test can move time on instead of waiting for it.
 * Every toast is held by the page from the moment it shows (as a resting pointer would hold it), so no
 * stall between steps can let one leave on its own timer; each test sends it away itself.
 */
async function toSummaryWithToast(page: Page, baseURL: string, { clock = false } = {}) {
  if (clock) await page.clock.install();
  await recordShownToasts(page, { hold: true });
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectSummaryTakesClicks(page);
  const toast = page.locator('.toast');
  await expect(toast).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.toast-kicker')).toHaveText(/achievements unlocked/);
  await hold(page);
  return { errors, toast };
}

const centre = async (toast: Locator) => {
  const box = (await toast.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

/** The toast is still, not mid-entrance: the slide-in finishes before its place is measured. */
const settled = (page: Page, toast: Locator) => expect.poll(async () => {
  const first = (await toast.boundingBox())!;
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const second = (await toast.boundingBox())!;
  return first.y === second.y && first.x === second.x;
}, { message: 'the toast has settled' }).toBe(true);

/** One finger down on the toast, through each of `steps` (offsets from the press), then lifted. */
async function drag(page: Page, toast: Locator, steps: { dx: number; dy: number }[], { lift = true } = {}) {
  const { x, y } = await centre(toast);
  const finger = await fingerFor(page, true);
  await finger.press(x, y);
  for (const step of steps) await finger.move(x + step.dx, y + step.dy);
  if (lift) await finger.release();
  return finger;
}

/** The grouped achievements' toast opens the achievements list on Profile. */
const onProfile = (page: Page) => expect(page.locator('#achievements')).toBeVisible({ timeout: 10000 });

test('a tap on the toast opens what it is for, and the toast is gone', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  const { errors, toast } = await toSummaryWithToast(page, baseURL!);
  const { x, y } = await centre(toast);
  await page.touchscreen.tap(x, y);
  await onProfile(page);
  await expect(page.locator('.toast-kicker').filter({ hasText: /achievements unlocked/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// A thumb drifts: the press moves a few pixels between touching down and lifting, and that is still a tap.
// (Chrome's own click slop is about 15px.)
for (const drift of [4, 12]) {
  test(`a tap that drifts ${drift}px still opens the toast`, async ({ page, baseURL }) => {
    test.setTimeout(120000);
    const { errors, toast } = await toSummaryWithToast(page, baseURL!);
    await drag(page, toast, [{ dx: drift / 2, dy: 0 }, { dx: drift, dy: 0 }]);
    await onProfile(page);
    expect(errors).toEqual([]);
  });
}

test('the X is a visible 44px control that only dismisses: the toast goes, the screen stays, the next one follows', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  const { errors, toast } = await toSummaryWithToast(page, baseURL!);
  const dismiss = toast.getByRole('button', { name: 'Dismiss' });
  await expect(dismiss).toBeVisible();
  const box = (await dismiss.boundingBox())!;
  expect(box.width, 'wide enough for a thumb').toBeGreaterThanOrEqual(TOUCH_TARGET - 0.5);
  expect(box.height, 'tall enough for a thumb').toBeGreaterThanOrEqual(TOUCH_TARGET - 0.5);
  const toastBox = (await toast.boundingBox())!;
  expect(box.x + box.width, 'inside the toast').toBeLessThanOrEqual(toastBox.x + toastBox.width + 0.5);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.toast-kicker').filter({ hasText: /achievements unlocked/ })).toHaveCount(0);
  // Nowhere was opened: still on the pack's summary, and the level-up is the toast that follows.
  await expect(page.locator('#achievements')).toHaveCount(0);
  await expect(page.locator('.summary-card')).toHaveCount(5);
  await expect(page.locator('.toast-kicker')).toHaveText(/^Level up$/, { timeout: 15000 });
  expect(errors).toEqual([]);
});

for (const [direction, steps] of [
  ['up', [{ dx: 0, dy: -20 }, { dx: 0, dy: -50 }, { dx: 0, dy: -80 }]],
  ['left', [{ dx: -30, dy: 0 }, { dx: -70, dy: 0 }, { dx: -110, dy: 2 }]],
  ['right', [{ dx: 30, dy: 0 }, { dx: 70, dy: 0 }, { dx: 110, dy: 2 }]],
] as const) {
  test(`a swipe ${direction} sends the toast away without opening it, and the next one follows`, async ({ page, baseURL }) => {
    test.setTimeout(120000);
    const { errors, toast } = await toSummaryWithToast(page, baseURL!);
    await drag(page, toast, [...steps]);
    await expect(page.locator('.toast-kicker').filter({ hasText: /achievements unlocked/ })).toHaveCount(0);
    await expect(page.locator('.toast-kicker')).toHaveText(/^Level up$/, { timeout: 15000 });
    await expect(page.locator('#achievements')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('the toast follows the finger, and springs back from a swipe that stops short', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  const { errors, toast } = await toSummaryWithToast(page, baseURL!);
  const { box } = await centre(toast);
  const finger = await drag(page, toast, [{ dx: 0, dy: -12 }, { dx: 0, dy: -26 }], { lift: false });
  // Under the finger, near enough one for one.
  await expect.poll(async () => box.y - (await toast.boundingBox())!.y, { message: 'the toast is carried up' }).toBeGreaterThan(18);
  await finger.release();
  await expect.poll(async () => Math.abs((await toast.boundingBox())!.y - box.y), { message: 'back where it was' }).toBeLessThan(1);
  await expect(page.locator('.toast-kicker')).toHaveText(/achievements unlocked/);
  await expect(page.locator('#achievements')).toHaveCount(0);
  // A swipe that stopped short is not a tap, but it does not leave the toast deaf to the keyboard either.
  await page.keyboard.press('Enter');
  await onProfile(page);
  expect(errors).toEqual([]);
});

// The fly-out is only for those who have not asked for less motion: with reduced motion the toast fades
// where it is, wherever it was sent. Sampled every frame, from the release until the toast is gone.
/** How far, in px, a toast swiped left (to about 110px under the finger) got from where it started. */
async function furthestAfterSwipe(page: Page, baseURL: string) {
  const { errors, toast } = await toSummaryWithToast(page, baseURL);
  const { box } = await centre(toast);
  const finger = await drag(page, toast, [{ dx: -30, dy: 0 }, { dx: -70, dy: 0 }, { dx: -110, dy: 2 }], { lift: false });
  await settled(page, toast);
  await page.evaluate(() => {
    const el = document.querySelector('.toast')!;
    const lefts: number[] = [];
    Object.assign(window, { toastLefts: lefts });
    const frame = () => {
      if (!el.isConnected) return;
      lefts.push(el.getBoundingClientRect().left);
      requestAnimationFrame(frame);
    };
    frame();
  });
  await finger.release();
  await expect(page.locator('.toast-kicker').filter({ hasText: /achievements unlocked/ })).toHaveCount(0);
  const lefts = await page.evaluate(() => (window as unknown as { toastLefts: number[] }).toastLefts);
  expect(errors).toEqual([]);
  return Math.max(...lefts.map((left) => Math.abs(left - box.x)));
}

test('a swiped toast flies off the way it was thrown', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // The finger carried it to about 110px; flying off takes it well past that, to 240px.
  expect(await furthestAfterSwipe(page, baseURL!), 'it flew off').toBeGreaterThan(130);
});

test('a swiped toast only fades out with reduced motion', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await furthestAfterSwipe(page, baseURL!), 'it moved on after the finger let go').toBeLessThanOrEqual(115);
});

test('a toast the player saw does not come back each time a card close-up closes', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  const { errors, toast } = await toSummaryWithToast(page, baseURL!, { clock: true });
  // Held from the moment it shows, so it is still the one up once the page's clock has moved far enough for it to count as seen.
  await page.clock.fastForward(2000);
  await expect(toast).toBeVisible();

  await page.locator('.summary-card').first().tap();
  const viewer = page.locator('.card-viewer');
  await expect(viewer).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0);
  // Every toast shown from here on, since the one it replaces may come and go between two checks.
  await page.evaluate(() => {
    const kickers: string[] = [];
    Object.assign(window, { kickersSince: kickers });
    new MutationObserver(() => {
      const kicker = document.querySelector('.toast-kicker')?.textContent;
      if (kicker && !kickers.includes(kicker)) kickers.push(kicker);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await viewer.getByRole('button', { name: /^Close/ }).first().tap();
  await expect(viewer).toHaveCount(0);

  // The grouped toast was seen: the level-up is what follows, not the same toast again.
  await expect(page.locator('.toast-kicker')).toHaveText(/^Level up$/, { timeout: 15000 });
  const shown = await page.evaluate(() => (window as unknown as { kickersSince: string[] }).kickersSince);
  expect(shown.filter((kicker) => /achievements unlocked/.test(kicker)), 'the seen toast came back').toEqual([]);
  expect(errors).toEqual([]);
});

test('no toast shows over the pack while it is torn and revealed', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  const { errors } = await toSummaryWithToast(page, baseURL!);
  await page.locator('.pack-close').tap();
  await expect(page.getByRole('button', { name: /^Open pack/ })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.toast')).toBeVisible({ timeout: 15000 });
  await hold(page);

  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  expect(errors).toEqual([]);
});

/** Every control on the home screen: the set steps, the pack, the guide link, the header buttons, the tab bar. */
const HOME_CONTROLS = ['.set-step', '.set-current', '.pack-shell', '[data-pack-open]', '.card-guide-link', '.app-utilities button', '.app-nav-item'];
for (const viewport of PHONES) {
  test(`on the home screen the toast is a 44px target a tap opens, and covers no control at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await page.setViewportSize(viewport);
    const { errors } = await toSummaryWithToast(page, baseURL!);
    await page.getByRole('button', { name: /Next pack/ }).tap();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.set-current')).toBeVisible();
    await hold(page);
    await settled(page, toast);

    const box = (await toast.boundingBox())!;
    expect(box.height, 'tall enough for a thumb').toBeGreaterThanOrEqual(TOUCH_TARGET - 0.5);
    expect(box.width, 'wide enough for a thumb').toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

    // The toast takes no room, so the page is as it was; still, the controls are measured once it has settled.
    await expect.poll(() => page.evaluate((selectors) => {
      const rect = document.querySelector('.toast')!.getBoundingClientRect();
      const problems: string[] = [];
      for (const selector of selectors) {
        for (const [index, el] of Array.from(document.querySelectorAll(selector)).entries()) {
          const at = el.getBoundingClientRect();
          if (!at.width || !at.height) continue;
          if (rect.left < at.right && rect.right > at.left && rect.top < at.bottom && rect.bottom > at.top) problems.push(`${selector}[${index}] is under the toast`);
          const top = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
          if (top?.closest('.toast')) problems.push(`${selector}[${index}] loses its centre to the toast`);
        }
      }
      return problems;
    }, HOME_CONTROLS), { message: 'no control is under the toast' }).toEqual([]);

    const { x, y } = await centre(toast);
    await page.touchscreen.tap(x, y);
    await onProfile(page);
    expect(errors).toEqual([]);
  });
}

// What a toast must stay off on the summary of a pack: the X, the headline, each card and each button.
const PROTECTED = ['.pack-close', '.summary-title', '.summary-card', '.summary-actions button'];

for (const viewport of PHONES) {
  test(`a toast on the summary covers nothing the player needs at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await page.setViewportSize(viewport);
    const { errors } = await toSummaryWithToast(page, baseURL!);

    for (const kicker of [/achievements unlocked/, /^Level up$/]) {
      await expect(page.locator('.toast-kicker')).toHaveText(kicker, { timeout: 15000 });
      await hold(page);
      await settled(page, page.locator('.toast'));
      const covered = await page.evaluate((selectors) => {
        const toast = document.querySelector('.toast')!.getBoundingClientRect();
        const problems: string[] = [];
        for (const selector of selectors) {
          for (const [index, el] of Array.from(document.querySelectorAll(selector)).entries()) {
            const box = el.getBoundingClientRect();
            if (!box.width || !box.height) continue;
            if (toast.left < box.right && toast.right > box.left && toast.top < box.bottom && toast.bottom > box.top) problems.push(`${selector}[${index}] is under the toast`);
            const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (at?.closest('.toast')) problems.push(`${selector}[${index}] loses its centre to the toast`);
          }
        }
        return problems;
      }, PROTECTED);
      expect(covered, `${kicker}`).toEqual([]);
      // The toast is on screen, whole.
      const box = (await page.locator('.toast').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      expect(box.height, 'tall enough for a thumb').toBeGreaterThanOrEqual(TOUCH_TARGET - 0.5);
      // Away for the next one.
      await drag(page, page.locator('.toast'), [{ dx: 0, dy: -30 }, { dx: 0, dy: -80 }]);
    }
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 15000 });
    expect(errors).toEqual([]);
  });
}

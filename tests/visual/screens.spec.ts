import { test, expect, type Locator, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { GROUPED_TOAST_MS, TOAST_MS } from '../../src/constants/toast';
import { monitor, expectDecoded, expectPackDropped, expectSummaryTakesClicks } from '../browser/support';

/**
 * Reviewed screenshots of the core screens (#745): a new player's first pack, its summary, the share
 * sheet for that pull and the Cards page it fills, at a phone width (Pixel 5 emulation at scale 1,
 * not a real phone) and on desktop. Run in the pinned container only (playwright.visual.config.ts).
 *
 * An image only says the screen looks as it did when someone last approved it. The browser specs
 * still own behaviour: what is focused, hit or announced, and how the layout reflows.
 *
 * Every wait is for a state the page reports (a role, a decoded image, a computed style, a settled
 * attribute), then toHaveScreenshot takes shots until two in a row agree before comparing.
 *
 * The first pack's toasts are left out: they leave on their own timers, so a shot with one up would
 * depend on how fast the runner is. The summary is shot once both have been up and gone (a state,
 * waited for like any other), and toast-clearance.spec.ts checks what they cover.
 *
 * A new player gets the newest openable set (DEFAULT_SET_ID), which the next release changes, so the
 * spec picks a released one and the Cards shot holds only that set's section: a new set, or a draft
 * flag coming off, leaves these images alone (docs/ADDING_A_SET.md).
 */
const SET = { id: 'right-now', name: 'Summer of Slop' };

/**
 * A fixed noon for Date, so a date the screens print is the same every run. Timers and animation
 * frames stay real: with them faked, a jump past a toast's timer leaves Motion's exit animation
 * stuck, so a fake clock can't run the toasts out.
 */
const NOW = new Date('2026-06-15T12:00:00Z');

/**
 * Records each toast's kicker as it mounts, from the first script on, so the spec can tell which
 * toasts have been up without catching any on screen (one can come and go between two looks).
 */
function recordToasts() {
  const seen: string[] = [];
  (window as unknown as { toastsSeen: string[] }).toastsSeen = seen;
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        const kicker = node.matches('.toast-kicker') ? node : node.querySelector('.toast-kicker');
        // A held toast comes back as a new element; it's the same toast.
        if (kicker && kicker.textContent !== seen.at(-1)) seen.push(kicker.textContent ?? '');
      });
    }
  }).observe(document, { childList: true, subtree: true });
}

/** Waits out the first pack's toasts: the grouped unlocks, then the level-up, each on its own timer. */
async function waitOutToasts(page: Page) {
  // Bounded by the two toasts' own times plus a margin; each wait ends as soon as its state holds.
  const timeout = GROUPED_TOAST_MS + TOAST_MS + 10_000;
  await expect.poll(() => page.evaluate(() => (window as unknown as { toastsSeen: string[] }).toastsSeen), { timeout })
    .toEqual([expect.stringMatching(/^\d+ achievements unlocked$/), 'Level up']);
  await expect(page.locator('.toast')).toHaveCount(0, { timeout });
}

/** Waits for every image the locator finds, after checking it finds some (the screen is up by now). */
async function expectAllDecoded(images: Locator) {
  const count = await images.count();
  expect(count).toBeGreaterThan(0);
  await expectDecoded(images, count);
}

/** Every webfont the page asked for has loaded, so no shot is taken with a fallback face. */
const fontsLoaded = (page: Page) => page.evaluate(async () => {
  await document.fonts.ready;
  let pending = 0;
  document.fonts.forEach((font) => { if (font.status !== 'unloaded' && font.status !== 'loaded') pending += 1; });
  return pending;
});

test('a new player\'s first pack, its summary, the share sheet and the Cards page', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const errors = await monitor(page, baseURL!);
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(([key, id]) => localStorage.setItem(key, id), [STORAGE_KEYS.SELECTED_SET, SET.id]);
  await page.addInitScript(recordToasts);
  await page.goto('./');

  const packShell = page.getByRole('button', { name: /^Open pack/ });
  await expect(packShell).toBeVisible();
  await expectPackDropped(page);
  await expectAllDecoded(page.locator('.pack-display img'));
  expect(await fontsLoaded(page)).toBe(0);
  await expect.soft(page).toHaveScreenshot('first-pack.png');

  await packShell.focus();
  await page.keyboard.press('Space');
  // By keyboard, so the pointer never rests where a toast lands: one under it would stay up.
  await page.locator('button.reveal-skip').focus({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30_000 });
  await expectDecoded(page.locator('.summary-cards img'), 5);
  await expectSummaryTakesClicks(page);
  await waitOutToasts(page);
  expect(await fontsLoaded(page)).toBe(0);
  await expect.soft(page).toHaveScreenshot('summary.png');

  // By keyboard too: a pointer left where Share was would hover whatever sits there on the Cards page
  // (a tile's foil follows it), and where that is depends on the summary's layout.
  await page.locator('.summary-actions').getByRole('button', { name: 'Share', exact: true }).focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Share your pull', exact: true });
  await expect(sheet.locator('.sheet--deferred')).toHaveCount(0);
  const shared = sheet.getByRole('img', { name: "The image you'll share", exact: true });
  await expectDecoded(shared, 1);
  expect(await fontsLoaded(page)).toBe(0);
  await expect.soft(page).toHaveScreenshot('share-sheet.png');

  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.goto('./#/cards');
  const cards = page.getByRole('main', { name: 'Cards', exact: true });
  await expect(cards.locator('.page-skeleton')).toHaveCount(0);
  // Just the set this pack came from: the page's totals and its list of sets not started yet grow
  // with every release.
  const section = cards.locator('section.collection-set').filter({ has: page.locator('.collection-set-name', { hasText: SET.name }) });
  await expect(section).toHaveCount(1);
  await expect(section.getByRole('button', { name: /, \d+ owned/ }).first()).toBeVisible();
  await expectAllDecoded(section.locator('img'));
  expect(await fontsLoaded(page)).toBe(0);
  // The section as a player sees it, scrolled to the top: on a phone, down to the tab bar fixed over it.
  const clip = await section.evaluate((element) => {
    element.scrollIntoView({ block: 'start' });
    const box = element.getBoundingClientRect();
    const nav = document.querySelector('.app-nav')!.getBoundingClientRect();
    const bottom = Math.min(box.bottom, window.innerHeight, nav.top > box.top ? nav.top : Infinity);
    return { x: box.x, y: box.y, width: box.width, height: bottom - box.y };
  });
  await expect.soft(page).toHaveScreenshot('cards.png', { clip });

  expect(errors).toEqual([]);
});

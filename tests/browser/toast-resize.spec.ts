import { test, expect, type Page } from '@playwright/test';
import { monitor, recordShownToasts } from './support';

/**
 * Resizing the window with a toast up (follow-up to #1220). On a wide screen the toast is compact (one 44px line)
 * in a window shorter than 21rem, or 25rem with the staging note above the header, and whole above that (Toasts.css).
 * A player drags a window's edge, so the rule must give the answer a fresh load at that size gives, whichever way
 * the window got there: a plain setViewportSize walk, up and down across each line and with several steps on the
 * same side of it, at normal and doubled text. (Chromium used to keep a size container query's last answer through
 * such a walk, which toast-home.spec.ts worked around by going through an 800px window first.)
 *
 * One test per banner, each walking all its windows with the first toast held on screen, as toast-home.spec.ts does:
 * the burn-in job repeats the changed specs, so a pack is opened once per scenario rather than once per window.
 */

const WIDTH = 900;
/** The line, in rem, under which the toast is compact (Toasts.css): 21 with nothing above the header, 25 with the staging note. */
const LINES = { plain: 21, staging: 25 } as const;
/** Doubled text is 32px to the rem. */
const TEXT_SIZES = [100, 200];
/** Offsets from the line, in px at normal text (scaled with the text), in the order walked: down then up across the line, and back, several steps to a side. */
const OFFSETS = [-60, -36, -12, 12, 36, 60, 12, -12, -36, -60, -36, 12, 36];

const STAGING_NOTE = 'Staging: a test copy of the next release. Saves here are separate from the real game, and nothing is sent to the Hall of Fame.';

/** A fresh player's first pack, opened and skipped to its summary, then back home with the first toast up and held. */
async function toHome(page: Page, baseURL: string) {
  await recordShownToasts(page, { hold: true });
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  return errors;
}

/** Sets the page's text size like a player's text-size setting (one style element, so a later call replaces it). */
const setText = async (page: Page, percent: number) => {
  await page.evaluate((value) => {
    let style = document.getElementById('toast-resize-text');
    if (!style) {
      style = document.createElement('style');
      style.id = 'toast-resize-text';
      document.head.appendChild(style);
    }
    style.textContent = value === 100 ? '' : `html { font-size: ${value}% !important; }`;
  }, percent);
  await page.evaluate(() => document.fonts.ready);
};

/** The toast has finished entering, so a box measured now is the one that stays. */
const settled = (page: Page) => expect.poll(() => page.locator('.toast').evaluate((el) => {
  const style = getComputedStyle(el);
  return style.opacity === '1' && (style.transform === 'none' || style.transform === 'matrix(1, 0, 0, 1, 0, 0)');
}), { message: 'the toast has finished entering' }).toBe(true);

/** The toast's shape and place, rounded to a pixel, and whether it draws its title. */
const shape = (page: Page) => page.locator('.toast').evaluate((el) => {
  const box = el.getBoundingClientRect();
  const title = el.querySelector('.toast-title')!.getBoundingClientRect();
  return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height), titleDrawn: title.width > 1, inWindow: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
});

/** Where a window of this height leaves the toast on a fresh load: reached through a window under 900px wide, where there is no wide layout to keep an answer from. */
const fresh = async (page: Page, height: number) => {
  await page.setViewportSize({ width: 800, height });
  await page.setViewportSize({ width: WIDTH, height });
  await settled(page);
  return shape(page);
};

async function walk(page: Page, lineRem: number) {
  const windows = TEXT_SIZES.flatMap((text) => {
    const line = lineRem * 16 * (text / 100);
    return OFFSETS.map((offset) => ({ text, line, height: Math.round(line + offset * (text / 100)) }));
  });
  // What a fresh load gives at each window, found first, so that the walk below is only plain resizes.
  const loaded = new Map<string, Awaited<ReturnType<typeof shape>>>();
  for (const { text, height } of windows) {
    await setText(page, text);
    loaded.set(`${height}@${text}`, await fresh(page, height));
  }

  for (const { text, line, height } of windows) {
    const at = `${WIDTH}x${height} at ${text}%`;
    await setText(page, text);
    await page.setViewportSize({ width: WIDTH, height });
    await settled(page);
    const compact = height < line;
    const expected = loaded.get(`${height}@${text}`)!;
    // The line is the one in the CSS: compact under it, whole at and above it.
    expect(expected.titleDrawn, `${at}: a fresh load is ${compact ? 'compact (the title is not drawn)' : 'whole (the title is drawn)'}`).toBe(!compact);
    expect(expected.inWindow, `${at}: the toast is inside the window`).toBe(true);
    expect(expected.left + expected.width, `${at}: anchored to the right edge`).toBeGreaterThanOrEqual(WIDTH - 72);
    // A resize can land between the toast's last two frames, so the shape it settles to is polled for.
    await expect.poll(() => shape(page), { message: `${at}: the toast is the one a fresh load gives (${compact ? 'compact' : 'whole'}), wherever the window came from` }).toEqual(expected);
    expect(await page.locator('.toast-region').evaluate((el) => Math.round(el.getBoundingClientRect().height)), `${at}: the toast takes no room`).toBe(0);
  }
}

test('resizing a window with the toast up gives the compact or whole toast a fresh load gives, across the 21rem line, at normal and doubled text', async ({ page, baseURL }) => {
  test.setTimeout(600000);
  await page.setViewportSize({ width: WIDTH, height: 700 });
  const errors = await toHome(page, baseURL!);
  await page.getByRole('button', { name: /^Open .+ again$/ }).click();
  await expect(page.locator('.toast-kicker').filter({ hasText: /^\d+ achievements unlocked$/ })).toBeVisible({ timeout: 15000 });
  await walk(page, LINES.plain);
  expect(errors).toEqual([]);
});

test('resizing a window with the staging note and the toast up gives the compact or whole toast a fresh load gives, across the 25rem line, at normal and doubled text', async ({ page, baseURL }) => {
  test.setTimeout(600000);
  await page.setViewportSize({ width: WIDTH, height: 700 });
  const errors = await toHome(page, baseURL!);
  // Staging cannot be turned on here (the deploy's host name decides it), so the note is put in as the app renders it.
  await page.evaluate((note) => {
    const banner = document.createElement('p');
    banner.setAttribute('role', 'note');
    banner.className = 'save-warning staging-banner';
    banner.textContent = note;
    document.querySelector('.app')!.prepend(banner);
  }, STAGING_NOTE);
  await page.getByRole('button', { name: /^Open .+ again$/ }).click();
  await expect(page.locator('.toast-kicker').filter({ hasText: /^\d+ achievements unlocked$/ })).toBeVisible({ timeout: 15000 });
  await walk(page, LINES.staging);
  expect(errors).toEqual([]);
});

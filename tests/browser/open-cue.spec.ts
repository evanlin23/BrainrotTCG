import { test, expect, type Page } from '@playwright/test';
import { holdTickets, monitor } from './support';

/**
 * The opening cue (#628, #898): a finger and a partial tear play along the pack's seam, at most twice
 * on a device, and stop at the first touch. Reduced motion shows the arrowheads and a still caption
 * with no motion. A returning player never sees it.
 */

const PLAYS = 'brainrot-open-cue-plays-v1';
const shell = (page: Page) => page.locator('.pack-shell');
const plays = (page: Page) => page.evaluate((key) => localStorage.getItem(key), PLAYS);
// Only the cue's own keyframe animations count: an inherited property can start a brief CSSTransition
// on any element as the page settles, and under reduced motion that is not motion the cue made.
const pillAnimations = (page: Page) =>
  page.locator('.swipe-hint-icon').evaluate((el) => el.getAnimations().filter((a) => a instanceof CSSAnimation && a.playState === 'running').length);
const keyframeAnimations = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => el.getAnimations().filter((a) => a instanceof CSSAnimation).length);

async function load(page: Page) {
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(shell(page)).toBeVisible();
}

test('a new player sees the cue on the first load, and a touch ends it for good', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  // Stretch the play so a slow machine can't finish it before the touch: only the touch ends it here.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '.open-cue-travel, .open-cue-tear { animation-duration: 600s !important; }';
      document.head.append(style);
    });
  });
  await load(page);

  await expect(shell(page)).toHaveAttribute('data-open-cue', 'play');
  await expect(page.locator('.open-cue')).toHaveCount(1);
  await expect(page.locator('.open-cue-finger')).toBeVisible();
  await expect.poll(() => plays(page)).toBe('1');
  expect(await pillAnimations(page)).toBe(1);
  expect(await keyframeAnimations(page, '.open-cue-travel')).toBeGreaterThan(0);

  // The first touch stops it, and counts as understood.
  // The pack drops in on a spring and is visible long before it lands. Hovering waits for it to stop
  // moving and for the point to hit it, so land it first, then aim in the pack's own coordinates at the
  // part of a tall pack that shows.
  await shell(page).hover();
  const spot = await shell(page).evaluate((el) => {
    const edge = el.getBoundingClientRect();
    const top = Math.max(edge.top, 0);
    return { x: edge.width / 2, y: top - edge.top + (Math.min(edge.bottom, window.innerHeight) - top) * 0.8 };
  });
  await shell(page).hover({ position: spot });
  await page.mouse.down();
  await expect(shell(page)).not.toHaveAttribute('data-open-cue', /.+/);
  await expect(page.locator('.open-cue')).toHaveCount(0);
  expect(await pillAnimations(page)).toBe(0);
  await expect.poll(() => plays(page)).toBe('2');
  await page.mouse.up();
  expect(errors).toEqual([]);
});

test('left alone, the cue plays its twice, comes to rest, and the third load has none', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  // The page mines the next pack's ticket and then prefetches its art; a reload would abort that art
  // and the monitor would count it. With the ticket held, nothing is prefetched before a reload.
  await holdTickets(page);
  await load(page);
  await expect(shell(page)).toHaveAttribute('data-open-cue', 'play');

  await expect.poll(() => plays(page)).toBe('1');

  // It plays once through and ends by itself, leaving the pill's arrows still. Finishing the finger's
  // and the tear's animations fires the animationend the cue ends on, without waiting out the 2.4s.
  await page.evaluate(() => document.querySelectorAll('.open-cue-travel, .open-cue-tear').forEach((target) => target.getAnimations().forEach((animation) => animation.finish())));
  await expect(shell(page)).not.toHaveAttribute('data-open-cue', /.+/);
  expect(await pillAnimations(page)).toBe(0);
  expect(await plays(page)).toBe('1');
  expect(errors).toEqual([]);

  await page.reload();
  await expect(shell(page)).toHaveAttribute('data-open-cue', 'play');
  await expect.poll(() => plays(page)).toBe('2');

  await page.reload();
  await expect(shell(page)).toBeVisible();
  await expect(shell(page)).not.toHaveAttribute('data-open-cue', /.+/);
  await expect(page.locator('.open-cue')).toHaveCount(0);
  expect(await pillAnimations(page)).toBe(0);
  expect(await plays(page)).toBe('2');
  expect(errors).toEqual([]);
});

test('with reduced motion the cue is a still frame: arrowheads and caption, nothing moving', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page);

  await expect(shell(page)).toHaveAttribute('data-open-cue', 'still');
  await expect(page.locator('.open-cue-finger')).toBeVisible();
  await expect(page.locator('.swipe-hint-text')).toBeVisible();
  expect(await pillAnimations(page)).toBe(0);
  expect(await keyframeAnimations(page, '.open-cue-travel')).toBe(0);
  expect(await keyframeAnimations(page, '.open-cue-tear')).toBe(0);
  expect(errors).toEqual([]);
});

test('a returning player never sees the cue', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  // Opening the other pages is how a returning player (or one who asked for them) has the nav.
  await page.addInitScript(() => localStorage.setItem('brainrot-settings-v1', JSON.stringify({ showAllPages: true })));
  await load(page);
  await expect(shell(page)).not.toHaveAttribute('data-open-cue', /.+/);
  await expect(page.locator('.open-cue')).toHaveCount(0);
  expect(await pillAnimations(page)).toBe(0);
  expect(await plays(page)).toBeNull();
  expect(errors).toEqual([]);
});

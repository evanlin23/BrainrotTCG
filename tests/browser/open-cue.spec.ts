import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * The opening cue (#628, #898): a finger and a partial tear play along the pack's seam, at most twice
 * on a device, and stop at the first touch. Reduced motion shows the arrowheads and a still caption
 * with no motion. A returning player never sees it.
 */

const PLAYS = 'brainrot-open-cue-plays-v1';
const shell = (page: Page) => page.locator('.pack-shell');
const plays = (page: Page) => page.evaluate((key) => localStorage.getItem(key), PLAYS);
const pillAnimations = (page: Page) =>
  page.locator('.swipe-hint-icon').evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length);
const fingerAnimations = (page: Page) =>
  page.locator('.open-cue-travel').evaluate((el) => el.getAnimations().length);

async function load(page: Page) {
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(shell(page)).toBeVisible();
}

test('a new player sees the cue on the first touch-free load, and a touch ends it for good', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await load(page);

  await expect(shell(page)).toHaveAttribute('data-open-cue', 'play');
  await expect(page.locator('.open-cue')).toHaveCount(1);
  await expect(page.locator('.open-cue-finger')).toBeVisible();
  expect(await plays(page)).toBe('1');
  expect(await pillAnimations(page)).toBe(1);
  expect(await fingerAnimations(page)).toBeGreaterThan(0);

  // The first touch stops it, and counts as understood.
  const box = (await shell(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8);
  await page.mouse.down();
  await expect(shell(page)).not.toHaveAttribute('data-open-cue', /.+/);
  await expect(page.locator('.open-cue')).toHaveCount(0);
  expect(await pillAnimations(page)).toBe(0);
  expect(await plays(page)).toBe('2');
  await page.mouse.up();
  expect(errors).toEqual([]);
});

test('left alone, the cue plays its twice, comes to rest, and the third load has none', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await load(page);
  await expect(shell(page)).toHaveAttribute('data-open-cue', 'play');

  // It plays once through (2.4s) and ends by itself, leaving the pill's arrows still.
  await expect(shell(page)).not.toHaveAttribute('data-open-cue', /.+/, { timeout: 8000 });
  expect(await pillAnimations(page)).toBe(0);
  expect(await plays(page)).toBe('1');

  await page.reload();
  await expect(shell(page)).toHaveAttribute('data-open-cue', 'play');
  expect(await plays(page)).toBe('2');

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
  expect(await fingerAnimations(page)).toBe(0);
  expect(await page.locator('.open-cue-tear').evaluate((el) => el.getAnimations().length)).toBe(0);
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

import { test, expect, type Page } from '@playwright/test';
import { expectStill, monitor, recordShownToasts, scaleText } from './support';
import { STORAGE_KEYS } from '../../src/constants/config';

/**
 * The landing's "Change pack · N available" (DESIGN.md "Flow", item 8), for a returning player who has not
 * opened the Packs sheet: a 44px target in the row under the pack, after the pack in the keyboard order,
 * clear of the pack, its swipe cue, the Card guide and the next-goal chip, and still under reduced motion.
 * Where that row has room it takes the row's empty left column, so the pack keeps its size; on an upright
 * phone it takes a line of its own. A phone shows the whole pack; a desktop's larger pack scrolls in its stage. Phone runs are Pixel 5 emulation (touch), not a physical phone; 200%
 * text is emulated by doubling the root font size the rem tokens use.
 */

type Box = { x: number; y: number; width: number; height: number };

async function landing(page: Page, baseURL: string, size: { width: number; height: number }, { textZoom = 100, seen = false } = {}) {
  await page.setViewportSize(size);
  const errors = await monitor(page, baseURL, 1, { returning: true });
  if (seen) await page.addInitScript((key) => localStorage.setItem(key, '1'), STORAGE_KEYS.PACKS_SHEET_SEEN);
  await page.goto('./');
  if (textZoom !== 100) await scaleText(page, textZoom);
  await expect(page.locator('.card-guide-link')).toBeVisible();
  await expectStill(page.locator('.pack-display'), 'the pack has settled');
  return errors;
}

const measure = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => {
    const el = document.querySelector(selector);
    if (!el || getComputedStyle(el).display === 'none') return null;
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  };
  const control = box('.change-pack');
  const at = control && document.elementFromPoint(control.x + control.width / 2, control.y + control.height / 2);
  return {
    control,
    hit: !!at?.closest('.change-pack'),
    pack: box('.pack-shell')!,
    stage: box('.pack-display')!,
    hint: box('.swipe-hint'),
    guide: box('.card-guide-link')!,
    goal: box('.pack-milestone'),
    toast: box('.toast'),
    viewport: { width: innerWidth, height: innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
  };
});

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (a: Box, v: { width: number; height: number }) => a.x >= 0 && a.y >= 0 && a.x + a.width <= v.width + 0.5 && a.y + a.height <= v.height + 0.5;

const SIZES = [
  { name: 'a 360 x 640 phone', tag: '@mobile-only', width: 360, height: 640, textZoom: 100, sharesRow: false },
  { name: 'a 390 x 844 phone', tag: '@mobile-only', width: 390, height: 844, textZoom: 100, sharesRow: false },
  { name: 'a 640 x 360 phone on its side', tag: '@mobile-only', width: 640, height: 360, textZoom: 100, sharesRow: true },
  { name: 'a 360 x 640 phone at 200% text', tag: '@mobile-only', width: 360, height: 640, textZoom: 200, sharesRow: false },
  { name: 'a 1280 x 800 desktop', tag: '@desktop-only', width: 1280, height: 800, textZoom: 100, sharesRow: true },
  { name: 'a 1280 x 800 desktop at 200% text', tag: '@desktop-only', width: 1280, height: 800, textZoom: 200, sharesRow: true },
] as const;

for (const size of SIZES) {
  test(`sits under the pack, clear of it and of the row beside it, on ${size.name}`, { tag: size.tag }, async ({ page, baseURL }) => {
    const errors = await landing(page, baseURL!, size, { textZoom: size.textZoom });
    const control = page.locator('button.change-pack');
    await expect(control).toHaveAccessibleName(/^Change pack, \d+ available$/);
    const m = await measure(page);
    const box = m.control!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(inside(box, m.viewport), 'the control is on screen').toBe(true);
    expect(m.hit, 'nothing covers the control').toBe(true);
    // A phone fits the whole pack to its stage; a desktop's larger pack scrolls in its stage, top first (PackOpener.css).
    expect(inside(size.tag === '@mobile-only' ? m.pack : m.stage, m.viewport), 'the pack is on screen').toBe(true);
    if (m.hint) expect(inside(m.hint, m.viewport), 'the swipe cue is on screen').toBe(true);
    // Outside the pack's stage, so a press on it never starts a tear, and the stage ends above it.
    expect(overlaps(box, m.stage)).toBe(false);
    expect(box.y).toBeGreaterThanOrEqual(m.stage.y + m.stage.height - 0.5);
    expect(overlaps(box, m.guide)).toBe(false);
    if (m.goal) expect(overlaps(box, m.goal)).toBe(false);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewport.width);

    // Keyboard: the next stop after the pack.
    await page.locator('[data-pack-open]').focus();
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();

    if (size.sharesRow) {
      // In the row's empty left column, level with the guide: the pack's stage (so the pack) is the size it is without the control.
      expect(Math.abs(box.y - m.guide.y) < box.height).toBe(true);
      const page2 = await page.context().newPage();
      const errors2 = await landing(page2, baseURL!, size, { textZoom: size.textZoom, seen: true });
      await expect(page2.locator('button.change-pack')).toHaveCount(0);
      const without = await measure(page2);
      expect(Math.round(without.stage.height)).toBe(Math.round(m.stage.height));
      expect(Math.round(without.pack.height)).toBe(Math.round(m.pack.height));
      await page2.close();
      expect(errors2).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}

test('runs no animation under reduced motion', async ({ page, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await landing(page, baseURL!, page.viewportSize()!);
  const control = page.locator('button.change-pack');
  await control.hover();
  await control.focus();
  expect(await control.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  expect(errors).toEqual([]);
});

test('opens the Packs sheet with no switch; closed, focus is on the pack and the control is gone for good', async ({ page, baseURL }) => {
  const errors = await landing(page, baseURL!, page.viewportSize()!);
  const packName = await page.locator('[data-pack-open]').getAttribute('aria-label');
  const control = page.locator('button.change-pack');
  await page.locator('[data-pack-open]').focus();
  await page.keyboard.press('Tab');
  await expect(control).toBeFocused();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Packs' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.pack-tile[aria-pressed="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[data-pack-open]')).toBeFocused();
  await expect(page.locator('[data-pack-open]')).toHaveAttribute('aria-label', packName!);
  await expect(control).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.card-guide-link')).toBeVisible();
  await expect(control).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('stays clear of the desktop toast in the top right', { tag: '@desktop-only' }, async ({ page, baseURL }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await recordShownToasts(page, { hold: true });
  const errors = await monitor(page, baseURL!, 0, { returning: true, unreadNews: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('button.change-pack')).toHaveCount(0);
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expect(page.locator('button.change-pack')).toHaveCount(0);
  await page.getByRole('button', { name: /^Open .+ again$/ }).click();
  await expect(page.locator('.toast').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('button.change-pack')).toBeVisible();
  await expectStill(page.locator('.pack-display'), 'the pack has settled');
  const m = await measure(page);
  expect(overlaps(m.control!, m.toast!)).toBe(false);
  expect(m.hit).toBe(true);
  expect(errors).toEqual([]);
});

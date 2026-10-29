import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectPackDropped, monitor, expectSummaryTakesClicks } from './support';

/**
 * Two accessibility preferences the page cannot see in its own colours:
 * - #646: the card close-up stops tilting, and levels, when reduced motion turns on while it is open.
 * - #683: forced colours (Windows High Contrast) keep switches, the chosen pack and the chosen reward
 *   visibly different from the rest, after focus has moved away.
 */

const LEVEL = 'perspective(1000px) rotateX(0deg) rotateY(0deg)';

test('the card close-up levels, and stops tilting, when reduced motion turns on while it is open', { tag: '@desktop-only' }, async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const pack = page.getByRole('button', { name: /^Open pack/ });
  await pack.focus();
  await page.keyboard.press('Space');
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectSummaryTakesClicks(page);
  await page.locator('.summary-card').first().click();
  const card = page.locator('.card-viewer .card-viewer-card');
  await expect(card).toBeVisible();
  const transform = () => card.evaluate((el) => (el as HTMLElement).style.transform);

  // Motion allowed: the card follows the mouse. The media change and the mouse listener reach the
  // page asynchronously, so each move waits for the card to say it follows the mouse (data-tilt).
  const box = (await card.boundingBox())!;
  await expect(card).toHaveAttribute('data-tilt', 'live');
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9);
  await expect.poll(transform).not.toBe(LEVEL);

  // Reduce turns on with the close-up still open: the card levels at once and ignores the mouse.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(card).not.toHaveAttribute('data-tilt');
  await expect.poll(transform).toBe(LEVEL);
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
  expect(await transform()).toBe(LEVEL);

  // Back to no preference: it tilts again with the mouse.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(card).toHaveAttribute('data-tilt', 'live');
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1);
  await expect.poll(transform).not.toBe(LEVEL);
  expect(errors).toEqual([]);
});

test.describe('forced colours', () => {
  // Reduced motion also stops the `.switch` background transition, so colours read right after a toggle are final.
  test.use({ forcedColors: 'active', reducedMotion: 'reduce' });

  /** What forced colours paint for a control: its box, or its ::after thumb. */
  const paint = (control: Locator, pseudo?: '::after') => control.evaluate((el, pseudo) => {
    const style = getComputedStyle(el, pseudo ?? null);
    return {
      background: style.backgroundColor,
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      borderWidth: parseFloat(style.borderTopWidth),
    };
  }, pseudo);

  const seed = async (page: Page, baseURL: string, historyRecords = 0) => {
    const errors = await monitor(page, baseURL, historyRecords, { returning: true });
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await expectPackDropped(page);
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    return errors;
  };

  test('a switch shows its thumb and its on and off states, after focus has moved away', async ({ page, baseURL }) => {
    const errors = await seed(page, baseURL!);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const sw = page.getByRole('switch', { name: 'Particles', exact: true });
    await expect(sw).toBeVisible();
    /** The switch at rest: focus and pointer elsewhere, so only its checked state is left to show. */
    const atRest = async () => {
      await sw.evaluate((el) => (el as HTMLElement).blur());
      await page.mouse.move(0, 0);
      return { checked: await sw.getAttribute('aria-checked'), track: await paint(sw), thumb: await paint(sw, '::after') };
    };
    const before = await atRest();
    await sw.focus();
    await page.keyboard.press('Space');
    const after = await atRest();
    expect(after.checked).not.toBe(before.checked);

    // The thumb is visible against the track in both states: painted, and not the track's colour.
    for (const { track, thumb } of [before, after]) {
      expect(thumb.background, 'the thumb paints a colour').not.toMatch(/^rgba\(\d+, \d+, \d+, 0\)$/);
      expect(thumb.background, 'the thumb is not the track colour').not.toBe(track.background);
    }
    // And on differs from off in the track, not only in where the thumb sits.
    expect(after.track.background).not.toBe(before.track.background);
    expect(errors).toEqual([]);
  });

  test('the chosen pack keeps a marker the other packs lack after focus moves to Close', async ({ page, baseURL }) => {
    const errors = await seed(page, baseURL!);
    await page.locator('.set-current').click();
    const sheet = page.getByRole('dialog', { name: 'Packs' });
    await expect(sheet).toBeVisible();
    const chosen = sheet.locator('.pack-tile[aria-pressed="true"]');
    const others = sheet.locator('.pack-tile[aria-pressed="false"]');
    expect(await others.count()).toBeGreaterThan(0);
    await sheet.getByRole('button', { name: /^Close/ }).focus();
    const on = await paint(chosen);
    const off = await paint(others.first());
    expect(on.border, 'the chosen pack is marked apart from the rest').not.toBe(off.border);
    expect(on.borderWidth).toBeGreaterThan(off.borderWidth);
    expect(errors).toEqual([]);
  });

  test('the chosen reward keeps a marker the other unlocked rewards lack after focus moves away', { tag: '@desktop-only' }, async ({ page, baseURL }) => {
    // Enough saved packs for level 4, which unlocks the Midnight card back: 60 packs x 10 XP + 4 unique cards x 25 XP = 700,
    // and level 4 needs 600. If XP values or level thresholds change, revisit this count.
    const errors = await seed(page, baseURL!, 60);
    await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click();
    await page.locator('.profile-rewards summary').click();
    const backs = page.getByRole('radiogroup', { name: 'Card back', exact: true });
    await expect(backs).toBeVisible();
    const classic = backs.getByRole('radio', { name: 'Classic', exact: true });
    const midnight = backs.getByRole('radio', { name: 'Midnight', exact: true });
    await expect(midnight).toBeEnabled();
    await classic.focus();
    await page.keyboard.press('ArrowRight');
    await expect(midnight).toHaveAttribute('aria-checked', 'true');
    await expect(classic).toHaveAttribute('aria-checked', 'false');
    await midnight.evaluate((el) => (el as HTMLElement).blur());
    const on = await paint(midnight);
    const off = await paint(classic);
    expect(on.border, 'the chosen reward is marked apart from the rest').not.toBe(off.border);
    expect(on.borderWidth).toBeGreaterThan(off.borderWidth);
    expect(errors).toEqual([]);
  });
});

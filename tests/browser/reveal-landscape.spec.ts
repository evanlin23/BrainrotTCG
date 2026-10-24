import { test, expect, type Locator } from '@playwright/test';
import { monitor } from './support';

/**
 * The reveal on a phone on its side (#898, DESIGN.md "First-pack flow decision", Reveal): under 500px
 * tall the card takes at least 70% of the screen's height, with the rarity row, hint and Skip in a column
 * beside it, and the X, Skip and the card all within reach. Also the first-card cue: on a new player's
 * first card the back lifts once (only transform), and not again on the next card.
 */

const SIZES = [{ width: 640, height: 360 }, { width: 568, height: 320 }];

const box = async (target: Locator) => (await target.boundingBox())!;

for (const size of SIZES) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size, reducedMotion: 'no-preference' });

    test('the card takes 70% of the height, with its rows in a column beside it, all on screen', async ({ page, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-chromium', 'A window-size check; the desktop project runs it once.');
      test.setTimeout(60000);
      const errors = await monitor(page, baseURL!);
      await page.goto('./');
      await page.getByRole('button', { name: /^Open pack/ }).focus();
      await page.keyboard.press('Space');
      const card = page.locator('.reveal-card:focus');
      await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
      await page.keyboard.press('Space');
      await expect(page.locator('.reveal-rarity .rarity-pill')).toBeVisible();

      const cardBox = await box(card);
      const rarity = await box(page.locator('.reveal-rarity'));
      const hint = await box(page.locator('.tip-text'));
      const skip = await box(page.locator('.reveal-skip'));
      const close = await box(page.getByRole('button', { name: 'Back to packs' }));

      expect(cardBox.height, 'the card against the screen\'s height').toBeGreaterThanOrEqual(size.height * 0.7);
      for (const [name, part] of Object.entries({ rarity, hint, skip })) {
        expect(part.x, `the ${name} row is beside the card, not under it`).toBeGreaterThanOrEqual(cardBox.x + cardBox.width);
        expect(part.y, `the ${name} row's top`).toBeGreaterThanOrEqual(0);
        expect(part.y + part.height, `the ${name} row's bottom against the screen`).toBeLessThanOrEqual(size.height);
        expect(part.x + part.width, `the ${name} row's right edge against the screen`).toBeLessThanOrEqual(size.width);
      }
      expect(cardBox.y, 'the card clears the top bar').toBeGreaterThanOrEqual(close.y + close.height);
      expect(cardBox.y + cardBox.height, 'the card is whole on the screen').toBeLessThanOrEqual(size.height);
      expect(close.y + close.height, 'the X is on screen').toBeLessThanOrEqual(size.height);
      await expect(page.locator('.reveal-skip')).toBeEnabled();
      expect(errors).toEqual([]);
    });
  });
}

test.describe('the first-card cue', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });

  test('lifts the first card\'s back once, with transform only, and not on the next card', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'One run is enough.');
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await page.getByRole('button', { name: /^Open pack/ }).focus();
    await page.keyboard.press('Space');
    const card = page.locator('.reveal-card:focus');
    await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });

    // Only the back's transform moves; the plays on this device are counted as it starts.
    await expect(page.locator('.card-wrapper.lift-cue .card-back')).toHaveCount(1);
    const props = await page.locator('.card-back').evaluate((el) => el.getAnimations()
      .filter((a) => a instanceof CSSAnimation && a.animationName === 'first-card-lift')
      .flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)))));
    expect([...new Set(props)]).toEqual(['transform']);
    expect(await page.evaluate(() => localStorage.getItem('brainrot-first-card-cue-plays-v1'))).toBe('1');

    // The flip ends it, and the next card never plays it.
    await page.keyboard.press('Space');
    await expect(page.locator('.lift-cue')).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect(card).toHaveAttribute('aria-label', 'Flip card 2 of 5', { timeout: 10000 });
    await expect(page.locator('.lift-cue')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('reduced motion has no lift, only the hint', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'One run is enough.');
    test.setTimeout(60000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await page.getByRole('button', { name: /^Open pack/ }).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.reveal-card:focus')).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
    await expect(page.locator('.tip-text')).toHaveAttribute('data-first-card-cue', 'still');
    await expect(page.locator('.lift-cue')).toHaveCount(0);
    expect(await page.locator('.card-back').evaluate((el) => el.getAnimations().filter((a) => a instanceof CSSAnimation && a.animationName === 'first-card-lift').length)).toBe(0);
    expect(errors).toEqual([]);
  });
});

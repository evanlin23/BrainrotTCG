import { test, expect, type Locator } from '@playwright/test';
import { monitor, scaleText, tapSpace } from './support';

/**
 * The reveal on a phone on its side (#898, DESIGN.md "First-pack flow decision", Reveal): under 500px
 * tall the card takes at least 70% of the screen's height, with the rarity row, hint and Skip in a column
 * beside it, and the X, Skip and the card all within reach. Also the first-card cue: on a new player's
 * first card the back lifts toward the viewer once (only transform), and not again on the next card. At
 * 200% text the side column is capped and scrolls, so the card keeps its size and Skip stays reachable.
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
      await tapSpace(page);
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

    test('at 200% text the card keeps its column and the card and Skip can still be tapped', async ({ page, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-chromium', 'A window-size check; the desktop project runs it once.');
      test.setTimeout(60000);
      const errors = await monitor(page, baseURL!);
      await page.goto('./');
      await scaleText(page, 200);
      expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(32);
      await page.getByRole('button', { name: /^Open pack/ }).focus();
      await page.keyboard.press('Space');
      const card = page.locator('.reveal-card:focus');
      await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
      await tapSpace(page);
      await expect(page.locator('.reveal-rarity .rarity-pill')).toBeVisible();

      // The side column is capped to its share of the stage and scrolls; the card fills the stage's column.
      const stage = await box(page.locator('.active-card-container'));
      const side = await box(page.locator('.reveal-side'));
      const cardBox = await box(card);
      expect(side.width, 'the side column against the stage').toBeLessThanOrEqual(size.width * 0.4);
      expect(cardBox.height, 'the card against its column').toBeGreaterThanOrEqual(stage.height * 0.85);
      expect(cardBox.height, 'the card against the screen\'s height').toBeGreaterThanOrEqual(size.height * 0.5);
      expect(cardBox.width, 'the card keeps its shape').toBeGreaterThan(cardBox.height / 2);
      expect(cardBox.x + cardBox.width, 'the card stays clear of the side column').toBeLessThanOrEqual(side.x);

      // Actionability (visible, stable, enabled, scrolled to, not covered): Skip is reachable by scrolling its column.
      await page.locator('.reveal-skip').click({ trial: true });
      await card.click({ trial: true });
      await card.click();
      await expect(card).toHaveAttribute('aria-label', 'Flip card 2 of 5', { timeout: 10000 });
      expect(errors).toEqual([]);
    });

    test.describe('on a phone, where scrollbars are overlays', () => {
      test.use({ isMobile: true, hasTouch: true });

      test('a column that scrolls fades out under its bottom edge, and its last row clears the fade', async ({ page, baseURL }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop-chromium', 'A window-size check; the desktop project runs it once.');
        test.setTimeout(60000);
        const errors = await monitor(page, baseURL!);
        const side = page.locator('.reveal-side');
        const open = async () => {
          await page.getByRole('button', { name: /^Open pack/ }).focus();
          await page.keyboard.press('Space');
          await expect(page.locator('.reveal-card:focus')).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
          await tapSpace(page);
          await expect(page.locator('.reveal-rarity .rarity-pill')).toBeVisible();
        };
        const measure = () => side.evaluate((node) => {
          const el = node as HTMLElement;
          const style = getComputedStyle(el);
          const last = el.querySelector('.reveal-bottom')!.getBoundingClientRect();
          return {
            gutter: el.offsetWidth - el.clientWidth,
            overflow: el.scrollHeight - el.clientHeight,
            mask: style.maskImage,
            fade: parseFloat(style.paddingBottom),
            lastBottomFromEdge: el.getBoundingClientRect().bottom - last.bottom,
          };
        });
        // At normal text the column fits: nothing scrolls and no row is under the fade.
        await page.goto('./');
        await open();
        const fits = await measure();
        expect(fits.overflow, 'at 100% text the column fits').toBeLessThanOrEqual(0);
        expect(fits.lastBottomFromEdge, 'the last row is clear of the fade').toBeGreaterThanOrEqual(fits.fade - 0.5);

        await page.goto('./');
        await scaleText(page, 200);
        await open();

        // The premise: no scrollbar takes any room, so a styled scrollbar could not be the cue.
        const top = await measure();
        expect(top.gutter, 'an overlay scrollbar takes no width').toBe(0);
        expect(top.overflow, 'at 200% text the column scrolls').toBeGreaterThan(0);
        expect(top.mask, 'the bottom edge fades').toContain('linear-gradient');
        expect(top.fade, 'the fade is 1rem tall (32px at 200% text)').toBe(32);
        expect(top.lastBottomFromEdge, 'the unscrolled column ends under the fade, so it is visibly cut').toBeLessThan(top.fade);

        // At the end of the scroll the last row (Skip) is clear of the fade, whole and tappable.
        await side.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        const end = await measure();
        expect(end.lastBottomFromEdge, 'the last row clears the fade at the end').toBeGreaterThanOrEqual(end.fade - 0.5);
        await page.locator('.reveal-skip').click({ trial: true });
        expect(errors).toEqual([]);
      });

      test('Tabbing to Skip at an in-between text size scrolls it clear of the fade', async ({ page, baseURL }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop-chromium', 'A window-size check; the desktop project runs it once.');
        test.setTimeout(60000);
        const errors = await monitor(page, baseURL!);
        await page.goto('./');
        // Sizes where the column scrolls by a little: Skip's focus scroll used to stop with it inside the fade.
        await scaleText(page, size.height === 360 ? 130 : 120);
        await page.getByRole('button', { name: /^Open pack/ }).focus();
        await page.keyboard.press('Space');
        await expect(page.locator('.reveal-card:focus')).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
        await tapSpace(page);
        await expect(page.locator('.reveal-rarity .rarity-pill')).toBeVisible();
        const skip = page.locator('.reveal-skip');
        for (let i = 0; i < 10 && !(await skip.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
        await expect(skip).toBeFocused();
        const gap = await page.locator('.reveal-side').evaluate((el) => {
          const fade = parseFloat(getComputedStyle(el).paddingBottom);
          return { overflow: el.scrollHeight - el.clientHeight, fade, fromEdge: el.getBoundingClientRect().bottom - el.querySelector('.reveal-skip')!.getBoundingClientRect().bottom };
        });
        expect(gap.overflow, 'the column scrolls at this size').toBeGreaterThan(0);
        expect(gap.fromEdge, 'Skip\'s bottom against the fade').toBeGreaterThanOrEqual(gap.fade - 0.5);
        expect(errors).toEqual([]);
      });
    });
  });
}

test.describe('the first-card cue', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });

  test('lifts the first card\'s back once, with transform only, and not on the next card', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'One run is enough.');
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    // The cue lasts about 1.4 s, so its class is recorded when it lands rather than looked for afterwards.
    await page.addInitScript(() => {
      new MutationObserver(() => {
        if (document.querySelector('.card-wrapper.lift-cue')) (window as unknown as { liftSeen?: boolean }).liftSeen = true;
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
    await page.goto('./');
    await page.getByRole('button', { name: /^Open pack/ }).focus();
    await page.keyboard.press('Space');
    const card = page.locator('.reveal-card:focus');
    await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });

    // The keyframes, read from the stylesheet (a live animation ends after about 1.4 s): only the back's transform
    // moves, and the peak lifts it toward the viewer (up and a little larger, never a tilt).
    await expect.poll(() => page.evaluate(() => (window as unknown as { liftSeen?: boolean }).liftSeen), { message: 'the cue class was applied' }).toBe(true);
    const frames = await page.evaluate(() => {
      const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
      const rule = rules.find((r): r is CSSKeyframesRule => r instanceof CSSKeyframesRule && r.name === 'first-card-lift');
      return rule ? Array.from(rule.cssRules).map((k) => {
        const style = (k as CSSKeyframeRule).style;
        return { key: (k as CSSKeyframeRule).keyText, props: Array.from(style).sort(), transform: style.getPropertyValue('transform') };
      }) : [];
    });
    expect(frames.length, 'the keyframes are in the stylesheet').toBeGreaterThan(0);
    expect([...new Set(frames.flatMap((f) => f.props))]).toEqual(['transform']);
    const peak = frames.find((f) => f.transform !== 'none')!.transform;
    expect(peak, 'a lift up').toMatch(/translateY\(-[\d.]+%\)/);
    expect(Number(/scale\(([\d.]+)\)/.exec(peak)?.[1]), 'a little larger').toBeGreaterThan(1);
    expect(peak, 'not a tilt').not.toMatch(/rotate/);
    expect(await page.evaluate(() => localStorage.getItem('brainrot-first-card-cue-plays-v1'))).toBe('1');

    // The flip ends it, and the next card never plays it.
    await tapSpace(page);
    await expect(page.locator('.lift-cue')).toHaveCount(0);
    await tapSpace(page);
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

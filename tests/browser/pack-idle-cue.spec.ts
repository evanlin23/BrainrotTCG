import { test, expect, type Page } from '@playwright/test';
import { fingerFor, monitor } from './support';

/**
 * The idle cue on a sealed pack (DESIGN.md Flow 2): while the pack sits untouched its top strip lifts
 * a few px every few seconds and settles back, for good, long after the new player's finger has retired.
 * Every check reads state (a class, the animations the browser is running, a computed style, a point's
 * hit target) and none waits for a moment of the loop: the animation is paused and set to a frame.
 * The phone project emulates a Pixel 5 (touch events); it is not a real phone.
 */

const CUE_PLAYS = 'brainrot-open-cue-plays-v1';
const shell = (page: Page) => page.locator('.pack-shell');

/** A returning-looking device: the finger cue has played its twice, so only the idle cue is left. */
async function load(page: Page, { cueDone = true } = {}) {
  if (cueDone) await page.addInitScript((key) => localStorage.setItem(key, '2'), CUE_PLAYS);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(shell(page)).toBeVisible();
}

/** The idle cue's running keyframe animations on the pack's parts, by name. */
const idleAnimations = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.pack-half-top, .pack-top-piece, .pack-half-bottom')).flatMap((el) =>
      el.getAnimations().filter((a): a is CSSAnimation => a instanceof CSSAnimation && a.animationName.startsWith('pack-idle-') && a.playState === 'running').map((a) => a.animationName),
    ).sort(),
  );

test('a sealed pack waiting for a touch lifts its top strip, and puts it down for a press and a short swipe', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await load(page);
  await shell(page).scrollIntoViewIfNeeded();

  await expect(shell(page)).toHaveClass(/\bis-idle\b/);
  await expect.poll(() => idleAnimations(page)).toEqual(['pack-idle-piece', 'pack-idle-seat', 'pack-idle-strip']);

  // A press on the tear line puts the strip down; a short swipe lets go, and the idle cue waits for the hint to go too.
  const box = (await shell(page).boundingBox())!;
  const y = box.y + box.height * 0.19;
  const finger = await fingerFor(page, hasTouch);
  await finger.press(box.x + box.width * 0.45, y);
  await expect(shell(page)).toHaveClass(/\bis-pressed\b|\bis-cutting\b/);
  await expect(shell(page)).not.toHaveClass(/\bis-idle\b/);
  expect(await idleAnimations(page)).toEqual([]);
  for (let step = 1; step <= 6; step++) await finger.move(box.x + box.width * (0.45 + (0.1 * step) / 6), y);
  await finger.release();
  await expect(shell(page)).toHaveClass(/\bis-short\b/);
  await expect(shell(page)).not.toHaveClass(/\bis-idle\b/);
  expect(await idleAnimations(page)).toEqual([]);

  // The hint clears by itself and the strip starts lifting again.
  await expect(shell(page)).toHaveClass(/\bis-idle\b/);
  await expect.poll(() => idleAnimations(page)).toEqual(['pack-idle-piece', 'pack-idle-seat', 'pack-idle-strip']);
  expect(errors).toEqual([]);
});

test('at the top of its lift the strip is up and the bottom half has made room, with the pack and its tear line unmoved', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await load(page);
  await shell(page).scrollIntoViewIfNeeded();
  await expect.poll(() => idleAnimations(page)).toHaveLength(3);

  const before = (await shell(page).boundingBox())!;
  const atRest = await page.evaluate(() => {
    const pick = (selector: string) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return { transform: style.transform, opacity: style.opacity, clip: style.clipPath };
    };
    return { strip: pick('.pack-half-top'), bottom: pick('.pack-half-bottom') };
  });

  // Hold every idle animation at the middle of its lift (about two thirds of the way round).
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('.pack-half-top, .pack-top-piece, .pack-half-bottom'))) {
      for (const animation of el.getAnimations()) {
        if (!(animation instanceof CSSAnimation) || !animation.animationName.startsWith('pack-idle-')) continue;
        animation.pause();
        animation.currentTime = Number(animation.effect!.getComputedTiming().duration) * 0.67;
      }
    }
  });
  const lifted = await page.evaluate(() => {
    const pick = (selector: string) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return { transform: style.transform, opacity: style.opacity, clip: style.clipPath };
    };
    const tear = document.querySelector('.tear-guide')!.getBoundingClientRect();
    const hit = document.elementFromPoint(tear.left + tear.width / 2, tear.top + tear.height / 2);
    return { strip: pick('.pack-half-top'), piece: pick('.pack-top-piece'), bottom: pick('.pack-half-bottom'), hitsPack: !!hit?.closest('.pack-shell'), tearTop: tear.top };
  });

  expect(atRest.strip.opacity).toBe('0');
  expect(lifted.strip.opacity).toBe('1');
  expect(lifted.strip.transform).not.toBe('none');
  expect(lifted.strip.transform).toBe(lifted.piece.transform);
  expect(Number(lifted.strip.transform.replace(/^matrix\(|\)$/g, '').split(',')[5])).toBeLessThan(0);
  expect(lifted.bottom.clip).not.toBe(atRest.bottom.clip);
  expect(lifted.hitsPack, 'the tear line still lands on the pack').toBe(true);
  expect(await shell(page).boundingBox()).toEqual(before);
  expect(errors).toEqual([]);
});

test('under reduced motion nothing animates and the strip is held a hair open along the tear line', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page);
  await expect(shell(page)).toHaveClass(/\bis-idle\b/);
  expect(await idleAnimations(page)).toEqual([]);
  const still = await page.evaluate(() => {
    const strip = getComputedStyle(document.querySelector('.pack-half-top')!);
    const bottom = getComputedStyle(document.querySelector('.pack-half-bottom')!);
    return { opacity: strip.opacity, transform: strip.transform, bottomClip: bottom.clipPath };
  });
  expect(still.opacity).toBe('1');
  expect(still.transform).not.toBe('none');
  expect(still.bottomClip).not.toBe('inset(0px)');
  expect(errors).toEqual([]);
});

test('a first-time player sees the finger first, and the strip starts lifting when it has retired', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await load(page, { cueDone: false });
  await expect(shell(page)).toHaveAttribute('data-open-cue', 'play');
  await expect(shell(page)).not.toHaveClass(/\bis-idle\b/);
  expect(await idleAnimations(page)).toEqual([]);

  // Finishing the finger's animation ends the cue, as in open-cue.spec.ts.
  await page.evaluate(() => document.querySelectorAll('.open-cue-travel, .open-cue-tear').forEach((target) => target.getAnimations().forEach((animation) => animation.finish())));
  await expect(shell(page)).not.toHaveAttribute('data-open-cue', /.+/);
  await expect(shell(page)).toHaveClass(/\bis-idle\b/);
  await expect.poll(() => idleAnimations(page)).toHaveLength(3);
  expect(errors).toEqual([]);
});

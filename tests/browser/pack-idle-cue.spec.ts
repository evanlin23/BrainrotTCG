import { test, expect, type Page } from '@playwright/test';
import { fingerFor, monitor } from './support';
import { finishOpenCue, holdOpenCue } from './openCue';

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
    Array.from(document.querySelectorAll('.pack-half-top, .pack-top-piece')).flatMap((el) =>
      el.getAnimations().filter((a): a is CSSAnimation => a instanceof CSSAnimation && a.animationName.startsWith('pack-idle-') && a.playState === 'running').map((a) => a.animationName),
    ).sort(),
  );

test('a sealed pack waiting for a touch lifts its top strip, and puts it down for a press and a short swipe', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await load(page);
  await shell(page).scrollIntoViewIfNeeded();

  await expect(shell(page)).toHaveClass(/\bis-idle\b/);
  await expect.poll(() => idleAnimations(page)).toEqual(['pack-idle-lift', 'pack-idle-lift']);

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
  await expect.poll(() => idleAnimations(page)).toEqual(['pack-idle-lift', 'pack-idle-lift']);
  expect(errors).toEqual([]);
});

test('a key that tears the pack mid-lift still slides the strip away, as a swipe or a tap does', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  // The fixture player, and a log of every transform transition the stylesheet starts on the torn strip.
  await page.addInitScript((origin) => {
    (window as unknown as { slid: string[] }).slid = [];
    document.addEventListener('transitionrun', (event) => {
      const name = event.target instanceof Element ? event.target.className.toString().split(' ').pop()! : '';
      if (event.propertyName === 'transform' && /^pack-(half-top|top-piece)$/.test(name)) (window as unknown as { slid: string[] }).slid.push(name);
    }, true);
    if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 21, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
  }, new URL(baseURL!).origin);
  const errors = await monitor(page, baseURL!);
  await load(page);

  // The cue is running: the key meets the strip mid-animation, which is what Chrome treats as no transition.
  await expect.poll(() => idleAnimations(page)).toEqual(['pack-idle-lift', 'pack-idle-lift']);
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(shell(page)).toHaveClass(/\bis-cut\b/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { slid: string[] }).slid.sort())).toEqual(['pack-half-top', 'pack-top-piece']);
  expect(errors).toEqual([]);
});

/** Holds every idle animation at a share of its period (0 is the pack at rest, 0.67 the top of the lift). */
const holdAt = (page: Page, share: number) =>
  page.evaluate((at) => {
    for (const el of Array.from(document.querySelectorAll('.pack-half-top, .pack-top-piece'))) {
      for (const animation of el.getAnimations()) {
        if (!(animation instanceof CSSAnimation) || !animation.animationName.startsWith('pack-idle-')) continue;
        animation.pause();
        animation.currentTime = Number(animation.effect!.getComputedTiming().duration) * at;
      }
    }
  }, share);

/** What the browser draws for the pack's parts right now. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const pick = (selector: string) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return { transform: style.transform, opacity: style.opacity, clip: style.clipPath };
    };
    const tear = document.querySelector('.tear-guide')!.getBoundingClientRect();
    const hit = document.elementFromPoint(tear.left + tear.width / 2, tear.top + tear.height / 2);
    const shellBox = document.querySelector('.pack-shell')!.getBoundingClientRect();
    return { strip: pick('.pack-half-top'), piece: pick('.pack-top-piece'), bottom: pick('.pack-half-bottom'), hitsPack: !!hit?.closest('.pack-shell'), tearTop: tear.top, shellHeight: shellBox.height };
  });

const translateY = (transform: string) => (transform === 'none' ? 0 : Number(transform.replace(/^matrix\(|\)$/g, '').split(',')[5]));

test('at the top of its lift the strip is up by its share of the pack, and the bottom half, the pack and its tear line have not moved', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await load(page);
  await shell(page).scrollIntoViewIfNeeded();
  await expect.poll(() => idleAnimations(page)).toHaveLength(2);

  // Rest is read with the loop held at its start, so it does not depend on where a slow runner has got to.
  await holdAt(page, 0);
  const atRest = await drawn(page);
  const before = (await shell(page).boundingBox())!;
  await holdAt(page, 0.67);
  const lifted = await drawn(page);

  // At rest the strip is seated on the bottom half; at the top of the lift it is up by 1.5% of the pack and the piece is with it.
  expect(translateY(atRest.strip.transform)).toBe(0);
  expect(translateY(atRest.piece.transform)).toBe(0);
  expect(translateY(lifted.strip.transform)).toBeCloseTo(-lifted.shellHeight * 0.015, 0);
  expect(lifted.piece.transform).toBe(lifted.strip.transform);
  // Nothing else changes: the strip's opacity and the bottom half's clip are the same, so no frame runs on the main thread.
  expect(lifted.strip.opacity).toBe(atRest.strip.opacity);
  expect(lifted.bottom).toEqual(atRest.bottom);
  expect(lifted.hitsPack, 'the tear line still lands on the pack').toBe(true);
  expect(lifted.tearTop).toBe(atRest.tearTop);
  expect(await shell(page).boundingBox()).toEqual(before);

  // The animation names only transform, so the browser can run it off the main thread.
  const properties = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pack-half-top, .pack-top-piece')).flatMap((el) =>
      el.getAnimations().flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes().flatMap((frame) => Object.keys(frame))),
    ),
  );
  expect([...new Set(properties)].filter((name) => !['offset', 'easing', 'composite', 'computedOffset'].includes(name))).toEqual(['transform']);
  expect(errors).toEqual([]);
});

test('under reduced motion nothing animates and the seam shows a still perforation, with no gap', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page);
  await expect(shell(page)).toHaveClass(/\bis-idle\b/);
  expect(await idleAnimations(page)).toEqual([]);
  const still = await page.evaluate(() => {
    const mark = getComputedStyle(document.querySelector('.pack-top-piece')!, '::after');
    return { strip: getComputedStyle(document.querySelector('.pack-half-top')!).transform, piece: getComputedStyle(document.querySelector('.pack-top-piece')!).transform, content: mark.content, border: mark.borderTopStyle };
  });
  expect(still.strip).toBe('none');
  expect(still.piece).toBe('none');
  expect(still.content).toBe('""');
  expect(still.border).toBe('dashed');
  expect(errors).toEqual([]);
});

test('with motion the pack draws no perforation of its own: the lift is the cue', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await load(page);
  await expect(shell(page)).toHaveClass(/\bis-idle\b/);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pack-top-piece')!, '::after').content)).toBe('none');
  expect(errors).toEqual([]);
});

test('a first-time player sees the finger first, and the strip starts lifting when it has retired', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await holdOpenCue(page);
  await load(page, { cueDone: false });
  await expect(shell(page)).toHaveAttribute('data-open-cue', 'play');
  await expect(shell(page)).not.toHaveClass(/\bis-idle\b/);
  expect(await idleAnimations(page)).toEqual([]);

  // Retire the held finger through its real animationend, then the idle strip can start.
  await finishOpenCue(page);
  await expect(shell(page)).not.toHaveAttribute('data-open-cue', /.+/);
  await expect(shell(page)).toHaveClass(/\bis-idle\b/);
  await expect.poll(() => idleAnimations(page)).toHaveLength(2);
  expect(errors).toEqual([]);
});

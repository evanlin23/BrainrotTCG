import { test, expect, type Page } from '@playwright/test';
import { expectSummaryTakesClicks, fingerFor, monitor, tapSpace } from './support';

/**
 * The screens that untilIdle (support.ts) is called on never stop animating: a sealed pack's foil and
 * idle lift run for as long as it is up. An animation of any property but transform or opacity is
 * repainted or laid out by the main thread on every frame, and that leaves no idle time for
 * requestIdleCallback, which is how untilIdle ends. Under load a wait for idle then hung for a minute
 * (pack-exit.spec.ts). Only the compositor can run an endless animation without taking the main thread,
 * so this reads each screen's endless animations and checks what they animate. It waits for nothing
 * but the screen itself, and a frame of timing decides nothing.
 */

/**
 * What Chromium runs on the compositor without the main thread: the transform family, opacity, and
 * filter and backdrop-filter (it composites those too). Anything else, such as background-position or
 * a box-shadow, is repainted or laid out by the main thread on every frame.
 */
const COMPOSITED = ['backdrop-filter', 'filter', 'opacity', 'rotate', 'scale', 'transform', 'translate'];

/** Every animation on the page that never ends, with the properties its keyframes set. */
function endlessAnimations(page: Page) {
  return page.evaluate(() => document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity)
    .flatMap((animation) => {
      const effect = animation.effect as KeyframeEffect;
      const target = effect.target as Element;
      const properties = [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))]
        .filter((name) => !['offset', 'computedOffset', 'easing', 'composite'].includes(name)).sort();
      return [{ animation: (animation as CSSAnimation).animationName, on: `${target.tagName.toLowerCase()}${effect.pseudoElement ?? ''}`, properties }];
    }));
}

/** Fails with the offending animations, named, rather than a bare count. */
async function expectCompositorOnly(page: Page) {
  const running = await endlessAnimations(page);
  const offenders = running.filter(({ properties }) => properties.some((name) => !COMPOSITED.includes(name)));
  expect(offenders, `endless animations that the main thread repaints or lays out every frame (only ${COMPOSITED.join(' and ')} are allowed)`).toEqual([]);
  return running;
}

test('the packs screen runs its endless animations on the compositor, whichever pack foil is on', async ({ page, baseURL }) => {
  await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(page.locator('.pack-shell')).toBeVisible();
  // The standard foil paints nothing and doesn't move; each of the others slides on both pack halves, so
  // the check isn't passing for want of an animation to read.
  for (const [foil, halves] of [['standard', 0], ['shimmer', 2], ['gold', 2], ['prism', 2]] as const) {
    await page.evaluate((name) => { document.documentElement.dataset.packFoil = name; }, foil);
    const running = await expectCompositorOnly(page);
    expect(running.filter(({ animation }) => animation === 'pack-foil'), `${foil}: the pack halves' foil`).toHaveLength(halves);
  }
});

test('in-app Reduced motion stills endless animations and the ceremony with the device allowing motion', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const origin = new URL(baseURL!).origin;
  await page.addInitScript((origin) => {
    if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 22, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ motion: 'reduced', effectsVolume: 0 }));
    localStorage.setItem('brainrot-stats-v1', JSON.stringify({ packsOpened: 22, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
  }, origin);
  await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.locator('.pack-shell');
  await expect(packShell).toBeVisible();
  await expect(packShell).toHaveClass(/\bis-idle\b/);

  const animName = (selector: string, pseudo?: string) =>
    page.evaluate(({ selector, pseudo }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      return window.getComputedStyle(el, pseudo).animationName;
    }, { selector, pseudo });

  // 1. Pack idle lift:
  expect(await animName('.pack-shell.is-idle .pack-half-top')).toBe('none');
  // Positive control:
  await page.evaluate(() => { document.documentElement.removeAttribute('data-motion'); });
  expect(await animName('.pack-shell.is-idle .pack-half-top')).toBe('pack-idle-lift');
  await page.evaluate(() => { document.documentElement.setAttribute('data-motion', 'reduced'); });
  expect(await animName('.pack-shell.is-idle .pack-half-top')).toBe('none');

  // 2. Pack foil: standard, shimmer, gold, prism
  for (const foil of ['standard', 'shimmer', 'gold', 'prism'] as const) {
    await page.evaluate((name) => { document.documentElement.dataset.packFoil = name; }, foil);
    expect(await animName('.pack-foil', '::before'), `${foil} pack foil under in-app reduced motion`).toBe('none');
    // Positive control:
    await page.evaluate(() => { document.documentElement.removeAttribute('data-motion'); });
    const expected = foil === 'standard' ? 'none' : 'pack-foil';
    expect(await animName('.pack-foil', '::before'), `${foil} pack foil without reduced motion`).toBe(expected);
    await page.evaluate(() => { document.documentElement.setAttribute('data-motion', 'reduced'); });
    expect(await animName('.pack-foil', '::before')).toBe('none');
  }

  // 3. Cut line: drag across tear line so .cut-line is drawn
  const box = (await packShell.boundingBox())!;
  const y = box.y + box.height * 0.19;
  const finger = await fingerFor(page, hasTouch);
  await finger.press(box.x + box.width * 0.4, y);
  for (let step = 1; step <= 6; step++) {
    await finger.move(box.x + box.width * (0.4 + (0.1 * step) / 6), y);
  }
  await expect(page.locator('.cut-line')).toBeAttached();
  expect(await animName('.cut-line')).toBe('none');
  // Positive control:
  await page.evaluate(() => { document.documentElement.removeAttribute('data-motion'); });
  expect(await animName('.cut-line')).toBe('seam-shimmer');
  await page.evaluate(() => { document.documentElement.setAttribute('data-motion', 'reduced'); });
  expect(await animName('.cut-line')).toBe('none');
  await finger.release();

  // 4. Open the pack to the big pull celebration (nonce 22).
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });

  // Waiting for the showcase halo (big pull ceremony).
  const halo = page.locator('.showcase-halo');
  await expect(halo).toBeVisible({ timeout: 15000 });

  // Showcase halo and rays, read in one pass: the halo and its rays under in-app reduced motion, again
  // with the attribute removed (positive control), and again once it is back. getComputedStyle resolves
  // style synchronously, so each read sees the attribute as it was just set. A missing halo throws.
  const haloNames = await page.evaluate(() => {
    const el = document.querySelector('.showcase-halo');
    if (!el) throw new Error('Element not found: .showcase-halo');
    const root = document.documentElement;
    const read = () => ({
      halo: window.getComputedStyle(el).animationName,
      rays: window.getComputedStyle(el, '::before').animationName,
    });
    const reduced = read();
    root.removeAttribute('data-motion');
    try {
      const allowed = read();
      root.setAttribute('data-motion', 'reduced');
      return { reduced, allowed, restored: read() };
    } finally {
      root.setAttribute('data-motion', 'reduced');
    }
  });
  expect(haloNames).toEqual({
    reduced: { halo: 'none', rays: 'none' },
    allowed: { halo: 'showcase-halo', rays: 'showcase-rays' },
    restored: { halo: 'none', rays: 'none' },
  });
});

test('the reveal, the summary and a card opened over it run their endless animations on the compositor', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5');
  await expectCompositorOnly(page);

  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectSummaryTakesClicks(page);
  await expectCompositorOnly(page);

  await page.locator('.summary-card').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectCompositorOnly(page);
});

for (const route of ['cards', 'rankings']) {
  test(`the ${route} page runs its endless animations on the compositor`, async ({ page, baseURL }) => {
    await monitor(page, baseURL!, 0, { returning: true });
    await page.goto(`./#/${route}`);
    await expect(page.locator('main.page')).toBeVisible();
    await expect(page.locator('.page-skeleton')).toHaveCount(0, { timeout: 15000 });
    await expectCompositorOnly(page);
  });
}

test('the pack foil previews on the profile page slide on the compositor too', async ({ page, baseURL }) => {
  await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./#/profile');
  await expect(page.locator('main.page')).toBeVisible();
  await expect(page.locator('.page-skeleton')).toHaveCount(0, { timeout: 15000 });
  await page.locator('#rewards summary').click();
  await expect(page.locator('.foil-swatch')).toHaveCount(4);
  const running = await expectCompositorOnly(page);
  // Shimmer, gold and prism slide; the standard swatch has no foil to move.
  expect(running.filter(({ animation }) => animation === 'pack-foil')).toHaveLength(3);
});

/**
 * The 3 s celebration (SPECIAL_REVEAL_DURATION_MS) is a player's choice to hold, so Reduced motion keeps its input
 * lock to the millisecond; what it must not keep is a tween on that clock (#1289). The fixture key's nonce 8 deals a
 * Brainrot as the pack's last card. Every read is on the page's clock, so there is no 3 s wait and no race with the
 * celebration's own end. A big card lands on a scale of 1.03 (CardRevealUI); under Reduced it must be there a few
 * frames after the flip, not 3 s later. (CardRevealUI.motion.test.tsx pins the tween's own settings; framer-motion's
 * MotionConfig also makes transforms instant here, so this is the whole-app check that nothing brings it back.)
 */
const LOCK_MS = 3000;
const FRAME_MS = 16;
/** Frames to allow for the flip to reach the card: React renders and runs its effects in real time, outside the page's clock. */
const MAX_FRAMES = 8;
const BIG_SCALE = 1.03;

const cases = [
  { name: 'in-app Reduced motion with the device allowing motion', os: 'no-preference', settings: { motion: 'reduced' }, pause: true },
  { name: 'the device asking for reduced motion', os: 'reduce', settings: {}, pause: true },
  { name: 'in-app Reduced motion with Pause on good pulls off', os: 'no-preference', settings: { motion: 'reduced', pauseBigPulls: false }, pause: false },
] as const;

for (const { name, os, settings, pause } of cases) {
  test(`a Brainrot's flip settles at once under ${name}, and the hold is the setting's`, async ({ page, baseURL }) => {
    test.setTimeout(90000);
    await page.emulateMedia({ reducedMotion: os });
    await page.clock.install();
    await page.addInitScript(({ origin, settings }) => {
      if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
      localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 8, createdAt: 1 }));
      localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0, ...settings }));
    }, { origin: new URL(baseURL!).origin, settings });
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();

    // Reveal the four cards before the Brainrot, leaving it face down.
    await page.getByRole('button', { name: /^Open pack/ }).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
    const card = page.locator('.reveal-card:focus');
    for (let i = 1; i <= 4; i++) {
      await expect(card).toHaveAttribute('aria-label', `Flip card ${i} of 5`, { timeout: 10000 });
      await tapSpace(page);
      await expect(card).toHaveAttribute('aria-label', /^Next card\. /);
      await tapSpace(page);
    }
    await expect(card).toHaveAttribute('aria-label', 'Flip card 5 of 5', { timeout: 10000 });

    // Frozen from here: the flip is one instant, and only the test moves the clock.
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 2000));
    await tapSpace(page);
    await expect(page.locator('.reveal-card.is-celebrating')).toHaveCount(1);
    // Step the page's frames until the card's scale stops changing, writing down every value it takes on the way.
    const scales: number[] = [];
    let elapsed = 0;
    while (elapsed < MAX_FRAMES * FRAME_MS) {
      await page.clock.runFor(FRAME_MS);
      elapsed += FRAME_MS;
      scales.push(await page.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.reveal-card.is-celebrating')!).transform).a));
      if (scales.at(-1) === BIG_SCALE) break;
    }
    expect(scales.at(-1), `a big card is still on its way to its end scale after ${elapsed}ms: ${scales.join(', ')}`).toBe(BIG_SCALE);
    // (The card's own 0.22s entrance, if a frame still owes it, is below 1; nothing may sit between 1 and the end scale or past it.)
    expect(scales.every((value) => value <= 1 || value === BIG_SCALE), `a big card tweens its scale: ${scales.join(', ')}`).toBe(true);

    const stage = page.locator('.active-card-container');
    if (pause) {
      // The lock lasts exactly SPECIAL_REVEAL_DURATION_MS, Reduced or not: a tap does nothing up to its last millisecond.
      await expect(stage).toHaveAttribute('aria-busy', 'true');
      await page.clock.runFor(LOCK_MS - 1 - elapsed);
      await tapSpace(page);
      await expect(page.locator('.takeover-banner')).toHaveCount(1);
      await expect(stage).toHaveAttribute('aria-busy', 'true');
      await page.clock.runFor(1);
      await expect(stage).toHaveAttribute('aria-busy', 'false');
    } else {
      // Nothing holds the reveal: the first tap settles the takeover on the spot.
      await expect(stage).toHaveAttribute('aria-busy', 'false');
    }
    await tapSpace(page);
    await expect(page.locator('.takeover-banner')).toHaveCount(0);
    await expect(page.locator('.pack-top-count')).toHaveText('Card 5 of 5');
    await page.clock.resume();
    expect(errors).toEqual([]);
  });
}

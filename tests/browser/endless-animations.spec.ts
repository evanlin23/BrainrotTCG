import { test, expect, type Page } from '@playwright/test';
import { expectSummaryTakesClicks, monitor } from './support';

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

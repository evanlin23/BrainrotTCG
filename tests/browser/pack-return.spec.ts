import { test, expect, type Page } from '@playwright/test';
import { expectPackDropped, monitor } from './support';

/**
 * The sealed pack's entrance (#720). It falls in from above the header only the first time the packs
 * screen appears after the page loads; every return from a pack (Back from the summary, Next pack, the
 * summary's X and Escape) rises a few pixels while it fades in instead, so it never passes over the
 * header or the gear and takes a tap as soon as it is at rest. Under reduced motion a return is instant.
 */

interface Frame { top: number; rest: boolean; y: number; rotate: number; opacity: number }

const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });

/**
 * Starts recording the entering stage on every animation frame: its top edge, and the transform and
 * opacity it is painted with. The stage still leaving (marked by the motion library) is not the one measured.
 */
async function recordStage(page: Page) {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    const run = { frames, stop: false };
    (window as unknown as { __stage: typeof run }).__stage = run;
    const sample = () => {
      const stage = document.querySelector<HTMLElement>('.pack-display:not([data-motion-pop-id])');
      if (stage) {
        const style = getComputedStyle(stage);
        const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
        frames.push({
          top: stage.getBoundingClientRect().top,
          rest: style.transform === 'none' && style.opacity === '1',
          y: matrix.m42,
          rotate: Math.atan2(matrix.b, matrix.a),
          opacity: Number(style.opacity),
        });
      }
      if (!run.stop) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopRecording(page: Page) {
  return page.evaluate(() => {
    const run = (window as unknown as { __stage: { frames: Frame[]; stop: boolean } }).__stage;
    run.stop = true;
    return run.frames;
  });
}

/** Opens a pack, and for the summary paths skips the reveal, ending where the player leaves from. */
async function reachSummary(page: Page) {
  await openPack(page).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Skip opening animation' }).click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 15000 });
}

const returns = [
  ['browser Back from the summary', async (page: Page) => { await reachSummary(page); await recordStage(page); await page.goBack(); }],
  ['Next pack', async (page: Page) => { await reachSummary(page); await recordStage(page); await page.getByRole('button', { name: 'Next pack' }).click(); }],
  ['the summary X', async (page: Page) => { await reachSummary(page); await recordStage(page); await page.getByRole('button', { name: 'Back to packs', exact: true }).click(); }],
  ['Escape', async (page: Page) => {
    await openPack(page).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
    await recordStage(page);
    await page.keyboard.press('Escape');
  }],
] as const;

for (const [name, leave] of returns) {
  test(`after ${name} the pack rises in without passing over the header, then takes a tap`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await expectPackDropped(page);
    const home = (await page.locator('.pack-display').boundingBox())!.y;

    await leave(page);
    await expect(page.locator('.card-reveal-area')).toHaveCount(0, { timeout: 15000 });
    await expect(openPack(page)).toBeVisible({ timeout: 15000 });
    await expectPackDropped(page);
    const frames = await stopRecording(page);

    const entering = frames.filter((frame) => frame.opacity < 1 || !frame.rest);
    for (const frame of entering) {
      // Never above where it rests, which is below the header and the gear, and never turned.
      expect(frame.y, 'the pack rose from above instead of below').toBeGreaterThanOrEqual(0);
      expect(frame.top, 'the pack passed above its resting place').toBeGreaterThanOrEqual(home - 1);
      expect(frame.rotate, 'the pack turned while entering').toBe(0);
    }
    const last = frames.at(-1)!;
    expect(last.rest, 'the pack settled').toBe(true);

    // At rest it takes a tap: nothing is left over it.
    await openPack(page).click();
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  });
}

test('the first arrival on the packs screen still falls in from above the header', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.addInitScript(() => {
    const frames: { y: number; rotate: number; opacity: number }[] = [];
    (window as unknown as { __fall: typeof frames }).__fall = frames;
    const sample = () => {
      const stage = document.querySelector<HTMLElement>('.pack-display:not([data-motion-pop-id])');
      if (stage) {
        const style = getComputedStyle(stage);
        const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
        frames.push({ y: matrix.m42, rotate: Math.atan2(matrix.b, matrix.a), opacity: Number(style.opacity) });
      }
      if (!frames.length || frames.at(-1)!.y !== 0 || frames.at(-1)!.opacity !== 1) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectPackDropped(page);
  const frames = await page.evaluate(() => (window as unknown as { __fall: { y: number; rotate: number; opacity: number }[] }).__fall);
  expect(Math.min(...frames.map((frame) => frame.y)), 'the pack began above the screen').toBeLessThan(0);
  expect(Math.min(...frames.map((frame) => frame.rotate)), 'the pack began tilted').toBeLessThan(0);
  expect(errors).toEqual([]);
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a return shows the pack at rest at once, with no fade or rise', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await expectPackDropped(page);

    await openPack(page).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
    await recordStage(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.card-reveal-area')).toHaveCount(0, { timeout: 15000 });
    await expect(openPack(page)).toBeVisible({ timeout: 15000 });
    await expectPackDropped(page);
    const frames = await stopRecording(page);

    expect(frames.length, 'the returning stage was seen').toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.rest, 'the returning pack was not at rest in its first frame').toBe(true);
    }
    expect(errors).toEqual([]);
  });
});

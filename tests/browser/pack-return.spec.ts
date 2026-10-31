import { test, expect, type Page } from '@playwright/test';
import { expectDecoded, expectPackDropped, monitor } from './support';

/**
 * The sealed pack's entrance (#720). It falls in from above the header only the first time the packs
 * screen is on screen after the page loads; every return from a pack (Back from the summary, Open again,
 * the summary's X and Escape) rises a few pixels while it fades in instead, so it never passes over the
 * header or the gear and takes a tap as soon as it is at rest. Under reduced motion a return is instant.
 *
 * A recorder runs from the start of the page. It notes the inline style of every pack stage in the same
 * microtask that adds it to the page, before any frame can move it, which is the shape of its entrance,
 * and the painted position of the stage on every animation frame it is visible.
 */

interface Entry { transform: string; opacity: string }
interface Frame { top: number; rest: boolean; y: number; rotate: number; opacity: number }
interface Recording { entries: Entry[]; frames: Frame[] }

const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });
const navButton = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name });

function installRecorder(page: Page) {
  return page.addInitScript(() => {
    const run: Recording = { entries: [], frames: [] };
    (window as unknown as { __stage: Recording }).__stage = run;
    const note = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      const stages = node.matches('.pack-display') ? [node] : Array.from(node.querySelectorAll<HTMLElement>('.pack-display'));
      for (const stage of stages) run.entries.push({ transform: stage.style.transform, opacity: stage.style.opacity });
    };
    new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(note);
    }).observe(document, { subtree: true, childList: true });
    const sample = () => {
      const stage = document.querySelector<HTMLElement>('.pack-display');
      if (stage?.checkVisibility()) {
        const style = getComputedStyle(stage);
        const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
        run.frames.push({
          top: stage.getBoundingClientRect().top,
          rest: style.transform === 'none' && style.opacity === '1',
          y: matrix.m42,
          rotate: Math.atan2(matrix.b, matrix.a),
          opacity: Number(style.opacity),
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

/** Forgets what was recorded so far, so only the entrance that follows is judged. */
function forgetStage(page: Page) {
  return page.evaluate(() => {
    const run = (window as unknown as { __stage: Recording }).__stage;
    run.entries.length = 0;
    run.frames.length = 0;
  });
}

/** The stage is at rest on screen and the recorder has seen it so, so what it holds covers the whole entrance. */
async function expectRecordedAtRest(page: Page) {
  await expectPackDropped(page);
  await page.waitForFunction(() => (window as unknown as { __stage: Recording }).__stage.frames.at(-1)?.rest === true);
}

function recorded(page: Page) {
  return page.evaluate(() => {
    const run = (window as unknown as { __stage: Recording }).__stage;
    return { entries: [...run.entries], frames: [...run.frames] };
  });
}

/**
 * Opens a pack and waits until the torn one has left the page: a stage that comes back while its exit is
 * still running is the same element rather than a new entrance, which the unit tests cover.
 */
async function intoReveal(page: Page) {
  await openPack(page).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pack-display')).toHaveCount(0);
}

/** Opens a pack and skips the reveal, ending where the player leaves from. */
async function reachSummary(page: Page) {
  await intoReveal(page);
  await page.getByRole('button', { name: 'Skip opening animation' }).click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 15000 });
}

const returns = [
  ['browser Back from the summary', async (page: Page) => { await reachSummary(page); await forgetStage(page); await page.goBack(); }],
  ['Open again', async (page: Page) => { await reachSummary(page); await forgetStage(page); await page.getByRole('button', { name: /^Open .+ again$/ }).click(); }],
  ['the summary X', async (page: Page) => { await reachSummary(page); await forgetStage(page); await page.getByRole('button', { name: 'Back to packs', exact: true }).click(); }],
  ['Escape', async (page: Page) => { await intoReveal(page); await forgetStage(page); await page.keyboard.press('Escape'); }],
] as const;

for (const [name, leave] of returns) {
  test(`after ${name} the pack rises in without passing over the header, then takes a tap`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    await installRecorder(page);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await expectPackDropped(page);
    const home = (await page.locator('.pack-display').boundingBox())!.y;

    await leave(page);
    await expect(page.locator('.card-reveal-area')).toHaveCount(0, { timeout: 15000 });
    await expect(openPack(page)).toBeVisible({ timeout: 15000 });
    await expectRecordedAtRest(page);
    const { entries, frames } = await recorded(page);

    // The one stage that came back began a few pixels below its place and invisible, never above or turned.
    expect(entries, 'one new stage came back').toEqual([{ transform: 'translateY(24px)', opacity: '0' }]);
    expect(frames.length, 'the returning stage was seen').toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.y, 'the pack rose from above instead of below').toBeGreaterThanOrEqual(0);
      expect(frame.top, 'the pack passed above its resting place').toBeGreaterThanOrEqual(home - 1);
      expect(frame.rotate, 'the pack turned while entering').toBe(0);
    }
    expect(frames.at(-1)!.rest, 'the pack settled').toBe(true);

    // The wrapper art is painted, not just the stage that holds it (#720), and a tap takes at rest.
    await expectDecoded(page.locator('.pack-shell').locator('img'), 2);
    await expect(page.locator('.pack-shell')).toBeVisible();
    await openPack(page).click();
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  });
}

test('the first arrival on the packs screen still falls in from above the header', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await installRecorder(page);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectRecordedAtRest(page);
  const { entries, frames } = await recorded(page);
  expect(entries, 'one stage arrived').toHaveLength(1);
  expect(entries[0].transform, 'the pack began above the screen').toContain('-100vh');
  expect(entries[0].transform, 'the pack began tilted').toContain('rotate(-10deg)');
  expect(Math.min(...frames.map((frame) => frame.y)), 'the pack was seen above its place').toBeLessThan(0);
  expect(errors).toEqual([]);
});

test('a load straight into another page saves the fall for the first time the packs screen is shown', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await installRecorder(page);
  await page.goto('./#/cards');
  await expect(page.getByRole('main', { name: 'Cards', exact: true })).toBeVisible();
  // The stage is mounted under the page, waiting where the fall begins; nothing of it has been on screen.
  // A fall that had begun would have moved it off its first style within a few frames, so it is read after some.
  const waiting = (await recorded(page)).entries[0];
  await page.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const next = () => (++frames < 8 ? requestAnimationFrame(next) : resolve());
    requestAnimationFrame(next);
  }));
  expect(await page.locator('.pack-display').evaluate((el) => ({ transform: el.style.transform, opacity: el.style.opacity })), 'the fall ran under the page').toEqual(waiting);
  expect((await recorded(page)).frames, 'the stage was on screen under a page').toHaveLength(0);

  await navButton(page, 'Open').click();
  await expect(openPack(page)).toBeVisible();
  await expectRecordedAtRest(page);
  const { entries, frames } = await recorded(page);
  expect(entries[0].transform, 'the pack began above the screen').toContain('-100vh');
  expect(Math.min(...frames.map((frame) => frame.y)), 'the fall was seen').toBeLessThan(0);

  await openPack(page).click();
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a return shows the pack at rest at once, with no fade or rise', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    await installRecorder(page);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await expectPackDropped(page);

    await intoReveal(page);
    await forgetStage(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.card-reveal-area')).toHaveCount(0, { timeout: 15000 });
    await expect(openPack(page)).toBeVisible({ timeout: 15000 });
    await expectRecordedAtRest(page);
    const { entries, frames } = await recorded(page);

    expect(entries, 'the stage came back at rest').toEqual([{ transform: 'none', opacity: '1' }]);
    expect(frames.length, 'the returning stage was seen').toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.rest, 'the returning pack was not at rest in its first frame').toBe(true);
    }
    expect(errors).toEqual([]);
  });
});

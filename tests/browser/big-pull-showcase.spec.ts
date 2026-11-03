import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * A big pull's showcase (#312): the ribbon sits above the card, never over its art, the halo glows
 * behind it, and the last pack's notices wait until it ends (one comes back once it has). The fixture key's nonce 21 deals no big
 * pull; nonce 22 deals a valuable card last, which Skip stops on.
 *
 * The showcase's 3 s hold (SPECIAL_REVEAL_DURATION_MS) starts at the card's flip and runs on the page's clock. Every
 * case installs that clock before the page loads and freezes it before Skip, so the hold ends only when the test
 * steps the clock past it: a loaded runner can't spend it between the click and the read (#1354, where the click alone
 * took longer than the hold). Mining a pack and the page's own loading stay in real time, before the freeze.
 */
const packShell = (page: Page) => page.getByRole('button', { name: /^Open pack/ });

async function tear(page: Page) {
  await packShell(page).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
}

/** One frame of the page's clock: what the skip's steps and the card's entrance need to move. */
const FRAME_MS = 16;
/** SPECIAL_REVEAL_DURATION_MS: how far the clock steps to end the showcase. */
const HOLD_MS = 3000;

/**
 * Freezes the page's clock, clicks Skip and steps the clock a frame at a time until the big pull's ribbon is up. The
 * skip is a few frames of rAF (PackOpener) and the flip starts the hold, so what the hold has spent by now is a few
 * frames. After this the showcase stays up until the test steps the clock.
 */
async function skipToShowcase(page: Page) {
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 2000));
  await page.getByRole('button', { name: 'Skip opening animation' }).click();
  await expect.poll(async () => {
    if (await page.locator('.pack-top-bar .showcase-ribbon').count()) return true;
    await page.clock.runFor(FRAME_MS);
    return false;
  }, { message: 'the skip never reached the big pull', intervals: [25], timeout: 15000 }).toBe(true);
  // The ribbon and the halo are CSS animations as long as the hold, but on the document's own clock, which the page's
  // doesn't stop: left running, the ribbon fades out 2.6 s of real time in, however long the clock stays frozen.
  // Paused halfway (the ribbon's rest, between 22% and 88%), they wait with the frozen hold. Reduced motion has none.
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (!(animation instanceof CSSAnimation) || !animation.animationName.startsWith('showcase-')) continue;
      animation.pause();
      animation.currentTime = Number(animation.effect?.getComputedTiming().duration) / 2;
    }
  });
}

/**
 * Reads the page until `read` returns something, one frame of the page's clock per look (the card's entrance and the
 * halo's move are rAF, which only the test moves). A look spends 16ms of the hold's 3 s, and a read that settles takes a
 * handful, so the showcase can't end in between.
 */
async function settle<T>(page: Page, read: () => T | null, message: string): Promise<T> {
  let value: T | null = null;
  await expect.poll(async () => {
    value = await page.evaluate(read) as T | null;
    if (value === null) await page.clock.runFor(FRAME_MS);
    return value !== null;
  }, { message, intervals: [25], timeout: 15000 }).toBe(true);
  return value as unknown as T;
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** What was on screen after each change: the ribbon, and the notice text if one was up. */
type Frame = { ribbon: boolean; toast: string | null; at: number };

test('shows a big pull with its ribbon clear of the card, and holds notices until it ends', async ({ page, baseURL, isMobile }) => {
  test.setTimeout(60000);
  const size = isMobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  await page.setViewportSize(size);
  const origin = new URL(baseURL!).origin;
  // Before monitor's own seed, which leaves a seeded player alone.
  await page.addInitScript((origin) => {
    if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 21, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
  }, origin);
  // Records every change to the ribbon and the notice in the page, so the checks below don't race
  // the showcase's timers or the notices'.
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    Object.assign(window, { showcaseFrames: frames });
    new MutationObserver(() => {
      const ribbon = !!document.querySelector('.showcase-ribbon');
      const toast = document.querySelector('.toast')?.textContent ?? null;
      const last = frames.at(-1);
      if (!last || last.ribbon !== ribbon || last.toast !== toast) frames.push({ ribbon, toast, at: performance.now() });
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.clock.install();
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  // The first pack leaves notices behind it (pack kept, level up).
  await tear(page);
  await page.getByRole('button', { name: 'Back to packs', exact: true }).click();
  await expect(page.locator('.toast-region').locator('.toast')).toBeVisible();

  // The next pack's big pull goes on show while one of them is still up. Everything about the
  // showcase is read in one frame in the page, once the ribbon has finished its entrance (full
  // opacity, no scale). The hold is on the frozen page clock, so it can't end between the steps below.
  await tear(page);
  await skipToShowcase(page);
  const shot = await settle(page, () => {
    const rect = (el: Element) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    };
    const hidden = (el: Element | null) => !el || el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden';
    const ribbon = document.querySelector('.pack-top-bar .showcase-ribbon');
    const card = document.querySelector('.reveal-card.is-celebrating');
    const style = ribbon && getComputedStyle(ribbon);
    const resting = style && parseFloat(style.opacity) === 1 && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(style.transform);
    if (!ribbon || !card || !resting) return null;
    return {
      ribbon: rect(ribbon),
      art: rect(card.querySelector('.card-full-image')!),
      card: rect(card),
      role: ribbon.getAttribute('role'),
      text: ribbon.textContent,
      halo: !!card.querySelector('.showcase-halo'),
      statuses: document.querySelectorAll('.card-reveal-area [role="status"]').length,
      fonts: Array.from(ribbon.querySelectorAll('.showcase-ribbon-kicker, .showcase-ribbon-points')).map((el) => parseFloat(getComputedStyle(el).fontSize)),
      toasts: document.querySelectorAll('.toast').length,
      navHidden: hidden(document.querySelector('.app-nav')),
      headerHidden: hidden(document.querySelector('.app-header')),
    };
  }, 'the ribbon never came to rest, or the showcase ended before it did');
  // One announcement, by the ribbon: nothing else in the reveal announces the pull.
  expect(shot.role).toBe('status');
  expect(shot.text).toMatch(/Big pull!\s*[\d,]+ points/);
  expect(shot.statuses).toBe(0);
  expect(shot.halo, 'the halo is missing').toBe(true);
  expect(overlaps(shot.ribbon, shot.art), 'the ribbon covers the card art').toBe(false);
  expect(overlaps(shot.ribbon, shot.card), 'the ribbon covers the card').toBe(false);
  // The whole card and the ribbon are in one screenshot, with no chrome over them.
  for (const [name, { x, y, width, height }] of [['ribbon', shot.ribbon], ['card', shot.card]] as const) {
    expect(x >= 0 && y >= 0 && x + width <= size.width && y + height <= size.height, `the ${name} is cut off`).toBe(true);
  }
  expect(shot.navHidden, 'the nav shows over the showcase').toBe(true);
  if (size.width < 900) expect(shot.headerHidden, 'the header shows over the showcase').toBe(true);
  // Text floor: 12px, for the kicker and the points.
  expect(shot.fonts).toHaveLength(2);
  for (const px of shot.fonts) expect(px, 'ribbon text is under 12px').toBeGreaterThanOrEqual(12);
  expect(shot.toasts, 'a notice showed over the showcase').toBe(0);

  // The hold ends on the clock's step, and the notices that waited are the page's again in real time.
  await page.clock.runFor(HOLD_MS);
  await page.clock.resume();
  // No notice showed at any moment of the showcase.
  await expect(page.locator('.showcase-ribbon')).toHaveCount(0, { timeout: 10000 });
  const frames = () => page.evaluate(() => (window as unknown as { showcaseFrames: Frame[] }).showcaseFrames);
  const recorded = await frames();
  const start = recorded.findIndex((f) => f.ribbon);
  const end = recorded.length - 1 - [...recorded].reverse().findIndex((f) => f.ribbon);
  expect(start, 'the showcase was never recorded').toBeGreaterThan(0);
  expect(recorded.slice(start, end + 1).filter((f) => f.toast), 'a notice showed over the showcase').toEqual([]);
  // A notice was up when the pack took the screen, and one comes back once the showcase ends: the one the pack
  // only held, in full, or (when that one had been seen and was let go) the next in the queue. Which of the
  // two it was depends on how long the runner took to get from the notice to the tear, so only that one
  // does is asserted here; the held notice's identity is the fake-clock integration test's.
  expect(recorded.slice(0, start).some((f) => f.toast), 'no notice was up when the pack took the screen').toBe(true);
  await expect.poll(async () => (await frames()).slice(end + 1).some((f) => f.toast), { message: 'a notice comes back after the showcase', timeout: 5000 }).toBe(true);
  expect(errors).toEqual([]);
});

test('keeps the halo still and the ribbon unscaled when motion is reduced, with the rays inside the stage', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const origin = new URL(baseURL!).origin;
  await page.addInitScript((origin) => {
    if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 22, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
  }, origin);
  await page.clock.install();
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await tear(page);
  await skipToShowcase(page);
  // Read in the page as soon as the showcase is on screen.
  const still = await settle(page, () => {
    const ribbon = document.querySelector('.showcase-ribbon');
    const halo = document.querySelector('.showcase-halo');
    if (!ribbon || !halo) return null;
    return {
      ribbon: getComputedStyle(ribbon).animationName,
      ribbonScale: getComputedStyle(ribbon).transform,
      halo: getComputedStyle(halo).animationName,
      rays: getComputedStyle(halo, '::before').animationName,
    };
  }, 'the ribbon and the halo never showed');
  expect(still).toEqual({ ribbon: 'none', ribbonScale: 'none', halo: 'none', rays: 'none' });
  // The rays' box, centred on the card, against the stage that clips them (#460). Measured once the
  // card has landed: it mounts with the halo at its entry offset (24px low, invisible) and Framer
  // Motion moves it to its place a frame later, so a read on that first frame finds the card 24px off
  // centre. Landed means no translation left and the same box on two frames in a row.
  const { raysBox, stage } = await settle(page, () => {
    const halo = document.querySelector('.showcase-halo');
    const card = halo?.parentElement;
    if (!halo || !card) return null;
    const transform = getComputedStyle(card).transform;
    const { m41, m42 } = transform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
    const box = halo.getBoundingClientRect();
    const seen = window as unknown as { lastHaloBox?: string };
    const key = JSON.stringify(box);
    const settled = m41 === 0 && m42 === 0 && seen.lastHaloBox === key;
    seen.lastHaloBox = key;
    if (!settled) return null;
    const rays = getComputedStyle(halo, '::before');
    const [width, height] = [parseFloat(rays.width), parseFloat(rays.height)];
    const [x, y] = [box.left + box.width / 2 - width / 2, box.top + box.height / 2 - height / 2];
    const stageBox = document.querySelector('.active-card-container')!.getBoundingClientRect();
    return {
      raysBox: { x, y, width, height },
      stage: { x: stageBox.x, y: stageBox.y, width: stageBox.width, height: stageBox.height },
    };
  }, 'the halo never landed');
  // The rays fade out inside their box, so a box inside the stage is never cut off at its edge.
  expect(raysBox.x, 'the rays run past the stage on the left').toBeGreaterThanOrEqual(stage.x - 1);
  expect(raysBox.y, 'the rays run past the top of the stage').toBeGreaterThanOrEqual(stage.y - 1);
  expect(raysBox.x + raysBox.width, 'the rays run past the stage on the right').toBeLessThanOrEqual(stage.x + stage.width + 1);
  expect(raysBox.y + raysBox.height, 'the rays run past the bottom of the stage').toBeLessThanOrEqual(stage.y + stage.height + 1);
  expect(errors).toEqual([]);
});

test('keeps the ribbon a full touch target, and clear of the card, at 200% text (#460)', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  // Still, so the ribbon is measured at its resting size.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const origin = new URL(baseURL!).origin;
  await page.addInitScript((origin) => {
    if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 22, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
  }, origin);
  await page.clock.install();
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await tear(page);
  await skipToShowcase(page);
  const boxes = await settle(page, () => {
    const ribbon = document.querySelector('.pack-top-bar .showcase-ribbon');
    const card = document.querySelector('.reveal-card.is-celebrating');
    if (!ribbon || !card) return null;
    const rect = (el: Element) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    };
    return { ribbon: rect(ribbon), card: rect(card) };
  }, 'the ribbon and the card never showed');
  expect(boxes.ribbon.height, 'the ribbon is shorter than a touch target').toBeGreaterThanOrEqual(44);
  expect(overlaps(boxes.ribbon, boxes.card), 'the ribbon covers the card').toBe(false);
  expect(errors).toEqual([]);
});

import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * A big pull's showcase (#312): the ribbon sits above the card, never over its art, the halo glows
 * behind it, and the last pack's notices wait until it ends. The fixture key's nonce 21 deals no big
 * pull; nonce 22 deals a valuable card last, which Skip stops on.
 */
const packShell = (page: Page) => page.getByRole('button', { name: /^Open a .* pack$/ });

async function tear(page: Page) {
  await packShell(page).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
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
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ musicVolume: 0, effectsVolume: 0 }));
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
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  // The first pack leaves notices behind it (pack kept, level up).
  await tear(page);
  await page.getByRole('button', { name: 'Back to packs', exact: true }).click();
  await expect(page.locator('.toast')).toBeVisible();

  // The next pack's big pull goes on show while one of them is still up. Everything about the
  // showcase is read in one frame in the page, once the ribbon has finished its entrance (full
  // opacity, no scale), so a slow runner can't let it end between measurements.
  await tear(page);
  await page.getByRole('button', { name: 'Skip opening animation' }).click();
  const shot = await page.evaluate(() => new Promise<{
    ribbon: Box; art: Box; card: Box; role: string | null; text: string | null; halo: boolean;
    statuses: number; fonts: number[]; toasts: number; navHidden: boolean; headerHidden: boolean;
  }>((resolve, reject) => {
    const rect = (el: Element | null | undefined) => {
      if (!el) throw new Error('the showcase ended before it settled');
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    };
    const hidden = (el: Element | null) => !el || el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden';
    const started = performance.now();
    let seen = false;
    const look = () => {
      try {
        const ribbon = document.querySelector('.pack-top-bar .showcase-ribbon');
        const card = document.querySelector('.reveal-card.is-celebrating');
        if (seen && (!ribbon || !card)) throw new Error('the showcase ended before it settled');
        if (ribbon) seen = true;
        const style = ribbon && getComputedStyle(ribbon);
        const resting = style && parseFloat(style.opacity) === 1 && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(style.transform);
        if (!ribbon || !card || !resting) {
          if (performance.now() - started > 10000) throw new Error('the ribbon never came to rest');
          requestAnimationFrame(look);
          return;
        }
        resolve({
          ribbon: rect(ribbon),
          art: rect(card.querySelector('.card-full-image')),
          card: rect(card),
          role: ribbon.getAttribute('role'),
          text: ribbon.textContent,
          halo: !!card.querySelector('.showcase-halo'),
          statuses: document.querySelectorAll('.card-reveal-area [role="status"]').length,
          fonts: Array.from(ribbon.querySelectorAll('.showcase-ribbon-kicker, .showcase-ribbon-points')).map((el) => parseFloat(getComputedStyle(el).fontSize)),
          toasts: document.querySelectorAll('.toast').length,
          navHidden: hidden(document.querySelector('.app-nav')),
          headerHidden: hidden(document.querySelector('.app-header')),
        });
      } catch (error) {
        reject(error);
      }
    };
    look();
  }));
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

  // No notice showed at any moment of the showcase, and the one it held comes back first afterwards.
  await expect(page.locator('.showcase-ribbon')).toHaveCount(0, { timeout: 10000 });
  const frames = () => page.evaluate(() => (window as unknown as { showcaseFrames: Frame[] }).showcaseFrames);
  const recorded = await frames();
  const start = recorded.findIndex((f) => f.ribbon);
  const end = recorded.length - 1 - [...recorded].reverse().findIndex((f) => f.ribbon);
  expect(start, 'the showcase was never recorded').toBeGreaterThan(0);
  expect(recorded.slice(start, end + 1).filter((f) => f.toast), 'a notice showed over the showcase').toEqual([]);
  const held = recorded[start - 1];
  expect(held.toast, 'no notice was up when the showcase began').toBeTruthy();
  // A notice still on its own time was held; one already timing out may have left first.
  const stillUp = recorded[start].at - held.at < 2900;
  await expect.poll(async () => (await frames()).slice(end + 1).find((f) => f.toast)?.toast ?? null, { timeout: 5000 })
    .toEqual(stillUp ? held.toast : expect.any(String));
  expect(errors).toEqual([]);
});

test('keeps the halo still and the ribbon unscaled when motion is reduced', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const origin = new URL(baseURL!).origin;
  await page.addInitScript((origin) => {
    if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 22, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ musicVolume: 0, effectsVolume: 0 }));
  }, origin);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await tear(page);
  await page.getByRole('button', { name: 'Skip opening animation' }).click();
  // Read in the page as soon as the showcase is on screen.
  const motion = await (await page.waitForFunction(() => {
    const ribbon = document.querySelector('.showcase-ribbon');
    const halo = document.querySelector('.showcase-halo');
    if (!ribbon || !halo) return null;
    return {
      ribbon: getComputedStyle(ribbon).animationName,
      ribbonScale: getComputedStyle(ribbon).transform,
      halo: getComputedStyle(halo).animationName,
      rays: getComputedStyle(halo, '::before').animationName,
    };
  }, undefined, { timeout: 10000 })).jsonValue();
  expect(motion).toEqual({ ribbon: 'none', ribbonScale: 'none', halo: 'none', rays: 'none' });
  expect(errors).toEqual([]);
});

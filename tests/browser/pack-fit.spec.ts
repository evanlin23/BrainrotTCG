import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded } from './support';

// The whole sealed pack fits the screen, and it falls in without being cut off. The pack used to be
// taller than the stage it sits in, so it needed scrolling to see in full, and the stage's own
// (moving) bottom edge cut it off on the way down. Phone results here are emulation: a Chromium
// window of the phone's size, not a phone.

/** The pack art starts this share of the pack's width below the top of its box (the crimp's margin). */
const ART_TOP = 0.1;

interface Point { x: number; y: number; hit: boolean | null }
interface Frame { stageTop: number; points: Point[] }
interface Drop { frames: Frame[]; done: boolean }

/**
 * Before the page loads, starts a per-frame sampler. Each frame it reads where the stage is and
 * hit-tests seven points on the printed pack (3px in from its edges): a point of the pack that a
 * clipping ancestor (the stage, the shell) cuts off is not hit, wherever the stage is turned or
 * moved to. A point outside the window (or in its outermost pixel) is not tested (`hit: null`): the
 * pack starts a screen above it.
 * It stops once the stage has held still for 20 frames, or after 10 seconds.
 */
async function sampleDropIn(page: Page) {
  await page.addInitScript(() => {
    const drop: Drop = { frames: [], done: false };
    (window as unknown as { __drop: Drop }).__drop = drop;
    const marks = [
      'left:3px;top:calc(10cqw + 3px)',
      'right:3px;top:calc(10cqw + 3px)',
      'left:3px;bottom:3px',
      'right:3px;bottom:3px',
      'left:3px;top:calc(50% + 5cqw)',
      'right:3px;top:calc(50% + 5cqw)',
      'left:calc(50% - 1px);bottom:3px',
    ];
    const started = performance.now();
    let markers: HTMLElement[] = [];
    let held = 0;
    let lastTop = NaN;
    let seenMove = false;
    const tick = () => {
      const shell = document.querySelector<HTMLElement>('.pack-shell');
      const stage = shell?.closest<HTMLElement>('.pack-display');
      if (shell && stage) {
        if (!markers.length || !shell.contains(markers[0])) {
          markers = marks.map((style) => {
            const marker = document.createElement('i');
            marker.setAttribute('style', `position:absolute;width:0;height:0;visibility:hidden;${style}`);
            shell.appendChild(marker);
            return marker;
          });
        }
        const stageTop = stage.getBoundingClientRect().top;
        const points = markers.map((marker) => {
          const box = marker.getBoundingClientRect();
          // A hit test at the last pixel of the window finds nothing at all, so that pixel counts as outside.
          const inside = box.left >= 1 && box.left < innerWidth - 1 && box.top >= 1 && box.top < innerHeight - 1;
          const hit = inside ? document.elementsFromPoint(box.left, box.top).some((element) => shell.contains(element)) : null;
          return { x: Math.round(box.left), y: Math.round(box.top), hit };
        });
        drop.frames.push({ stageTop, points });
        if (!Number.isNaN(lastTop) && Math.abs(stageTop - lastTop) > 20) seenMove = true;
        held = Math.abs(stageTop - lastTop) < 0.01 ? held + 1 : 0;
        lastTop = stageTop;
      }
      if (held >= 20 && seenMove || performance.now() - started > 10000) drop.done = true;
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const PHONES = [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
];
const DESKTOP = { width: 1280, height: 800 };

for (const size of [...PHONES, DESKTOP]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size, reducedMotion: 'no-preference' });

    for (const returning of [false, true]) {
      test(`${returning ? 'a returning' : 'a new'} player's sealed pack fits the screen and falls in uncut`, async ({ page, baseURL }, testInfo) => {
        const project = size === DESKTOP ? 'desktop-chromium' : 'mobile-chromium';
        test.skip(testInfo.project.name !== project, `A ${size.width}px window check; the ${project} project runs it.`);
        const errors = await monitor(page, baseURL!, 0, { returning });
        await sampleDropIn(page);
        await page.goto('./');
        await expect(page.locator('.app-logo')).toBeVisible();
        const packShell = page.locator('.pack-shell');
        await expect(packShell).toBeVisible();
        await expectDecoded(packShell.locator('img'), 2);
        await page.waitForFunction(() => (window as unknown as { __drop: Drop }).__drop.done, null, { timeout: 15000 });

        const { frames } = await page.evaluate(() => (window as unknown as { __drop: Drop }).__drop);
        const rest = frames[frames.length - 1];
        // The pack really was sampled on the way down, not only once it had landed.
        const falling = frames.filter((frame) => Math.abs(frame.stageTop - rest.stageTop) > 24);
        expect(falling.length, 'frames sampled while the pack was falling in').toBeGreaterThanOrEqual(5);
        expect(falling.filter((frame) => frame.points.some((point) => point.hit !== null)).length, 'falling frames with the pack on screen').toBeGreaterThan(0);
        // None of the points that were on screen was cut off by the stage, the shell or anything else.
        const cut = frames.flatMap((frame, index) => frame.points
          .filter((point) => point.hit === false)
          .map((point) => `frame ${index} (stage at ${Math.round(frame.stageTop)}): ${point.x},${point.y}`));
        expect(cut, 'points of the pack that something clipped').toEqual([]);

        // Landed: every point is on screen and was tested, and the pack's box is inside the window.
        expect(rest.points.map((point) => point.hit)).toEqual(rest.points.map(() => true));
        const box = (await packShell.boundingBox())!;
        const art = { top: box.y + box.width * ART_TOP, bottom: box.y + box.height };
        expect(box.x, 'pack left edge').toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, 'pack right edge').toBeLessThanOrEqual(size.width + 0.5);
        expect(art.top, 'printed top of the pack').toBeGreaterThanOrEqual(0);
        expect(art.bottom, 'bottom of the pack').toBeLessThanOrEqual(size.height + 0.5);
        await expect(page.getByRole('button', { name: 'Open pack', exact: true })).toBeInViewport({ ratio: 1 });

        // Nothing to scroll to: no ancestor of the stage, up to the page, has more below than it shows.
        const scrollable = await page.evaluate(() => {
          const out: string[] = [];
          for (let element: Element | null = document.querySelector('.pack-display'); element; element = element.parentElement) {
            if (element.scrollHeight > element.clientHeight + 1) out.push(`${element.tagName}.${element.className}: ${element.scrollHeight} > ${element.clientHeight}`);
          }
          return out;
        });
        expect(scrollable).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  });
}

// A window too short for a whole pack (a phone on its side) keeps the top of the pack, the tear line
// and the button on screen, and a pack wide enough to tear: it never shrinks to nothing.
test.describe('740x360', () => {
  test.use({ viewport: { width: 740, height: 360 }, reducedMotion: 'no-preference' });

  test('a pack in a short landscape window can still be torn and opened', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    const packShell = page.locator('.pack-shell');
    await expectDecoded(packShell.locator('img'), 2);
    await expect.poll(async () => (await packShell.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(160);
    await expect(page.locator('.pack-set-name')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.tear-guide')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Open pack', exact: true })).toBeInViewport({ ratio: 1 });
    expect(errors).toEqual([]);
  });
});

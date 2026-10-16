import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded, expectStill, fingerFor } from './support';

// The sealed pack falls in without being cut off at the top or the sides, at every size from a desktop
// down to a phone on its side. On a phone, and on a window under 900px wide or 600px tall, the whole
// pack fits the stage: it used to be taller than the stage it sits in, so it needed scrolling to see
// in full, and the stage's own (moving) bottom edge cut it off on the way down; on a short landscape
// window a width floor kept it taller than the stage. On a desktop window the pack is big instead, and
// its bottom runs past the stage and fades out: that crop is intended (#536 made it small by fitting
// the whole pack in), but the stage never scrolls and the top, the tear line and the buttons stay on
// screen. Phone and desktop results here are emulation: a Chromium window of that size, not a device.

/** The pack art starts this share of the pack's width below the top of its box (the crimp's margin). */
const ART_TOP = 0.1;
/**
 * The printed pack inside the wrapper art's box, as shares of the box's height (the alpha bounding box
 * of the 768x1376 webp: rows 141 to 1350). On a desktop window the stage cuts the pack off part way down.
 */
const PRINT_TOP = 141 / 1376;
const PRINT_BOTTOM = 1350 / 1376;
/** The widths a desktop window's pack must reach, as shares of the window's width (the nav under a returning player's header takes some of the stage). */
const MIN_WIDTH_SHARE = { new: 0.5, returning: 0.45 };
/** The share of the printed pack that shows at rest on a desktop window: the top half or so, not all of it and not a sliver. */
const VISIBLE_SHARE = { min: 0.45, max: 0.75 };

interface Point { x: number; y: number; hit: boolean | null }
/** `layout` is the pack's box in the stage's own pixels (its turn and drop left out); null if the pack isn't laid out in the stage. */
interface Layout { artTop: number; bottom: number; stageHeight: number }
interface Frame { stageTop: number; layout: Layout | null; points: Point[] }
interface Drop { frames: Frame[]; done: boolean }

/**
 * Before the page loads, starts a per-frame sampler. Each frame it reads where the stage is, where
 * the pack's box sits inside the stage, and hit-tests seven points on the pack (3px in from its
 * edges): a point of the pack that a clipping ancestor (the stage, the shell) cuts off is not hit,
 * wherever the stage is turned or moved to. A point outside the window (or in its outermost pixel) is
 * not tested (`hit: null`): the pack starts a screen above it. When the stage crops the pack's bottom
 * on purpose (`cropped`, a desktop window), the points along the bottom edge are moved up to 45% of
 * the box's height and the middle ones to 30%, all above where the stage ends.
 * The markers are placed in `cqw` and `%` of the shell. `.pack-shell` is itself an inline-size
 * container (Sets.css), so `cqw` on its children is a hundredth of the PACK's width, not the
 * stage's. The art starts a tenth of that width below the top of the box (`artTop`).
 * It stops once the stage has held still for 20 frames, or after 10 seconds.
 */
async function sampleDropIn(page: Page, artTop: number, cropped: boolean) {
  await page.addInitScript(({ artTopShare, crop }) => {
    const drop: Drop = { frames: [], done: false };
    (window as unknown as { __drop: Drop }).__drop = drop;
    const marks = [
      'left:3px;top:calc(10cqw + 3px)',
      'right:3px;top:calc(10cqw + 3px)',
      crop ? 'left:3px;top:calc(45% + 3px)' : 'left:3px;bottom:3px',
      crop ? 'right:3px;top:calc(45% + 3px)' : 'right:3px;bottom:3px',
      crop ? 'left:3px;top:calc(30% + 5cqw)' : 'left:3px;top:calc(50% + 5cqw)',
      crop ? 'right:3px;top:calc(30% + 5cqw)' : 'right:3px;top:calc(50% + 5cqw)',
      crop ? 'left:calc(50% - 1px);top:calc(45% + 3px)' : 'left:calc(50% - 1px);bottom:3px',
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
        // Offsets are layout pixels: the drop's turn and travel don't move them.
        let top = 0;
        let owner: HTMLElement | null = shell;
        for (; owner && owner !== stage; owner = owner.offsetParent as HTMLElement | null) top += owner.offsetTop;
        const layout = owner === stage
          ? { artTop: top + shell.offsetWidth * artTopShare, bottom: top + shell.offsetHeight, stageHeight: stage.clientHeight }
          : null;
        const points = markers.map((marker) => {
          const box = marker.getBoundingClientRect();
          // A hit test at the last pixel of the window finds nothing at all, so that pixel counts as outside.
          const inside = box.left >= 1 && box.left < innerWidth - 1 && box.top >= 1 && box.top < innerHeight - 1;
          const hit = inside ? document.elementsFromPoint(box.left, box.top).some((element) => shell.contains(element)) : null;
          return { x: Math.round(box.left), y: Math.round(box.top), hit };
        });
        drop.frames.push({ stageTop, layout, points });
        if (!Number.isNaN(lastTop) && Math.abs(stageTop - lastTop) > 20) seenMove = true;
        held = Math.abs(stageTop - lastTop) < 0.01 ? held + 1 : 0;
        lastTop = stageTop;
      }
      if (held >= 20 && seenMove || performance.now() - started > 10000) drop.done = true;
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { artTopShare: artTop, crop: cropped });
}

// Phones upright, a phone on its side (740x360, and the shortest, 568x320) and desktop windows.
const SIZES = [
  { width: 360, height: 640, project: 'mobile-chromium' },
  { width: 390, height: 844, project: 'mobile-chromium' },
  { width: 412, height: 915, project: 'mobile-chromium' },
  { width: 740, height: 360, project: 'mobile-chromium' },
  { width: 568, height: 320, project: 'mobile-chromium' },
  { width: 1280, height: 800, project: 'desktop-chromium' },
  { width: 1440, height: 900, project: 'desktop-chromium' },
  { width: 1920, height: 1080, project: 'desktop-chromium' },
];

/** Within a pixel and a half: the sampler rounds the points to whole pixels. */
function expectNear(actual: number, expected: number, what: string) {
  expect(Math.abs(actual - expected), `${what}: ${actual} against ${expected}`).toBeLessThanOrEqual(1.5);
}

/** The swipe hint, if it's showing, ends above the Open pack button (the space .pack-actions keeps for it). */
async function expectHintClearOfButton(page: Page, what: string) {
  const hint = page.locator('.swipe-hint');
  const shown = Number(await hint.evaluate((element) => getComputedStyle(element).opacity)) > 0;
  if (!shown) return;
  const pill = (await hint.boundingBox())!;
  const button = (await page.getByRole('button', { name: 'Open pack', exact: true }).boundingBox())!;
  expect(pill.y + pill.height, `${what}: the bottom of the hint against the top of the button`).toBeLessThanOrEqual(button.y + 1);
}

for (const size of SIZES) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size, reducedMotion: 'no-preference' });
    // The window PackOpener.css gives the big, cropped pack to: not a phone, not a phone on its side.
    const desktop = size.width >= 900 && size.height >= 600;

    for (const returning of [false, true]) {
      const title = desktop
        ? `big sealed pack, its bottom faded out, falls in uncut at the top and sides`
        : `sealed pack fits the screen and falls in uncut`;
      test(`${returning ? 'a returning' : 'a new'} player's ${title}`, async ({ page, baseURL }, testInfo) => {
        test.skip(testInfo.project.name !== size.project, `A ${size.width}px window check; the ${size.project} project runs it.`);
        const errors = await monitor(page, baseURL!, 0, { returning });
        await sampleDropIn(page, ART_TOP, desktop);
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
        // Every frame, from the first drop to the landing: the pack's box is inside the stage, whose
        // clip is what cuts a pack off, top and bottom. On a desktop window only the top has to be: the
        // pack's bottom is meant to run past the stage (the crop; the stage's fade hides it).
        expect(frames.filter((frame) => !frame.layout).length, 'frames where the pack was not laid out in the stage').toBe(0);
        const outside = frames.flatMap((frame, index) => {
          const { artTop, bottom, stageHeight } = frame.layout!;
          const cutOff = desktop ? artTop < -0.5 || bottom <= stageHeight : artTop < -0.5 || bottom > stageHeight + 0.5;
          return cutOff ? [`frame ${index}: art ${artTop.toFixed(1)} to ${bottom.toFixed(1)} in a stage ${stageHeight}px tall`] : [];
        });
        expect(outside, desktop ? 'frames where the pack was cut off at the top, or was not cropped at the bottom' : 'frames where the pack stuck out of the stage').toEqual([]);

        // Landed: every point is on screen and was tested, and the pack's box is inside the stage and the window.
        expect(rest.points.map((point) => point.hit)).toEqual(rest.points.map(() => true));
        const box = (await packShell.boundingBox())!;
        const stage = (await page.locator('.pack-display').boundingBox())!;
        const art = { top: box.y + box.width * ART_TOP, bottom: box.y + box.height };
        expect(box.width, 'pack width').toBeGreaterThan(0);
        expect(box.x, 'pack left edge').toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, 'pack right edge').toBeLessThanOrEqual(size.width + 0.5);
        expect(art.top, 'printed top of the pack').toBeGreaterThanOrEqual(stage.y - 0.5);
        expect(art.top, 'printed top of the pack in the window').toBeGreaterThanOrEqual(0);
        // The markers sit where they were meant to: cqw is the pack's width, so the sampler tests the pack's own corners.
        expectNear(rest.points[0].x, box.x + 3, 'top left marker, x');
        expectNear(rest.points[0].y, art.top + 3, 'top left marker, y');
        if (desktop) {
          // The crop is intended: the box runs on below the stage (and the window), which clips it.
          expect(art.bottom, 'bottom of the pack against the bottom of the stage: the crop').toBeGreaterThan(stage.y + stage.height + 0.5);
          expect(stage.y + stage.height, 'bottom of the stage in the window').toBeLessThanOrEqual(size.height + 0.5);
          expectNear(rest.points[3].x, box.x + box.width - 3, 'right marker, x');
          expectNear(rest.points[3].y, box.y + box.height * 0.45 + 3, 'right marker, y');
          expectNear(rest.points[4].y, box.y + box.height * 0.3 + box.width * 0.05, 'middle left marker, y');
          expect(rest.points[3].y, 'the lowest marker is above the bottom of the stage').toBeLessThan(stage.y + stage.height);

          // Big: a share of the window's width a player can see from across a desk (the whole pack at the stage's height is not).
          const minShare = MIN_WIDTH_SHARE[returning ? 'returning' : 'new'];
          expect(box.width / size.width, `pack width ${Math.round(box.width)}px in a ${size.width}px window`).toBeGreaterThanOrEqual(minShare);
          expect(box.width, 'pack width against the 80vw and 1600px caps').toBeLessThanOrEqual(Math.min(size.width * 0.8, 1600) + 0.5);
          // Cropped, not sliced: the top of the printed pack down to the crop is about half to two thirds of it.
          const printed = { top: box.y + box.height * PRINT_TOP, bottom: box.y + box.height * PRINT_BOTTOM };
          const visible = (Math.min(printed.bottom, stage.y + stage.height) - printed.top) / (printed.bottom - printed.top);
          expect(visible, `share of the printed pack on the stage at rest (${Math.round(visible * 100)}%)`).toBeGreaterThanOrEqual(VISIBLE_SHARE.min);
          expect(visible, `share of the printed pack on the stage at rest (${Math.round(visible * 100)}%)`).toBeLessThanOrEqual(VISIBLE_SHARE.max);
        } else {
          expect(art.bottom, 'bottom of the pack against the bottom of the stage').toBeLessThanOrEqual(stage.y + stage.height + 0.5);
          expect(art.bottom, 'bottom of the pack in the window').toBeLessThanOrEqual(size.height + 0.5);
          expectNear(rest.points[3].x, box.x + box.width - 3, 'bottom right marker, x');
          expectNear(rest.points[3].y, art.bottom - 3, 'bottom right marker, y');
          expectNear(rest.points[4].y, box.y + box.height / 2 + box.width * 0.05, 'middle left marker, y');
        }
        // The tear line and the button are on screen, and the hint doesn't run down onto the button.
        // The set tag stays on its pack: shown, it is inside the pack's box; on a pack too small for
        // 12 px text (under 8rem) it steps aside and is visually hidden, still read aloud.
        const ribbon = await page.locator('.pack-set-ribbon').boundingBox();
        if (box.width >= 128) {
          expect(ribbon && ribbon.width, 'the set tag on a pack 8rem or wider').toBeGreaterThan(8);
          const name = (await page.locator('.pack-set-name').boundingBox())!;
          expect(name.x, 'set name, left edge').toBeGreaterThanOrEqual(box.x - 0.5);
          expect(name.x + name.width, 'set name, right edge').toBeLessThanOrEqual(box.x + box.width + 0.5);
          expect(name.y, 'set name, top edge').toBeGreaterThanOrEqual(stage.y - 0.5);
        } else {
          expect(ribbon && ribbon.width, 'the set tag on a pack under 8rem is visually hidden').toBeLessThanOrEqual(1.5);
        }
        await expect(page.locator('.pack-set-name')).toHaveText(/\S/);
        await expect(page.locator('.tear-guide')).toBeInViewport();
        await expect(page.getByRole('button', { name: 'Open pack', exact: true })).toBeInViewport({ ratio: 1 });
        await expectHintClearOfButton(page, 'at rest');

        if (desktop) {
          // The tear line, the hint and the whole button sit above the fade, so the crop only ever takes
          // pack art: the fade is the lower part of the stage, 22% of it up to 9rem.
          const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
          const fadeFrom = stage.y + stage.height - Math.min(stage.height * 0.22, 9 * rem);
          const tear = (await page.locator('.tear-guide').boundingBox())!;
          const button = (await page.getByRole('button', { name: 'Open pack', exact: true }).boundingBox())!;
          expect(tear.y + tear.height, 'bottom of the tear line against the fade').toBeLessThanOrEqual(fadeFrom);
          expect(button.y + button.height, 'bottom of the Open pack button against the fade').toBeLessThanOrEqual(fadeFrom);
          const hint = page.locator('.swipe-hint');
          if (Number(await hint.evaluate((element) => getComputedStyle(element).opacity)) > 0) {
            const pill = (await hint.boundingBox())!;
            expect(pill.y, 'the hint starts below the tear line').toBeGreaterThanOrEqual(tear.y + tear.height - 0.5);
            expect(pill.y + pill.height, 'bottom of the hint against the fade').toBeLessThanOrEqual(fadeFrom);
          }
          // The stage clips and fades the pack and can't be scrolled to the rest of it.
          const crop = await page.locator('.pack-display').evaluate((element) => {
            const style = getComputedStyle(element);
            const before = element.scrollTop;
            element.scrollTop = 40;
            const moved = element.scrollTop !== before;
            element.scrollTop = before;
            return { overflow: style.overflowY, mask: style.maskImage || style.webkitMaskImage, moved };
          });
          expect(crop.overflow, 'the stage clips the pack').toMatch(/^(clip|hidden)$/);
          expect(crop.mask, 'the stage fades its bottom out').toContain('linear-gradient');
          expect(crop.moved, 'a script can scroll the stage to the rest of the pack').toBe(false);
        }

        // Nothing to scroll to: no ancestor of the stage, up to the page, has more below than it shows.
        // The desktop stage itself holds the rest of the pack past its edge (clipped, and tested above).
        const scrollable = await page.evaluate((skipStage) => {
          const out: string[] = [];
          const stageElement = document.querySelector('.pack-display')!;
          for (let element: Element | null = skipStage ? stageElement.parentElement : stageElement; element; element = element.parentElement) {
            if (element.scrollHeight > element.clientHeight + 1) out.push(`${element.tagName}.${element.className}: ${element.scrollHeight} > ${element.clientHeight}`);
          }
          const root = document.scrollingElement!;
          if (root.scrollHeight > innerHeight + 1 || root.scrollWidth > innerWidth + 1) out.push(`page: ${root.scrollWidth}x${root.scrollHeight} in a ${innerWidth}x${innerHeight} window`);
          return out;
        }, desktop);
        expect(scrollable).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  });
}

// The hint changes its words once a swipe misses the tear line, and on a narrow pack it wraps to two
// lines under the dotted line. Those lines end above the Open pack button, as the plain wording does.
test.describe('360x640', () => {
  test.use({ viewport: { width: 360, height: 640 }, reducedMotion: 'no-preference' });

  test('the hint after a missed swipe still ends above the Open pack button', async ({ page, baseURL, hasTouch }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    const packShell = page.locator('.pack-shell');
    await expectDecoded(packShell.locator('img'), 2);
    await expect(page.getByRole('button', { name: 'Open pack', exact: true })).toBeInViewport({ ratio: 1 });
    // The fall-in has landed: the press below is aimed at where the pack rests.
    await expectStill(packShell, 'the pack to land');
    await expectHintClearOfButton(page, 'before the miss');

    const box = (await packShell.boundingBox())!;
    // Well below the tear line (its widest tolerance is 52px), on the art and left of the Open pack
    // button, which a press never cuts through: a miss, so the pack nudges.
    const x = box.x + box.width * 0.12;
    const y = box.y + box.height * 0.19 + 80;
    const onPack = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('.pack-shell'), [x, y]);
    expect(onPack, 'the press lands on the pack').toBe(true);
    const finger = await fingerFor(page, hasTouch);
    await finger.press(x, y);
    await expect(packShell).toHaveClass(/\bis-nudged\b/);
    await expect(page.locator('.swipe-hint-text')).toContainText('dotted line');
    const pill = (await page.locator('.swipe-hint').boundingBox())!;
    expect(pill.height, 'the nudge wording wraps to two lines at most').toBeLessThanOrEqual(44.5);
    await expectHintClearOfButton(page, 'after the miss');
    await finger.release();
    expect(errors).toEqual([]);
  });
});

import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor, expectDecoded, expectStill, fingerFor } from './support';

// Cut sparks start on the drawn cut at the pointer, in the frame that draws it (#265). Nothing
// draws or sparks until the drag is plainly across rather than down, so the press itself sparks
// nothing (#267).
// sparkField jitters each spark by up to 8px across and 2px down in the pack's own pixels, so the
// checks allow that, times any ancestor scale, plus a pixel for rounding. A rotated ancestor is a
// known limit (packCutCoordinates.ts) and isn't covered. The phone project presses with touch
// events in Pixel 5 emulation, which is not a real phone.

const JITTER_X = 8;
const JITTER_Y = 2;
const TEAR_LINE = 0.19;

/** Opens the app, transforms the pack's ancestor if asked, and returns the pack once it's still. */
async function settledPack(page: Page, ancestorTransform?: string) {
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  // Over the drop-in's inline transform: a stylesheet !important wins over it.
  if (ancestorTransform) await page.addStyleTag({ content: `.pack-display { transform: ${ancestorTransform} !important; }` });
  const packShell = page.locator('.pack-shell');
  await expectDecoded(packShell.locator('img'), 2);
  await packShell.scrollIntoViewIfNeeded();
  await expectStill(packShell, 'the pack stops moving');
  return packShell;
}

interface SparkStart { x: number; y: number; hit: boolean; layerEvents: string }
type SparkWindow = Window & { sparkStarts?: SparkStart[] };

/**
 * Sparks are drawn on one canvas (sparkField.ts), so there is no element to watch. A spark is drawn
 * at full strength only in the frame it is thrown, so each draw onto a spark layer at alpha 1 is one
 * spark's start. Its centre is read back to the screen through the canvas's transform and its
 * on-screen box, where an ancestor's scale shows.
 */
async function recordSparkStarts(page: Page) {
  await page.evaluate(() => {
    const starts: SparkStart[] = [];
    (window as SparkWindow).sparkStarts = starts;
    const draw = CanvasRenderingContext2D.prototype.drawImage as unknown as (...args: unknown[]) => void;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      const canvas = this.canvas;
      if (canvas.classList.contains('spark-layer') && this.globalAlpha === 1) {
        const [, dx, dy, dw, dh] = args as number[];
        const { a, b, c, d, e, f } = this.getTransform();
        const cx = dx + dw / 2;
        const cy = dy + dh / 2;
        const rect = canvas.getBoundingClientRect();
        const x = rect.left + ((a * cx + c * cy + e) / canvas.width) * rect.width;
        const y = rect.top + ((b * cx + d * cy + f) / canvas.height) * rect.height;
        starts.push({
          x,
          y,
          hit: document.elementFromPoint(x, y) === canvas,
          layerEvents: getComputedStyle(canvas).pointerEvents,
        });
      }
      return draw.apply(this, args);
    } as typeof CanvasRenderingContext2D.prototype.drawImage;
  });
}

/**
 * Presses the tear line at 40% across, moves to 50% (past the 10px slop, under the 12% that opens the
 * pack on release, so it stays at rest) once the spark throttle has passed (so the move
 * draws its own burst), then, still pressed, reads where the drawn cut is on screen. A spark lives
 * 620ms, which a slow run can outlast before a read, so each one is recorded as it's drawn: where it starts.
 */
async function cutAndRead(page: Page, packShell: Locator, touch: boolean) {
  const box = (await packShell.boundingBox())!;
  const y = box.y + box.height * TEAR_LINE;
  const from = box.x + box.width * 0.4;
  const to = box.x + box.width * 0.5;
  const onPack = await page.evaluate(([x, py]) => !!document.elementFromPoint(x, py)?.closest('.pack-shell'), [from, y]);
  expect(onPack, 'the press lands on the pack').toBe(true);

  await recordSparkStarts(page);

  const finger = await fingerFor(page, touch);
  await finger.press(from, y);
  await expect(packShell).toHaveClass(/\bis-pressed\b/);
  await finger.move(to, y);
  await expect(packShell).toHaveClass(/\bis-cutting\b/);
  const reading = await page.waitForFunction((burst) => {
    const line = document.querySelector('.pack-shell .cut-line');
    const sparks = (window as SparkWindow).sparkStarts ?? [];
    if (!line || sparks.length < burst) return null;
    const seam = line.getBoundingClientRect();
    return { line: { left: seam.left, right: seam.right, y: seam.top + seam.height / 2 }, sparks };
  }, 3).then((handle) => handle.jsonValue());
  await finger.release();
  // waitForFunction resolves only on a reading, never on null.
  return { from, to, y, ...reading! };
}

/** Checks the drawn cut runs from the press to the pointer and the sparks start on it, at the pointer. */
function expectAligned({ from, to, y, line, sparks }: Awaited<ReturnType<typeof cutAndRead>>, scale: number) {
  expect(Math.abs(line.left - from), 'the cut starts at the press').toBeLessThanOrEqual(1.5);
  expect(Math.abs(line.right - to), 'the cut ends at the pointer').toBeLessThanOrEqual(1.5);
  expect(Math.abs(line.y - y), 'the cut is on the tear line').toBeLessThanOrEqual(1.5);

  const acrossTolerance = JITTER_X * scale + 1;
  const downTolerance = JITTER_Y * scale + 1;
  for (const spark of sparks) {
    expect(Math.abs(spark.y - line.y), `spark ${JSON.stringify(spark)} on the cut, not below it`).toBeLessThanOrEqual(downTolerance);
    expect(Math.abs(spark.x - line.right), `spark ${JSON.stringify(spark)} at the pointer`).toBeLessThanOrEqual(acrossTolerance);
    expect(spark.hit, 'the spark layer is not what a touch lands on').toBe(false);
    expect(spark.layerEvents, 'the spark layer takes no pointer').toBe('none');
  }
}

test('sparks start on the cut line with the pack at rest', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const packShell = await settledPack(page);
  expectAligned(await cutAndRead(page, packShell, hasTouch), 1);
  await expect(packShell).not.toHaveClass(/\bis-cut\b/);
  expect(errors).toEqual([]);
});

test('sparks start on the cut line under a scaled and moved ancestor', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const packShell = await settledPack(page, 'translate(24px, 32px) scale(0.8)');
  const box = (await packShell.boundingBox())!;
  const layoutWidth = await packShell.evaluate((element) => element.clientWidth);
  expect(box.width / layoutWidth, 'the ancestor scale reaches the pack').toBeCloseTo(0.8, 2);
  expectAligned(await cutAndRead(page, packShell, hasTouch), 0.8);
  expect(errors).toEqual([]);
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the cut draws without sparks', async ({ page, baseURL, hasTouch }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    const packShell = await settledPack(page);
    const box = (await packShell.boundingBox())!;
    const y = box.y + box.height * TEAR_LINE;
    await recordSparkStarts(page);
    const finger = await fingerFor(page, hasTouch);
    await finger.press(box.x + box.width * 0.4, y);
    await expect(packShell).toHaveClass(/\bis-pressed\b/);
    await finger.move(box.x + box.width * 0.5, y);
    await expect(packShell.locator('.cut-line')).toHaveCount(1);
    // Let the frames after the cut run: nothing is drawn on the spark layer in any of them.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => (window as SparkWindow).sparkStarts)).toEqual([]);
    // A still seam: no shimmer.
    expect(await packShell.locator('.cut-line').evaluate((line) => getComputedStyle(line).animationName)).toBe('none');
    await finger.release();
    expect(errors).toEqual([]);
  });
});

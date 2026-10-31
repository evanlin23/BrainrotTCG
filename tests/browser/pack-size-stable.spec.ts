import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor, expectDecoded, expectStill, fingerFor, holdTickets, releaseTickets } from './support';

// The pack keeps its size and its place on screen from rest, through the swipe and the tear, until it
// has flown off. Focus mode takes the chrome away as the pack tears (the tabs, the set picker, and the
// header on a phone or a short window), and the stage the pack is fitted to used to grow into the room
// that left, so the torn pack got bigger as it started to open. A pack left while its ticket is on its
// way keeps its size too, unless chrome it didn't have at rest comes back with the player (a new
// player's first pack), and a real resize while the pack is torn still fits it to the new window. The
// sampled frames are checked once each state they cover has been seen, never by how many there are.
// Each size runs with and without reduced motion. Phone and desktop results here are Chromium emulation.

const SIZES = [
  { width: 390, height: 844, project: 'mobile-chromium', turned: { width: 844, height: 390 } },
  { width: 844, height: 390, project: 'mobile-chromium', turned: { width: 390, height: 844 } },
  { width: 1440, height: 900, project: 'desktop-chromium', turned: { width: 1280, height: 800 } },
];

/** Reduced motion has no tween to hide behind, so the pack must hold its size and place there too. */
const MOTIONS = ['no-preference', 'reduce'] as const;

/** One frame of the pack: its box in layout pixels, so the stage's scale-up as it flies off is left out. */
interface Frame { width: number; top: number; left: number; focus: boolean; cut: boolean; leaving: boolean; guide: boolean }
type Box = { x: number; y: number; width: number; height: number };

/** Whether two boxes share more than a hairline (the tab bar's 1px top border lies over the page's last pixel row). */
const overlaps = (a: Box, b: Box) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1.5
  && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1.5;

/** Before the page loads, starts a per-frame sampler of the pack that records once `__packFrames.start()` is called. */
async function sampleFrames(page: Page) {
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    let recording = false;
    Object.defineProperty(window, '__packFrames', { value: { frames, start: () => { recording = true; } } });
    const tick = () => {
      const shell = document.querySelector<HTMLElement>('.pack-shell');
      if (recording && shell) {
        let top = 0;
        let left = 0;
        for (let at: HTMLElement | null = shell; at; at = at.offsetParent as HTMLElement | null) {
          top += at.offsetTop;
          left += at.offsetLeft;
        }
        frames.push({
          width: shell.offsetWidth, top, left,
          focus: !!document.querySelector('.app.is-focus'),
          cut: shell.classList.contains('is-cut'),
          // The pack drops its controls (inert) the moment it starts flying off.
          leaving: !!shell.closest('[inert]'),
          guide: !!document.querySelector('.card-guide-entry'),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const startFrames = (page: Page) => page.evaluate(() => (window as unknown as { __packFrames: { start: () => void } }).__packFrames.start());
const packFrames = (page: Page) => page.evaluate(() => (window as unknown as { __packFrames: { frames: Frame[] } }).__packFrames.frames);

/** Waits until the sampler has recorded a frame in the state `seen` looks for: the latest one only, when `latest`. */
async function sampledFrame(page: Page, seen: (frame: Frame) => boolean, what: string, latest = false) {
  await expect.poll(async () => {
    const frames = await packFrames(page);
    return latest ? frames.length > 0 && seen(frames[frames.length - 1]) : frames.some(seen);
  }, { message: `a frame sampled ${what}` }).toBe(true);
}

/** Every sampled frame where the pack's size or place differs from the first one's. */
function changedFrames(frames: Frame[]) {
  const [first] = frames;
  return frames.flatMap((frame, index) => (['width', 'top', 'left'] as const)
    .filter((key) => Math.abs(frame[key] - first[key]) > 1)
    .map((key) => `frame ${index}${frame.leaving ? ' (flying off)' : frame.focus ? ' (focus mode)' : ''}: ${key} ${first[key]} -> ${frame[key]}`));
}

/** The sealed pack once it has landed, with its art loaded. */
async function landedPack(page: Page) {
  const packShell = page.locator('.pack-shell');
  await expectDecoded(packShell.locator('img'), 2);
  await expectStill(packShell, 'the pack landed');
  return packShell;
}

async function expectSameBox(packShell: Locator, rest: Box, when: string) {
  const box = (await packShell.boundingBox())!;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(box[key] - rest[key]), `the pack's ${key} ${when}: ${box[key]}, at rest ${rest[key]}`).toBeLessThanOrEqual(1);
  }
}

for (const [size, motion] of SIZES.flatMap((one) => MOTIONS.map((mode) => [one, mode] as const))) {
  test.describe(`${size.width}x${size.height}${motion === 'reduce' ? ' with reduced motion' : ''}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, reducedMotion: motion });

    test('the pack keeps its size and place from rest until it has flown off, and the next one rests the same', async ({ page, baseURL, hasTouch }, testInfo) => {
      test.skip(testInfo.project.name !== size.project, `A ${size.width}px window check; the ${size.project} project runs it.`);
      test.setTimeout(60000);
      const errors = await monitor(page, baseURL!, 0, { returning: true });
      await holdTickets(page);
      await sampleFrames(page);
      await page.goto('./');
      await expect(page.locator('.app-logo')).toBeVisible();
      const packShell = await landedPack(page);
      const rest = (await packShell.boundingBox())!;
      await startFrames(page);

      // A swipe along the tear line: still cutting a fifth of the way across, torn by the end of it.
      const finger = await fingerFor(page, hasTouch);
      const y = rest.y + rest.height * 0.19;
      const across = (share: number) => finger.move(rest.x + rest.width * share, y);
      await finger.press(rest.x + rest.width * 0.15, y);
      for (let step = 1; step <= 4; step++) await across(0.15 + (0.2 * step) / 4);
      await expect(packShell).toHaveClass(/\bis-cutting\b/);
      await expectSameBox(packShell, rest, 'mid-swipe');
      for (let step = 1; step <= 6; step++) await across(0.35 + (0.5 * step) / 6);
      await finger.release();
      await expect(packShell).toHaveClass(/\bis-cut\b/);
      await expect(page.locator('.app')).toHaveClass(/\bis-focus\b/);
      await expectSameBox(packShell, rest, 'torn, with the chrome gone');
      await expect(page.locator('.pack-hint.is-waiting')).toBeVisible({ timeout: 15000 });
      await expectSameBox(packShell, rest, 'torn, waiting on its ticket');
      // The ticket is held, so the torn pack stays in focus mode until the sampler has seen it there.
      await sampledFrame(page, (frame) => frame.cut && frame.focus, 'torn, in focus mode');

      // Every frame up to the one the pack is gone in: the reveal, and its flight off if a frame caught it.
      await releaseTickets(page);
      await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 20000 });
      await expect(packShell).toHaveCount(0);
      expect(changedFrames(await packFrames(page)), 'frames where the pack\'s size or place changed').toEqual([]);

      // The next sealed pack rests at the same size, with the chrome back.
      await page.getByRole('button', { name: 'Skip opening animation' }).click();
      await page.getByRole('button', { name: /^Open .+ again$/ }).click();
      await expect(page.locator('.app')).not.toHaveClass(/\bis-focus\b/);
      await expectSameBox(await landedPack(page), rest, 'for the next pack');
      expect(errors).toEqual([]);
    });

    test('a torn pack left while its ticket is on its way keeps its size, sealed again, until the ticket lands', async ({ page, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== size.project, `A ${size.width}px window check; the ${size.project} project runs it.`);
      test.setTimeout(60000);
      const errors = await monitor(page, baseURL!, 0, { returning: true });
      await holdTickets(page);
      await sampleFrames(page);
      await page.goto('./');
      await expect(page.locator('.app-logo')).toBeVisible();
      const packShell = await landedPack(page);
      const rest = (await packShell.boundingBox())!;
      await startFrames(page);
      await page.getByRole('button', { name: /^Open pack/ }).focus();
      await page.keyboard.press('Space');
      await expect(page.locator('.pack-hint.is-waiting')).toBeVisible({ timeout: 15000 });
      await sampledFrame(page, (frame) => frame.cut && frame.focus, 'torn, in focus mode');

      // The chrome comes back as the player leaves; the card guide waits for the pack to be recorded.
      await page.getByRole('button', { name: 'Back to packs', exact: true }).click();
      await expect(page.locator('.app')).not.toHaveClass(/\bis-focus\b/);
      await expect(page.locator('.card-guide-entry')).toHaveCount(0);
      await expectSameBox(packShell, rest, 'left, its ticket on its way');
      await sampledFrame(page, (frame) => !frame.focus, 'left, its ticket on its way', true);
      await releaseTickets(page);
      await expect(page.locator('.card-guide-entry')).toBeVisible({ timeout: 20000 });
      await expectSameBox(packShell, rest, 'once its ticket landed');
      await sampledFrame(page, (frame) => frame.guide, 'once its ticket landed', true);

      expect(changedFrames(await packFrames(page)), 'frames where the pack\'s size or place changed').toEqual([]);
      expect(errors).toEqual([]);
    });

    test('a new player\'s torn pack, left while its ticket is on its way, fits the room under the chrome that comes back', async ({ page, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== size.project, `A ${size.width}px window check; the ${size.project} project runs it.`);
      test.setTimeout(60000);
      // No packs yet: no set picker or tabs at rest. They come back as the player leaves the torn pack.
      const errors = await monitor(page, baseURL!, 0);
      await holdTickets(page);
      await page.goto('./');
      await expect(page.locator('.app-logo')).toBeVisible();
      const packShell = await landedPack(page);
      const rest = (await packShell.boundingBox())!;
      await expect(page.locator('.set-picker')).toHaveCount(0);
      await page.getByRole('button', { name: /^Open pack/ }).focus();
      await page.keyboard.press('Space');
      await expect(page.locator('.pack-hint.is-waiting')).toBeVisible({ timeout: 15000 });
      await expectSameBox(packShell, rest, 'torn, waiting on its ticket');

      await page.getByRole('button', { name: 'Back to packs', exact: true }).click();
      await expect(page.locator('.set-picker')).toBeVisible();
      const stage = page.locator('.pack-display');
      await expect.poll(async () => {
        const [box, room] = [(await stage.boundingBox())!, (await page.locator('.pack-opener-container').boundingBox())!];
        return Math.abs(box.y - room.y) <= 1 && Math.abs(box.y + box.height - (room.y + room.height)) <= 1;
      }, { message: 'the stage fills the room the chrome leaves it' }).toBe(true);
      await expectStill(packShell, 'the pack settled under the chrome');
      // Nothing of the stage, which clips the pack, runs under the set picker or the tabs.
      const box = (await stage.boundingBox())!;
      expect(overlaps(box, (await page.locator('.set-picker').boundingBox())!), 'the stage overlaps the set picker').toBe(false);
      const nav = await page.locator('.app-nav').boundingBox();
      if (nav) expect(overlaps(box, nav), 'the stage overlaps the tabs').toBe(false);
      // The pack art shows: what's under its top and upper middle is the pack, not the picker or the tabs.
      expect(await packShell.evaluate((shell) => {
        const { x, y, width, height } = shell.getBoundingClientRect();
        return [0.12, 0.3].map((share) => !!document.elementFromPoint(x + width / 2, y + height * share)?.closest('.pack-shell'));
      }), 'the pack art is uncovered at its top and upper middle').toEqual([true, true]);

      await releaseTickets(page);
      await expect(page.locator('.card-guide-entry')).toBeVisible({ timeout: 20000 });
      expect(errors).toEqual([]);
    });

    test(`a resize to ${size.turned.width}x${size.turned.height} while the torn pack waits fits it to the new window`, async ({ page, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== size.project, `A ${size.width}px window check; the ${size.project} project runs it.`);
      test.setTimeout(60000);
      const errors = await monitor(page, baseURL!, 0, { returning: true });
      await holdTickets(page);
      await page.goto('./');
      await expect(page.locator('.app-logo')).toBeVisible();
      const packShell = await landedPack(page);
      await page.getByRole('button', { name: /^Open pack/ }).focus();
      await page.keyboard.press('Space');
      await expect(page.locator('.pack-hint.is-waiting')).toBeVisible({ timeout: 15000 });

      await page.setViewportSize(size.turned);
      // The stage fills the room focus mode leaves it at the new size, and the pack is fitted to that stage.
      const stage = page.locator('.pack-display');
      await expect.poll(async () => {
        const [box, room] = [(await stage.boundingBox())!, (await page.locator('.pack-opener-container').boundingBox())!];
        return Math.abs(box.y - room.y) <= 1 && Math.abs(box.y + box.height - (room.y + room.height)) <= 1;
      }, { message: 'the stage fills its room at the new size' }).toBe(true);
      await expectStill(packShell, 'the pack settled at the new size');
      const [box, room] = [(await packShell.boundingBox())!, (await stage.boundingBox())!];
      expect(box.x, 'pack left edge').toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, 'pack right edge').toBeLessThanOrEqual(size.turned.width + 0.5);
      // On a phone the whole pack fits its stage (pack-fit.spec.ts); a desktop window's big pack runs past it.
      if (size.project === 'mobile-chromium') expect(box.y + box.height, 'pack bottom edge').toBeLessThanOrEqual(room.y + room.height + 0.5);

      await releaseTickets(page);
      await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 20000 });
      expect(errors).toEqual([]);
    });
  });
}

import { test, expect, type Locator, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { monitor } from './support';

/**
 * Download in the kept-aside controls says it started (#994): the file arrives as a browser download with
 * no other sign on the page, in both places the control lives (the save warning banner and Settings > Save
 * & backup). The note is in a polite status region, a repeat Download is announced again, and at 320 px wide
 * and 200% text it is whole and inside the screen. Only a disposable archive seeded into this test's own
 * storage is ever downloaded; nothing is discarded.
 */

const ARCHIVE = JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null });
const NOTE = 'Download started — keep the recovery file safe.';
const FILE_NAME = /^brainrot-collection-recovery-\d{4}-\d{2}-\d{2}\.json$/;

const VARIANTS = [
  { name: 'banner', path: './', region: '.save-warning', container: '.save-warning' },
  { name: 'settings', path: './#/settings', region: '.settings-actions', container: '.settings-panel' },
] as const;

async function open(page: Page, baseURL: string, variant: (typeof VARIANTS)[number], rootPercent: number) {
  const errors = await monitor(page, baseURL, 1, { returning: true });
  const origin = new URL(baseURL).origin;
  await page.addInitScript(({ key, archive, origin }) => {
    if (window.location.origin !== origin) return;
    try { if (!localStorage.getItem(key)) localStorage.setItem(key, archive); } catch { /* storage blocked */ }
  }, { key: STORAGE_KEYS.COLLECTION_RECOVERY, archive: ARCHIVE, origin });
  await page.goto(variant.path);
  if (rootPercent !== 100) await page.addStyleTag({ content: `html { font-size: ${rootPercent}% !important; }` });
  await page.evaluate(() => document.fonts.ready);
  const area = page.locator(variant.region).filter({ has: page.getByRole('button', { name: 'Download', exact: true }) });
  const status = area.getByRole('status');
  return { errors, status, download: area.getByRole('button', { name: 'Download', exact: true }) };
}

/** The note's lines and the buttons, in viewport pixels, read without scrolling anything. */
function fit(status: Locator, container: string) {
  return status.evaluate((el, selector) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const holder = el.closest(selector)!;
    const box = holder.getBoundingClientRect();
    const buttons = Array.from(holder.querySelectorAll('button')).map((b) => b.getBoundingClientRect());
    return {
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      clipped: el.scrollWidth > el.clientWidth + 1,
      container: { left: box.left, right: box.right },
      lines: lines.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
      buttons: buttons.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
    };
  }, container);
}

for (const variant of VARIANTS) {
  test(`the ${variant.name} Download says it started, and a repeat is announced again (#994)`, async ({ page, baseURL }) => {
    const { errors, status, download } = await open(page, baseURL!, variant, 100);
    // The region is already there, empty, when Download is pressed: that is what makes a screen reader announce the text.
    await expect(status).toHaveCount(1);
    await expect(status).toBeEmpty();

    const first = page.waitForEvent('download');
    await download.click();
    expect((await first).suggestedFilename()).toMatch(FILE_NAME);
    await expect(status).toHaveText(NOTE);
    // Settings has nothing assertive around the note. In the banner it sits inside the warning's own alert,
    // which is assertive and atomic: a screen reader may read the warning again with it.
    expect(await status.evaluate((el) => el.closest('[aria-live="assertive"], [role="alert"]')?.getAttribute('role') ?? null)).toBe(variant.name === 'banner' ? 'alert' : null);
    await expect(status.locator('span')).toHaveCount(1);
    // Mark the note's element: a repeat Download must replace it, not just rewrite the same text.
    await status.locator('span').evaluate((el) => el.setAttribute('data-first', ''));

    const second = page.waitForEvent('download');
    await download.click();
    expect((await second).suggestedFilename()).toMatch(FILE_NAME);
    await expect(status.locator('span')).toHaveCount(1);
    await expect(status.locator('span[data-first]')).toHaveCount(0);
    await expect(status).toHaveText(NOTE);
    // Nothing was discarded.
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(ARCHIVE);
    expect(errors).toEqual([]);
  });

  for (const zoom of [{ name: 'default text', percent: 100 }, { name: '200% text', percent: 200 }]) {
    test(`the ${variant.name} note fits 320 px wide at ${zoom.name} (#994)`, async ({ page, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
      await page.setViewportSize({ width: 320, height: 568 });
      const { errors, status, download } = await open(page, baseURL!, variant, zoom.percent);
      const started = page.waitForEvent('download');
      await download.click();
      await started;
      await expect(status).toHaveText(NOTE);

      const l = await fit(status, variant.container);
      expect(l.pageWidth, 'the page does not scroll sideways').toBeLessThanOrEqual(l.viewport);
      expect(l.clipped, 'the note is not cut off').toBe(false);
      expect(l.lines.length, 'the note has text').toBeGreaterThan(0);
      for (const line of l.lines) {
        expect(line.left, 'the note starts inside the screen').toBeGreaterThanOrEqual(l.container.left - 0.5);
        expect(line.right, 'the note ends inside the screen').toBeLessThanOrEqual(Math.min(l.container.right, l.viewport) + 0.5);
      }
      if (variant.name === 'settings') {
        // The note has its own line above the buttons, which stay whole inside the panel.
        for (const b of l.buttons) {
          expect(b.top, 'the buttons are below the note').toBeGreaterThanOrEqual(Math.max(...l.lines.map((r) => r.bottom)) - 0.5);
          expect(b.left).toBeGreaterThanOrEqual(l.container.left - 0.5);
          expect(b.right).toBeLessThanOrEqual(l.container.right + 0.5);
        }
      }
      expect(errors).toEqual([]);
    });
  }
}

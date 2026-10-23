import { test, expect, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { monitor } from './support';

/**
 * The Discard question in Settings > Save & backup stays readable on phones (#641): at 320x568 and
 * 390x844, with the root text at 16 px and at 32 px (200%), the warning has a full-width line above
 * the answers, "Keep it" is first, focused and the filled button, "Discard for good" is an outlined
 * danger button, and nothing scrolls sideways. Only a disposable archive seeded into this test's own
 * storage is ever asked about; nothing is discarded.
 */

const ARCHIVE = JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null });
const PHONES = [
  { name: '320x568', width: 320, height: 568 },
  { name: '390x844', width: 390, height: 844 },
];
const ZOOMS = [
  { name: 'default text', percent: 100 },
  { name: '200% text', percent: 200 },
];

async function openQuestion(page: Page, baseURL: string, zoomPercent: number) {
  const errors = await monitor(page, baseURL);
  const origin = new URL(baseURL).origin;
  await page.addInitScript(({ key, archive, origin }) => {
    if (window.location.origin !== origin) return;
    try { if (!localStorage.getItem(key)) localStorage.setItem(key, archive); } catch { /* storage blocked */ }
  }, { key: STORAGE_KEYS.COLLECTION_RECOVERY, archive: ARCHIVE, origin });
  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  if (zoomPercent !== 100) await page.addStyleTag({ content: `html { font-size: ${zoomPercent}% !important; }` });
  await main.getByRole('button', { name: 'Discard', exact: true }).click();
  const keep = main.getByRole('button', { name: 'Keep it', exact: true });
  await expect(keep).toBeFocused();
  return { errors, main, keep };
}

for (const phone of PHONES) {
  for (const zoom of ZOOMS) {
    test(`the Discard question fits ${phone.name} at ${zoom.name}, safe answer first (#641)`, async ({ page, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
      await page.setViewportSize({ width: phone.width, height: phone.height });
      const { errors, main, keep } = await openQuestion(page, baseURL!, zoom.percent);
      const discard = main.getByRole('button', { name: 'Discard for good', exact: true });
      const warning = main.getByText('Discard it for good? Only a downloaded copy keeps it.', { exact: true });
      await expect(discard).toBeVisible();
      await expect(warning).toBeVisible();

      // Hover tints the outlined button, so park the pointer away from both answers before reading their fills.
      await page.mouse.move(0, 0);
      const l = await page.evaluate(() => {
        const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const buttons = Array.from(document.querySelectorAll<HTMLElement>('.settings-actions--ask button'));
        const note = document.querySelector('.settings-actions--ask .settings-desc')!;
        const panel = document.querySelector('.settings-actions--ask')!.closest('.settings-panel')!;
        const row = getComputedStyle(document.querySelector('.settings-actions--ask')!.closest('.settings-row')!);
        return {
          viewport: innerWidth,
          pageWidth: document.documentElement.scrollWidth,
          panel: box(panel),
          rowInner: parseFloat(row.width) - parseFloat(row.paddingLeft) - parseFloat(row.paddingRight),
          note: box(note),
          noteClipped: note.scrollWidth > note.clientWidth,
          names: buttons.map((b) => b.textContent),
          boxes: buttons.map(box),
          fills: buttons.map((b) => getComputedStyle(b).backgroundColor),
        };
      });
      expect(l.names).toEqual(['Keep it', 'Discard for good']);
      expect(l.pageWidth, 'the page does not scroll sideways').toBeLessThanOrEqual(l.viewport);
      // The warning has the row's whole width to itself and sits above both answers.
      expect(l.note.right - l.note.left, 'the warning has the full row width').toBeGreaterThanOrEqual(l.rowInner - 0.5);
      expect(l.noteClipped, 'the warning is not cut off').toBe(false);
      for (const b of l.boxes) {
        expect(b.top, 'the answers are below the warning').toBeGreaterThanOrEqual(l.note.bottom - 0.5);
        expect(b.left).toBeGreaterThanOrEqual(l.panel.left - 0.5);
        expect(b.right).toBeLessThanOrEqual(l.panel.right + 0.5);
      }
      // Keep it comes first and is the filled button; Discard for good is outlined, with no fill.
      expect(l.boxes[0].top < l.boxes[1].top || l.boxes[0].left < l.boxes[1].left, 'Keep it comes first').toBe(true);
      expect(l.fills[0]).not.toBe('rgba(0, 0, 0, 0)');
      expect(l.fills[1]).toBe('rgba(0, 0, 0, 0)');
      await expect(discard).toHaveClass(/btn--danger/);

      // Cancelling puts focus back on Discard, and the data is untouched.
      await keep.click();
      await expect(main.getByRole('button', { name: 'Discard', exact: true })).toBeFocused();
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(ARCHIVE);
      expect(errors).toEqual([]);
    });
  }
}

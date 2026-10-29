import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * The Settings Back up and Restore rows stay readable at enlarged text (#691): at 320x640, 360x740 and
 * 390x844 with the root text at 32 px (200%), the privacy warning, Restore's instructions, a rejected
 * file's note, the "Backup downloaded" note after Export, the Replace / Keep mine question and the no-room question (with its long "Replace without
 * a copy") each sit beside or above their buttons without a line of text under one, the buttons stay
 * inside the panel whole and keep 44 px targets. Controls: the same phones at normal text, where the
 * idle rows keep their button beside the text as before, and a desktop window at normal and 200% text. Sizes are emulated viewports; 200%
 * text doubles the root font size the rem tokens use. Geometry is read from the layout before
 * anything is clicked, because the automatic scroll before a click would not reveal a control that is
 * clipped sideways.
 */

const VIEWPORTS = [
  { name: '320x640', width: 320, height: 640, tag: '@mobile-only' },
  { name: '360x740', width: 360, height: 740, tag: '@mobile-only' },
  { name: '390x844', width: 390, height: 844, tag: '@mobile-only' },
  { name: '1280x800', width: 1280, height: 800, tag: '@desktop-only' },
];
const ZOOMS = [
  { name: 'default text', rootPx: 16 },
  { name: '200% text', rootPx: 32 },
];

const player = (hex: string) => JSON.stringify({ secretKey: hex.repeat(32), name: 'Another player', nextNonce: 3, createdAt: 1 });
const OTHER_SAVE = JSON.stringify({ version: 2, exportedAt: '2026-01-01T00:00:00.000Z', player: player('bb'), stats: JSON.stringify({ packsOpened: 5 }) });

async function openSettings(page: Page, baseURL: string, viewport: (typeof VIEWPORTS)[number], zoom: (typeof ZOOMS)[number]) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  const errors = await monitor(page, baseURL, 1, { returning: true });
  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main).toBeVisible();
  if (zoom.rootPx !== 16) await page.addStyleTag({ content: `html { font-size: ${(zoom.rootPx / 16) * 100}% !important; }` });
  await page.evaluate(() => document.fonts.ready);
  const rowOf = (label: string) => main.locator('.settings-row').filter({ has: page.locator('.settings-label', { hasText: new RegExp(`^${label}$`) }) });
  return { errors, main, backUp: rowOf('Back up'), restore: rowOf('Restore') };
}

interface Box { left: number; right: number; top: number; bottom: number }

/** Where a row's text lines and buttons sit right now, in viewport pixels, without scrolling anything. */
function layoutOf(row: Locator) {
  return row.evaluate((el) => {
    const box = (r: DOMRect): Box => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    // The rectangle of each line of a text element, which is what can end up under a button.
    const lines = (target: Element) => {
      const range = document.createRange();
      range.selectNodeContents(target);
      return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0).map(box);
    };
    return {
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
      panel: box(el.closest('.settings-panel')!.getBoundingClientRect()),
      column: box(el.querySelector('.settings-text')!.getBoundingClientRect()),
      text: Array.from(el.querySelectorAll('.settings-label, .settings-desc')).flatMap(lines),
      note: el.querySelector('.settings-desc')!.textContent,
      buttons: Array.from(el.querySelectorAll('button')).map((b) => ({
        name: b.textContent!.trim(),
        // A label wider than its button, cut off by the button's own box or the panel's edge.
        clipped: b.scrollWidth > b.clientWidth + 1,
        ...box(b.getBoundingClientRect()),
      })),
    };
  });
}

const overlaps = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** The row's words are whole and readable: clear of its buttons, which are whole, inside the panel and big enough to press. */
async function expectReadable(row: Locator, label: string, expectedButtons: string[]) {
  const l = await layoutOf(row);
  expect(l.buttons.map((b) => b.name), `${label}: the row's buttons`).toEqual(expectedButtons);
  expect(l.pageWidth, `${label}: the page does not scroll sideways`).toBeLessThanOrEqual(l.viewport);
  expect(l.text.length, `${label}: the row has text`).toBeGreaterThan(0);
  for (const line of l.text) {
    expect(line.left, `${label}: text starts inside the panel`).toBeGreaterThanOrEqual(l.panel.left - 0.5);
    expect(line.right, `${label}: text ends inside the panel`).toBeLessThanOrEqual(l.panel.right + 0.5);
    for (const button of l.buttons) expect(overlaps(line, button), `${label}: text clears ${button.name}`).toBe(false);
  }
  for (const button of l.buttons) {
    expect(button.left, `${label}: ${button.name} starts inside the panel`).toBeGreaterThanOrEqual(l.panel.left - 0.5);
    expect(button.right, `${label}: ${button.name} ends inside the panel`).toBeLessThanOrEqual(l.panel.right + 0.5);
    expect(button.right, `${label}: ${button.name} stays on screen`).toBeLessThanOrEqual(l.viewport);
    expect(button.clipped, `${label}: ${button.name} shows its whole label`).toBe(false);
    expect(button.bottom - button.top, `${label}: ${button.name} is a 44px target`).toBeGreaterThanOrEqual(43.5);
  }
  for (let i = 0; i < l.buttons.length; i++) {
    for (let j = i + 1; j < l.buttons.length; j++) expect(overlaps(l.buttons[i], l.buttons[j]), `${label}: the buttons clear each other`).toBe(false);
  }
  // A column of words, not a sliver one letter wide.
  expect(l.column.right - l.column.left, `${label}: the text column has room`).toBeGreaterThan(l.rootPx * 5);
  return l;
}

/** The button sits on the right, level with the text, not on a line of its own below it. */
function expectBeside(l: Awaited<ReturnType<typeof layoutOf>>, label: string) {
  const lowestText = Math.max(...l.text.map((t) => t.bottom));
  expect(l.buttons[0].top, `${label}: the button is on the text's line`).toBeLessThan(lowestText);
  expect(l.buttons[0].left, `${label}: the button is on the right`).toBeGreaterThan(l.panel.left + (l.panel.right - l.panel.left) / 2);
}

for (const viewport of VIEWPORTS) {
  for (const zoom of ZOOMS) {
    test(`Back up and Restore stay readable at ${viewport.name}, ${zoom.name} (#691)`, { tag: viewport.tag }, async ({ page, baseURL }) => {
      const { errors, main, backUp, restore } = await openSettings(page, baseURL!, viewport, zoom);
      const where = `${viewport.name}, ${zoom.name}`;

      // Read before touching anything: a click would scroll the row into view and could hide a clip.
      const first = await expectReadable(backUp, `${where}, back up`, ['Export']);
      // 200% is the browser's 16px doubled; at normal text the app's own root size (16px on a phone, a little more on desktop) applies.
      if (zoom.rootPx === 32) expect(first.rootPx, `${where}: the root text size`).toBe(32);
      else expect(first.rootPx, `${where}: the root text size`).toBeLessThanOrEqual(18);
      expect(first.note).toBe('Includes your secret player key. Keep the file private.');
      const idleRestore = await expectReadable(restore, `${where}, restore`, ['Import']);
      // At normal text the idle rows keep their button beside the text, as they did before the rows could wrap.
      if (zoom.rootPx !== 32) {
        expectBeside(first, `${where}, back up`);
        expectBeside(idleRestore, `${where}, restore`);
      }

      // A file that is not a save: the rejection is as readable as the instructions.
      const file = main.locator('input[type="file"]');
      await file.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('not a save') });
      const rejected = restore.locator('.settings-desc');
      await expect(rejected).toHaveText("Couldn't read that file. Is it a save exported from Save & backup?");
      await expectReadable(restore, `${where}, rejected file`, ['Import']);

      // A different save with real progress here: the question and both answers fit.
      await file.setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(OTHER_SAVE) });
      await expect(restore.getByRole('button', { name: 'Replace', exact: true })).toBeVisible();
      await expectReadable(restore, `${where}, replace question`, ['Keep mine', 'Replace']);

      // Keep mine answers it, and the row is back to a single Import.
      await restore.getByRole('button', { name: 'Keep mine', exact: true }).click();
      await expect(rejected).toHaveText('Kept your save.');
      await expectReadable(restore, `${where}, kept`, ['Import']);

      // Export says the backup was downloaded (#805); that note is the longest in the row, so it fits too.
      const download = page.waitForEvent('download');
      await backUp.getByRole('button', { name: 'Export', exact: true }).click();
      await download;
      await expect(backUp.locator('.settings-desc')).toHaveText('Backup downloaded — keep it private. It includes your secret player key.');
      await expect(backUp.locator('.settings-desc')).toBeVisible();
      await expectReadable(backUp, `${where}, exported`, ['Export']);
      expect(errors).toEqual([]);
    });
  }
}

// The copy of the current save is the write the browser refuses: "Replace without a copy" is the longest label in these rows.
for (const viewport of VIEWPORTS) {
  for (const zoom of ZOOMS) {
    test(`the no-room question stays readable at ${viewport.name}, ${zoom.name} (#691)`, { tag: viewport.tag }, async ({ page, baseURL }) => {
      const { errors, main, restore } = await openSettings(page, baseURL!, viewport, zoom);
      const where = `${viewport.name}, ${zoom.name}`;
      await page.evaluate(() => {
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === 'brainrot-before-import-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
          write.call(this, key, value);
        };
      });
      await main.locator('input[type="file"]').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(OTHER_SAVE) });
      await restore.getByRole('button', { name: 'Replace', exact: true }).click();
      await expect(restore.locator('.settings-desc')).toContainText("There's no room in this browser's storage for this file and a copy of your current save.");
      await expect(restore.getByRole('button', { name: 'Replace without a copy', exact: true })).toBeVisible();
      await expectReadable(restore, `${where}, no room`, ['Keep mine', 'Replace without a copy']);
      expect(errors).toEqual([]);
    });
  }
}

test('a wide window keeps Back up and Restore on one line each (#691)', { tag: '@desktop-only' }, async ({ page, baseURL }) => {
  const { errors, backUp, restore } = await openSettings(page, baseURL!, VIEWPORTS[3], ZOOMS[0]);
  for (const [name, row] of [['back up', backUp], ['restore', restore]] as const) {
    expectBeside(await expectReadable(row, `desktop, ${name}`, [name === 'back up' ? 'Export' : 'Import']), `desktop ${name}`);
  }
  expect(errors).toEqual([]);
});

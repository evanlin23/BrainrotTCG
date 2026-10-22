import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * Answering the Restore row's Replace / Keep mine question (#978): the buttons leave the row with the
 * answer, and keyboard focus goes to the row's Import button instead of falling to the page. Pressed
 * with the keyboard, as a keyboard or screen-reader user would. A no-room answer asks again with the
 * same buttons, so focus stays where it is until that is answered too. Opening the question is the
 * handoff the other way: Import leaves the row, so the focus it held goes to Keep mine.
 */

const player = JSON.stringify({ secretKey: 'bb'.repeat(32), name: 'Another player', nextNonce: 3, createdAt: 1 });
const OTHER_SAVE = JSON.stringify({ version: 2, exportedAt: '2026-01-01T00:00:00.000Z', player, stats: JSON.stringify({ packsOpened: 5 }) });

/** `from` is where the focus is when the file is picked: the row's Import button, as after pressing it with the keyboard, or the Back up row's Export. */
async function askToReplace(page: Page, baseURL: string, from?: 'Import' | 'Export') {
  const errors = await monitor(page, baseURL, 1, { returning: true });
  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main).toBeVisible();
  const restore = main.locator('.settings-row').filter({ has: page.locator('.settings-label', { hasText: /^Restore$/ }) });
  if (from) await main.getByRole('button', { name: from, exact: true }).focus();
  await main.locator('input[type="file"]').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(OTHER_SAVE) });
  const keep = restore.getByRole('button', { name: 'Keep mine', exact: true });
  await expect(keep).toBeVisible();
  return { errors, restore, keep, replace: restore.getByRole('button', { name: 'Replace', exact: true }), importButton: restore.getByRole('button', { name: 'Import', exact: true }) };
}

test('Keep mine hands focus to Import in the Restore row (#978)', async ({ page, baseURL }) => {
  const { errors, restore, keep, importButton } = await askToReplace(page, baseURL!);
  await keep.focus();
  await page.keyboard.press('Enter');
  await expect(restore.locator('.settings-desc')).toHaveText('Kept your save.');
  await expect(importButton).toBeFocused();
  expect(errors).toEqual([]);
});

test('a refused Replace keeps focus in the row, and answering the no-room question then hands it to Import (#978)', async ({ page, baseURL }) => {
  const { errors, restore, keep, replace, importButton } = await askToReplace(page, baseURL!);
  // The browser refuses the copy of the current save, which Replace writes first.
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'brainrot-before-import-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      write.call(this, key, value);
    };
  });
  await replace.focus();
  await page.keyboard.press('Enter');
  await expect(restore.locator('.settings-desc')).toContainText("There's no room in this browser's storage");
  // The same button asks again, and still holds the focus.
  const goOn = restore.getByRole('button', { name: 'Replace without a copy', exact: true });
  await expect(goOn).toBeFocused();
  await keep.focus();
  await page.keyboard.press('Enter');
  await expect(restore.locator('.settings-desc')).toHaveText('Kept your save.');
  await expect(importButton).toBeFocused();
  expect(errors).toEqual([]);
});

test('the question opening hands focus from Import to Keep mine (#978)', async ({ page, baseURL }) => {
  const { errors, keep, importButton } = await askToReplace(page, baseURL!, 'Import');
  await expect(keep).toBeFocused();
  await expect(importButton).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the question opening leaves focus on another control (#978)', async ({ page, baseURL }) => {
  const { errors, keep } = await askToReplace(page, baseURL!, 'Export');
  await expect(keep).not.toBeFocused();
  await expect(page.getByRole('main', { name: 'Settings', exact: true }).getByRole('button', { name: 'Export', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

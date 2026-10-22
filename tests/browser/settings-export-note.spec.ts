import { test, expect } from '@playwright/test';
import { monitor } from './support';

/**
 * Export in Save & backup (#805): the file arrives as a browser download with no other sign on the page,
 * so the Back up row says it was downloaded, and keeps the warning that the file holds the secret key.
 */
test('Export says the backup was downloaded and to keep it private (#805)', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main).toBeVisible();
  const row = main.locator('.settings-row').filter({ has: page.locator('.settings-label', { hasText: /^Back up$/ }) });
  const note = row.locator('.settings-desc');
  await expect(note).toHaveText('Includes your secret player key. Keep the file private.');

  const download = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^brainrot-tcg-save-\d{4}-\d{2}-\d{2}\.txt$/);
  await expect(note).toHaveText('Backup downloaded — keep it private. It includes your secret player key.');
  expect(errors).toEqual([]);
});

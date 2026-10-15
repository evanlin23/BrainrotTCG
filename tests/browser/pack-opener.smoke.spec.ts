import { test, expect } from '@playwright/test';
import { monitor, expectDecoded, snapshot, expectRecordedPack } from './support';

test('opens one real pack and preserves its exact cards, counts, modifiers and ticket after reload', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.getByRole('button', { name: /^Open a .* pack$/ });
  await expect(packShell).toBeVisible();
  await expectDecoded(packShell.locator('img'), 2);
  // Keyboard activation exercises the accessible opening control in both viewport projects.
  await packShell.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.summary-title')).not.toBeEmpty();
  await expectDecoded(page.locator('.summary-cards img'), 5);

  const before = await expectRecordedPack(page);

  await page.reload();
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'My cards', exact: true }).click();
  const myCards = page.getByRole('dialog', { name: 'My cards', exact: true });
  const personal = myCards.getByRole('navigation', { name: 'My cards', exact: true });
  await personal.getByRole('button', { name: 'Best pulls', exact: true }).click();
  await expect(myCards).toContainText('All packs · 1');
  await personal.getByRole('button', { name: 'Cards', exact: true }).click();
  await expect(page.locator('.collection-set').first()).toBeVisible();
  // Compare after UI hydration, not merely immediately after navigation.
  expect(await snapshot(page)).toEqual(before);
  await page.locator('.sheet').getByRole('button', { name: 'Close', exact: true }).click();
  expect(errors).toEqual([]);
});

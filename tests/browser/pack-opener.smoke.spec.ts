import { test, expect } from '@playwright/test';
import { monitor, expectDecoded, snapshot, expectRecordedPack } from './support';

test('opens one real pack and preserves its exact cards, counts, modifiers and ticket after reload', { tag: '@cross-browser' }, async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.locator('.pack-shell');
  const openButton = page.getByRole('button', { name: /^Open pack/ });
  await expect(packShell).toBeVisible();
  await expectDecoded(packShell.locator('img'), 2);
  // A new player sees only the pack; the set picker comes once their first pack is saved.
  const picker = page.getByRole('navigation', { name: 'Choose a pack', exact: true });
  await expect(picker).toHaveCount(0);
  // Keyboard activation exercises the accessible opening control in both viewport projects.
  await openButton.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.summary-title')).not.toBeEmpty();
  await expectDecoded(page.locator('.summary-cards img'), 5);
  // Saved now, but the summary is still focus mode: the picker doesn't step in over the cards.
  await expect(picker).toBeHidden();

  const before = await expectRecordedPack(page);

  await page.reload();
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(picker).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Main', exact: true });
  await tabs.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Profile', exact: true })).toContainText('All packs · 1');
  await tabs.getByRole('button', { name: 'Cards', exact: true }).click();
  await expect(page.locator('.collection-set').first()).toBeVisible();
  // Compare after UI hydration, not merely immediately after navigation.
  expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button', { name: 'Close Cards', exact: true }).click();
  await expect(packShell).toBeVisible();
  await expect(openButton).toBeVisible();
  expect(errors).toEqual([]);
});

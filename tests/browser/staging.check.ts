import { test, expect, type Page } from '@playwright/test';
import { expectDecoded, monitor } from './support';

/*
 * Staging (docs/HOSTING.md#staging), run by playwright.staging.config.ts: against the deployed
 * candidate in the deploy, or a local stand-in elsewhere. Not in the default browser suite, whose
 * builds have no staging host.
 */

// The browser fetches same-origin files itself: staging.localhost resolves in Chromium, not in Node.
const guard = { continueAllowed: true };

const settings = async (page: Page) => {
  await page.goto('./#/settings');
  await expect(page.getByRole('main', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByText('Save & backup', { exact: true }).first()).toBeVisible();
};

test('a staging copy says so, asks not to be indexed, and takes no save from the old address', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, guard);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(page.locator('.staging-banner')).toContainText('Staging: a test copy of the next release.');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  // Going to Settings leaves the packs screen; its pack art finishes arriving first, as it must on a real CDN.
  await expectDecoded(page.locator('.pack-shell img'), 2);
  await settings(page);
  await expect(page.getByText('From the old address', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

import { test, expect } from '@playwright/test';
import { monitor } from './support';

/*
 * Staging's local stand-in only (playwright.staging.config.ts without STAGING_URL): the same build
 * served at a production address too. The deploy doesn't run this file, since its production address
 * still serves the previous release while staging is checked.
 */

// The browser fetches same-origin files itself: staging.localhost resolves in Chromium, not in Node.
const guard = { continueAllowed: true };

test('the same build at a production address is the real game, and keeps its own saves', async ({ page, baseURL }) => {
  const production = baseURL!.replace('//staging.localhost:', '//127.0.0.1:');
  const errors = await monitor(page, baseURL!, 0, { ...guard, allowedOrigins: [new URL(production).origin] });
  await page.goto(baseURL!);
  await expect(page.locator('.staging-banner')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('brainrot-staging-probe', 'staging'));

  await page.goto(production);
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(page.locator('.staging-banner')).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  // Another origin: nothing written on staging is here.
  expect(await page.evaluate(() => localStorage.getItem('brainrot-staging-probe'))).toBeNull();
  // This build knows the old address, so production offers the save it holds there; staging (above) doesn't.
  await page.goto(`${production}#/settings`);
  await expect(page.getByRole('main', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByText('From the old address', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

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
  await settings(page);
  await expect(page.getByText('From the old address', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the same build at a production address is the real game, and keeps its own saves', async ({ page, baseURL }) => {
  test.skip(!!process.env.STAGING_URL, 'The deploy checks staging only; production still serves the previous release.');
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

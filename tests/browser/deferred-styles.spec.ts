import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

const SETTINGS_CSS = /\/assets\/Settings-[\w-]+\.css$/;
const SETTINGS_JS = /\/assets\/SettingsPage-[\w-]+\.js$/;

const unexpectedErrors = (errors: string[], expectedUrl: RegExp) =>
  errors.filter(
    (error) =>
      !expectedUrl.test(error) &&
      error !== 'Failed to load resource: net::ERR_FAILED' &&
      error !== 'Failed to load resource: the server responded with a status of 404 (Not Found)',
  );

const unexpectedOfflineErrors = (errors: string[]) =>
  errors.filter((error) => !error.includes('net::ERR_INTERNET_DISCONNECTED') && !error.includes('Failed to load resource'));

async function countSettingsLinks(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
      .filter((l) => /\/assets\/Settings-[\w-]+\.css/.test(l.href)).length,
  );
}

async function getSettingsStyleSheetRules(page: Page) {
  return page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.href && /\/assets\/Settings-[\w-]+\.css/.test(sheet.href)) {
        try {
          return sheet.cssRules.length;
        } catch {
          return -1;
        }
      }
    }
    return 0;
  });
}

test('healthy load control: Settings has flex row layout and loaded stylesheet rules', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main.locator('.settings')).toBeVisible({ timeout: 15000 });
  const row = main.locator('.settings-row').first();
  await expect(row).toHaveCSS('display', 'flex');
  await expect(row).toHaveCSS('min-height', '60px');
  const rules = await getSettingsStyleSheetRules(page);
  expect(rules).toBeGreaterThanOrEqual(19);
  expect(await countSettingsLinks(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('CSS 404 failure: Retry restores stylesheet and row flex layout without duplicates', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  let failing = true;
  let requests = 0;
  await page.route(SETTINGS_CSS, (route) => {
    requests++;
    if (failing) {
      return route.fulfill({ status: 404, body: 'Not found' });
    }
    return route.continue();
  });

  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main.getByRole('alert')).toContainText("Couldn't load Settings.");
  expect(requests).toBeGreaterThanOrEqual(1);

  failing = false;
  await main.getByRole('button', { name: 'Retry', exact: true }).click();

  await expect(main.locator('.settings')).toBeVisible({ timeout: 15000 });
  const row = main.locator('.settings-row').first();
  await expect(row).toHaveCSS('display', 'flex');
  await expect(row).toHaveCSS('min-height', '60px');
  const rules = await getSettingsStyleSheetRules(page);
  expect(rules).toBeGreaterThanOrEqual(19);
  expect(await countSettingsLinks(page)).toBe(1);
  expect(requests).toBeGreaterThanOrEqual(2);
  expect(unexpectedErrors(errors, SETTINGS_CSS)).toEqual([]);
});

test('CSS abort failure: Retry restores stylesheet and row flex layout without duplicates', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  let failing = true;
  let requests = 0;
  await page.route(SETTINGS_CSS, (route) => {
    requests++;
    if (failing) {
      return route.abort('failed');
    }
    return route.continue();
  });

  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main.getByRole('alert')).toContainText("Couldn't load Settings.");
  expect(requests).toBeGreaterThanOrEqual(1);

  failing = false;
  await main.getByRole('button', { name: 'Retry', exact: true }).click();

  await expect(main.locator('.settings')).toBeVisible({ timeout: 15000 });
  const row = main.locator('.settings-row').first();
  await expect(row).toHaveCSS('display', 'flex');
  await expect(row).toHaveCSS('min-height', '60px');
  const rules = await getSettingsStyleSheetRules(page);
  expect(rules).toBeGreaterThanOrEqual(19);
  expect(await countSettingsLinks(page)).toBe(1);
  expect(requests).toBeGreaterThanOrEqual(2);
  expect(unexpectedErrors(errors, SETTINGS_CSS)).toEqual([]);
});

test('repeated retries on persistent CSS failure do not accumulate duplicate stylesheet links', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  let failing = true;
  await page.route(SETTINGS_CSS, (route) => {
    if (failing) {
      return route.fulfill({ status: 404, body: 'Not found' });
    }
    return route.continue();
  });

  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main.getByRole('alert')).toContainText("Couldn't load Settings.");
  expect(await countSettingsLinks(page)).toBe(0);

  // Click Retry multiple times while still failing
  for (let i = 0; i < 3; i++) {
    await main.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(main.getByRole('alert')).toContainText("Couldn't load Settings.");
    expect(await countSettingsLinks(page)).toBe(0);
  }

  // Restore and retry: should cleanly load with exactly 1 link
  failing = false;
  await main.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(main.locator('.settings')).toBeVisible({ timeout: 15000 });
  const row = main.locator('.settings-row').first();
  await expect(row).toHaveCSS('display', 'flex');
  expect(await countSettingsLinks(page)).toBe(1);
  expect(unexpectedErrors(errors, SETTINGS_CSS)).toEqual([]);
});

test('JavaScript chunk failure control: Settings JS failure offers Retry and recovers', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  let failing = true;
  let chunkUrl = '';
  await page.route(SETTINGS_JS, (route) => {
    chunkUrl = route.request().url();
    if (failing) {
      return route.abort('failed');
    }
    return route.continue();
  });

  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main.getByRole('alert')).toContainText("Couldn't load Settings.");

  failing = false;
  await main.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(main.locator('.settings')).toBeVisible({ timeout: 15000 });
  const row = main.locator('.settings-row').first();
  await expect(row).toHaveCSS('display', 'flex');
  expect(await countSettingsLinks(page)).toBe(1);
  expect(unexpectedErrors(errors, new RegExp(chunkUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toEqual([]);
});

test('whole-graph offline failure: Reload recovery restores the page, keeping saves and route', async ({ page, baseURL, context }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  // Go offline mid-session, then open Rankings
  await context.setOffline(true);
  const rankingsBtn = page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Rankings', exact: true });
  await rankingsBtn.click();

  const main = page.getByRole('main', { name: 'Rankings', exact: true });
  await expect(main.getByRole('alert')).toContainText("Couldn't load Rankings.");
  await expect(main.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();

  // Reconnect online and click Reload
  await context.setOffline(false);
  await main.getByRole('button', { name: 'Reload', exact: true }).click();

  // Complete Rankings page renders with tab panel and hall of fame
  await expect(page.locator('.hall-of-fame')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(`${baseURL}#/rankings`);

  // Verify save data in storage was preserved
  const hasPlayer = await page.evaluate(() => !!localStorage.getItem('brainrot-player-v1'));
  expect(hasPlayer).toBe(true);
  expect(unexpectedOfflineErrors(errors)).toEqual([]);
});

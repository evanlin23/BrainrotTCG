import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor } from './support';

const SETTINGS_CSS = /\/assets\/Settings-[\w-]+\.css$/;
const SETTINGS_JS = /\/assets\/SettingsPage-[\w-]+\.js$/;

// Reload cancels card art still downloading; that is the reload, not a failure.
const reloadAbortedArt = (error: string) => /^net::ERR_ABORTED \S+\.webp$/.test(error);

const unexpectedErrors = (errors: string[], expectedUrl: RegExp) =>
  errors.filter(
    (error) =>
      !expectedUrl.test(error) &&
      !reloadAbortedArt(error) &&
      error !== 'Failed to load resource: net::ERR_FAILED' &&
      error !== 'Failed to load resource: the server responded with a status of 404 (Not Found)',
  );

const unexpectedOfflineErrors = (errors: string[]) =>
  errors.filter((error) => !error.includes('net::ERR_INTERNET_DISCONNECTED') && !error.includes('Failed to load resource') && !reloadAbortedArt(error));

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

test('persistent CSS failure: a failed Retry hands over to Reload without leaving stylesheet links, and Reload recovers', async ({ page, baseURL }) => {
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

  // Retry while still failing: no stale link stays behind, and Retry gives way to Reload.
  await main.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(main.getByRole('alert')).toContainText("Couldn't load Settings. Retrying didn't fix it");
  await expect(main.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  expect(await countSettingsLinks(page)).toBe(0);

  // Restore and reload: should cleanly load with exactly 1 link
  failing = false;
  await main.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(main.locator('.settings')).toBeVisible({ timeout: 15000 });
  const row = main.locator('.settings-row').first();
  await expect(row).toHaveCSS('display', 'flex');
  expect(await countSettingsLinks(page)).toBe(1);
  expect(unexpectedErrors(errors, SETTINGS_CSS)).toEqual([]);
});

/**
 * Presses Retry with the network restored. Some browsers keep a failed module graph, so Retry fetches
 * nothing new: the page must then drop Retry and point to Reload, which recovers (#664). Either way
 * the page ends up loaded; Retry is never left on offer doing nothing.
 */
async function retryOrReload(main: Locator, loaded: Locator) {
  await main.getByRole('button', { name: 'Retry', exact: true }).click();
  const reloadOnly = main.getByRole('alert').filter({ hasText: "Retrying didn't fix it" });
  await expect(loaded.or(reloadOnly)).toBeVisible({ timeout: 15000 });
  if (await loaded.isVisible()) return;
  await expect(main.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await main.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(loaded).toBeVisible({ timeout: 15000 });
}

test('JavaScript chunk failure control: Settings JS failure offers Retry, which recovers or hands over to Reload', async ({ page, baseURL }) => {
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
  await retryOrReload(main, main.locator('.settings'));
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

const RANKINGS_CSS = /\/assets\/HallOfFamePage-[\w-]+\.css$/;

const ruleCount = (page: Page, href: RegExp) =>
  page.evaluate((source) => {
    const pattern = new RegExp(source);
    const sheet = Array.from(document.styleSheets).find((s) => s.href && pattern.test(s.href));
    return sheet ? sheet.cssRules.length : 0;
  }, href.source);

test('warming Rankings while Settings loads fails neither page nor drops the Rankings stylesheet', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  let releaseSettings!: () => void;
  const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
  let releaseRankings!: () => void;
  const rankingsGate = new Promise<void>((resolve) => { releaseRankings = resolve; });
  let settingsAsked = false;
  let rankingsCssAsked = false;
  await page.route(SETTINGS_JS, async (route) => {
    settingsAsked = true;
    await settingsGate;
    await route.continue();
  });
  await page.route(RANKINGS_CSS, async (route) => {
    rankingsCssAsked = true;
    await rankingsGate;
    await route.continue();
  });

  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main', exact: true });
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect.poll(() => settingsAsked).toBe(true);
  // Focus warms Rankings (as hover does): its stylesheet is now in the document, still loading.
  await nav.getByRole('button', { name: 'Rankings', exact: true }).focus();
  await expect.poll(() => rankingsCssAsked).toBe(true);

  releaseSettings();
  const settings = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(settings.locator('.settings-row').first()).toHaveCSS('display', 'flex');
  await expect(settings.getByRole('alert')).toHaveCount(0);

  releaseRankings();
  await nav.getByRole('button', { name: 'Rankings', exact: true }).click();
  const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
  await expect(rankings.locator('.hall-of-fame')).toBeVisible();
  await expect(rankings.getByRole('alert')).toHaveCount(0);
  expect(await ruleCount(page, RANKINGS_CSS)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('whole-graph offline failure: after reconnecting, Retry recovers or hands over to Reload, never a dead Retry', async ({ page, baseURL, context }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Rankings', exact: true }).click();
  const main = page.getByRole('main', { name: 'Rankings', exact: true });
  await expect(main.getByRole('alert')).toContainText("Couldn't load Rankings.");
  const retry = main.getByRole('button', { name: 'Retry', exact: true });
  // Still offline, a failed Retry keeps offering Retry: the connection, not the page, is the problem.
  await retry.click();
  await expect(main.getByRole('alert')).toContainText("Couldn't load Rankings.");
  await expect(retry).toBeVisible();

  await context.setOffline(false);
  await retryOrReload(main, main.locator('.hall-of-fame'));
  await expect(page).toHaveURL(`${baseURL}#/rankings`);
  expect(await ruleCount(page, RANKINGS_CSS)).toBeGreaterThan(0);
  expect(await page.evaluate(() => !!localStorage.getItem('brainrot-player-v1'))).toBe(true);
  expect(unexpectedOfflineErrors(errors)).toEqual([]);
});

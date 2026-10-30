import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expectPackDropped, expectRankingsChecked, monitor, sameStorage, storageOf } from './support';

// Every screen loaded on demand, not just the shared pull (deferred-chunk.spec.ts), survives a slow or
// failed chunk (#340): the four pages hold a skeleton, then offer Reload and Retry; the share sheets and
// the shared profile do the same inside one sheet that keeps focus and closes with Escape. Cards and
// Rankings' slow skeletons are covered by sheet-entry.spec.ts. Timings are this runner's, on desktop
// Chromium and its phone emulation; real-phone latency is measured by hand under #8.

const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors.json', import.meta.url), 'utf8')) as {
  profiles: { note: string; profile: string; name: string }[];
};

const chunkOf = (name: string) => new RegExp(`/assets/${name}-[\\w-]+\\.js$`);

/** A page with nothing left to finish once its content shows. */
const shown = () => Promise.resolve();
// `settled`: what a page still finishes after its content shows, before a step leaves it. Rankings
// checks recent pulls once its list is in, and leaving mid-check aborts a read (expectRankingsChecked).
const PAGES = [
  { route: 'cards', name: 'Cards', chunk: 'CollectionBrowser', content: (main: Locator) => main.locator('.collection'), settled: shown },
  {
    route: 'rankings', name: 'Rankings', chunk: 'HallOfFamePage', content: (main: Locator) => main.locator('.hall-of-fame'),
    settled: (main: Locator) => expectRankingsChecked(main),
  },
  { route: 'profile', name: 'Profile', chunk: 'ProfilePage', content: (main: Locator) => main.getByText(/^Player ID #/), settled: shown },
  { route: 'settings', name: 'Settings', chunk: 'SettingsPage', content: (main: Locator) => main.locator('.settings'), settled: shown },
];

/**
 * Fails every request for the chunk while `failing` is set (Vite asks twice per attempt: a modulepreload
 * link and the import). Pointing at a tab prefetches its chunk too, so repeats are expected.
 */
async function failChunk(page: Page, name: string) {
  const chunk = { failing: true, failed: 0, served: 0, succeeded: 0, url: '' };
  page.on('response', (response) => {
    if (chunkOf(name).test(response.url()) && response.ok()) chunk.succeeded++;
  });
  await page.route(chunkOf(name), (route) => {
    chunk.url = route.request().url();
    if (chunk.failing) {
      chunk.failed++;
      return route.abort('failed');
    }
    chunk.served++;
    return route.continue();
  });
  return chunk;
}

/** Holds every request for the chunk until `release` is called. */
async function holdChunk(page: Page, name: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(chunkOf(name), async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

const unexpected = (errors: string[], chunkUrl: string) => errors.filter((error) =>
  error !== `net::ERR_FAILED ${chunkUrl}` && error !== 'Failed to load resource: net::ERR_FAILED');

/** Tab and Shift+Tab, pressed past both ends, never leave the dialog. */
async function expectFocusTrapped(page: Page, dialog: Locator) {
  const inside = () => dialog.evaluate((element) => element.contains(document.activeElement));
  const count = await dialog.evaluate((element) => Array.from(element.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((item) => item.offsetParent !== null).length);
  expect(count).toBeGreaterThan(0);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let n = 0; n < count + 2; n++) {
      await page.keyboard.press(key);
      expect(await inside(), `${key} #${n + 1} stays in the dialog`).toBe(true);
    }
  }
}

/** A cached failed module graph can require Reload after one online Retry (#664). */
async function retryOrReload(page: Page, sheet: Locator, loaded: Locator) {
  await sheet.getByRole('button', { name: 'Retry', exact: true }).click();
  const reloadOnly = sheet.getByRole('alert').filter({ hasText: "Retrying didn't fix it" });
  await expect(loaded.or(reloadOnly)).toBeVisible({ timeout: 15000 });
  if (await loaded.isVisible()) return false;
  await expect(sheet.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expectFocusTrapped(page, sheet);
  await sheet.getByRole('button', { name: 'Reload', exact: true }).click();
  return true;
}

const profilePage = async (page: Page, navigate = true) => {
  if (navigate) await page.goto('./#/profile');
  const main = page.getByRole('main', { name: 'Profile', exact: true });
  await expect(main.getByText(/^Player ID #/)).toBeVisible();
  return main;
};

function report(name: string, ms: number) {
  test.info().annotations.push({ type: 'timing', description: `${name}: ${ms} ms` });
  console.log(`[${test.info().project.name}] ${name}: ${ms} ms`);
}

test.describe('pages', () => {
  for (const { route, name, chunk: chunkName, content } of PAGES) {
    test(`${name} offers Reload and Retry when its chunk fails, and Retry loads it`, async ({ page, baseURL }) => {
      const errors = await monitor(page, baseURL!, 1, { returning: true });
      const chunk = await failChunk(page, chunkName);
      await page.goto(`./#/${route}`);
      const main = page.getByRole('main', { name, exact: true });
      await expect(main.getByRole('alert')).toContainText(`Couldn't load ${name}.`);
      await expect(main.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
      // The close button still works while the page is broken.
      await expect(main.getByRole('button', { name: `Close ${name}`, exact: true })).toBeVisible();
      expect(chunk.served).toBe(0);
      chunk.failing = false;
      await main.getByRole('button', { name: 'Retry', exact: true }).click();
      // Retry moves focus to the heading, so it isn't lost with the button.
      await expect(main.getByRole('heading', { level: 1, name, exact: true })).toBeFocused();
      await expect(content(main).first()).toBeVisible({ timeout: 15000 });
      await expect(main.getByRole('alert')).toHaveCount(0);
      await expect(main.locator('.page-skeleton')).toHaveCount(0);
      await expect(page).toHaveURL(`${baseURL}#/${route}`);
      expect(chunk.served).toBeGreaterThan(0);
      expect(unexpected(errors, chunk.url)).toEqual([]);
    });
  }

  test('a failed page recovers with Reload, keeping its route', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    const chunk = await failChunk(page, 'SettingsPage');
    await page.goto('./#/settings');
    const main = page.getByRole('main', { name: 'Settings', exact: true });
    await expect(main.getByRole('alert')).toContainText("Couldn't load Settings.");
    chunk.failing = false;
    await main.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(main.locator('.settings')).toBeVisible({ timeout: 15000 });
    await expect(page).toHaveURL(`${baseURL}#/settings`);
    expect(chunk.served).toBeGreaterThan(0);
    expect(unexpected(errors, chunk.url)).toEqual([]);
  });

  for (const { route, name, chunk: chunkName, content } of PAGES.filter(({ route }) => route === 'profile' || route === 'settings')) {
    test(`${name} holds a skeleton while its chunk is slow, then shows in place`, async ({ page, baseURL }) => {
      const errors = await monitor(page, baseURL!, 1, { returning: true });
      const release = await holdChunk(page, chunkName);
      await page.goto(`./#/${route}`);
      const main = page.getByRole('main', { name, exact: true });
      await expect(main.getByRole('status')).toHaveText(`Loading ${name}…`);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const releasedAt = Date.now();
      release();
      await expect(content(main).first()).toBeVisible({ timeout: 15000 });
      report(`${name} slow chunk released to page`, Date.now() - releasedAt);
      await expect(main.locator('.page-skeleton')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
});

/** The sheets that load on demand, each opened from its usual place. `opener` is what gets focus back. */
const SHEETS: {
  title: string;
  chunk: string;
  open: (page: Page, navigate?: boolean) => Promise<Locator | null>;
  loaded: (page: Page) => Locator;
}[] = [
  {
    title: 'Share your pull',
    chunk: 'ShareSheet',
    open: async (page, navigate) => {
      const main = await profilePage(page, navigate);
      const row = main.locator('.pulls-history .pull-row').first();
      await row.click();
      return row;
    },
    loaded: (page) => page.getByRole('dialog', { name: 'Share your pull', exact: true }).getByRole('button', { name: 'Copy link', exact: true }),
  },
  {
    title: 'Share Bukangi',
    chunk: 'CardShareSheet',
    open: async (page, navigate) => {
      // A card of the player's own pack, from My pulls: its share sheet loads on demand.
      const main = await profilePage(page, navigate);
      await main.locator('.pulls-history .pull-row').first().click();
      const pull = page.getByRole('dialog', { name: 'Share your pull', exact: true });
      await pull.getByText('Share an individual card', { exact: true }).click();
      await pull.getByRole('region', { name: 'Cards in this pack', exact: true }).getByRole('button', { name: /^Bukangi\b/ }).first().click();
      const share = page.getByRole('dialog', { name: 'Bukangi', exact: true }).getByRole('button', { name: 'Share card', exact: true });
      await share.click();
      return share;
    },
    loaded: (page) => page.getByRole('dialog', { name: 'Share Bukangi', exact: true }).getByRole('button', { name: 'Copy link', exact: true }),
  },
  {
    title: 'Shared profile',
    chunk: 'ProfileViewerPage',
    open: async (page) => {
      await page.goto(`./#/profile/${vectors.profiles.find(({ note }) => note === 'one set')!.profile}`);
      return null;
    },
    // The viewer then verifies the profile's tickets, which is slow on a cold mobile run: its own sheet
    // replacing the placeholder is the chunk's part.
    loaded: (page) => page.getByRole('dialog').and(page.locator('.profile-viewer')),
  },
];

test.describe('sheets', () => {
  for (const { title, chunk: chunkName, open, loaded } of SHEETS) {
    test(`${title}: a failed chunk keeps focus in its sheet, recovers, Escape closes it`, async ({ page, baseURL }) => {
      test.setTimeout(60000);
      const errors = await monitor(page, baseURL!, 1, { returning: true });
      const chunk = await failChunk(page, chunkName);
      let opener = await open(page);
      const sheet = page.getByRole('dialog', { name: title, exact: true });
      await expect(sheet.getByRole('alert')).toContainText(`Couldn't load ${title}.`);
      await expect(sheet.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
      await expectFocusTrapped(page, sheet);
      const url = page.url();
      // Distinguish the saved identity from monitor's initial seed, so reseeding after data loss fails.
      await page.evaluate(() => {
        const player = JSON.parse(localStorage.getItem('brainrot-player-v1')!);
        localStorage.setItem('brainrot-player-v1', JSON.stringify({ ...player, name: 'Recovery fixture' }));
      });
      const saved = await storageOf(page);
      const dialogsBefore = await page.getByRole('dialog').count();
      chunk.failing = false;
      const reloaded = await retryOrReload(page, sheet, loaded(page));
      await expect(page).toHaveURL(url);
      // A shared-profile route reopens itself. Other shares are transient overlays: after Reload,
      // reopen through the Profile UI, rebuilding the stack and using the new opener for Escape.
      if (reloaded && opener) opener = await open(page, false);
      await expect(page.locator('.sheet--deferred')).toHaveCount(0);
      await expect(loaded(page)).toBeVisible({ timeout: 15000 });
      await expect(page).toHaveURL(url);
      expect(sameStorage(saved, await storageOf(page)), 'recovery preserves saved data').toBe(true);
      expect(chunk.served).toBeGreaterThan(0);
      expect(chunk.succeeded).toBeGreaterThan(0);
      // The loaded screen keeps the same trap, and Escape closes it back to its opener. A card's share sheet
      // sits over the card viewer and the pull, so count dialogs: `.last()` would re-resolve to the viewer.
      const dialogs = page.getByRole('dialog');
      await expect(dialogs).toHaveCount(dialogsBefore);
      const shown = await dialogs.count();
      await expectFocusTrapped(page, dialogs.last());
      await page.keyboard.press('Escape');
      await expect(dialogs).toHaveCount(shown - 1);
      if (opener) await expect(opener).toBeFocused();
      expect(unexpected(errors, chunk.url)).toEqual([]);
    });

    test(`${title}: Escape closes its loading sheet, and the late chunk opens nothing`, async ({ page, baseURL }) => {
      test.setTimeout(60000);
      const errors = await monitor(page, baseURL!, 1, { returning: true });
      const release = await holdChunk(page, chunkName);
      const opener = await open(page);
      const sheet = page.getByRole('dialog', { name: title, exact: true });
      await expect(sheet.getByRole('status')).toHaveText(`Loading ${title}…`);
      await expectFocusTrapped(page, sheet);
      const dialogsUnder = await page.getByRole('dialog').count() - 1;
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      if (opener) await expect(opener).toBeFocused();
      const arrived = page.waitForResponse(chunkOf(chunkName));
      release();
      // Closing retired the load, so the chunk's arrival is the last thing that could open the sheet. Import
      // the same module again: that settles once the first import has evaluated, then wait for an idle
      // main thread so the render it could have caused has run.
      const chunkUrl = (await arrived).url();
      await page.evaluate(async (href) => {
        await import(/* @vite-ignore */ href);
        await new Promise<void>((done) => requestIdleCallback(() => done()));
      }, chunkUrl);
      await expect(page.getByRole('dialog')).toHaveCount(dialogsUnder);
      expect(errors).toEqual([]);
    });
  }
});

declare global {
  interface Window { longTasks: number[]; longTaskObserver: PerformanceObserver }
}

test('long tasks while opening each page, cold and then with its chunk loaded (emulation)', async ({ page, baseURL }) => {
  // Emulation only: desktop Chromium and its Pixel 5 profile with the CPU slowed 4x, on this runner.
  // Real-phone numbers are measured by hand under #8, so nothing here is held to a bound.
  test.setTimeout(90000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await page.addInitScript(() => {
    window.longTasks = [];
    window.longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.longTasks.push(entry.duration);
    });
    window.longTaskObserver.observe({ type: 'longtask', buffered: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectPackDropped(page);
  // Takes what the observer has queued but not yet delivered, so the total is read at once, not after a pause.
  const total = () => page.evaluate(() => {
    for (const entry of window.longTaskObserver.takeRecords()) window.longTasks.push(entry.duration);
    const sum = window.longTasks.reduce((a, b) => a + b, 0);
    window.longTasks = [];
    return Math.round(sum);
  });
  report('startup long tasks, 4x CPU (emulation)', await total());
  const tabs = page.getByRole('navigation', { name: 'Main', exact: true });
  for (const { name, content, settled } of PAGES) {
    for (const when of ['cold', 'loaded']) {
      // Settings sits in the header; the others are tabs.
      await (name === 'Settings' ? page.locator('.app-utilities').getByRole('button', { name, exact: true }) : tabs.getByRole('button', { name, exact: true })).click();
      const main = page.getByRole('main', { name, exact: true });
      await expect(content(main).first()).toBeVisible({ timeout: 30000 });
      await settled(main);
      // The page has stopped working on the open once the main thread goes idle.
      await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
      report(`${name} ${when} open long tasks, 4x CPU (emulation)`, await total());
      await main.getByRole('button', { name: `Close ${name}`, exact: true }).click();
      await expect(main).toHaveCount(0);
    }
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  expect(errors).toEqual([]);
});

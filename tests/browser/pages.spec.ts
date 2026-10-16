import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fingerFor, monitor, snapshot } from './support';

// Cards, Rankings, Profile and Settings are hash-routed pages over the packs screen (#312). Each one
// is reached by its address, by its tab and by Back, at a phone and a desktop size; packs and shared
// links share one history with them.

const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors.json', import.meta.url), 'utf8')) as {
  valid: { note: string; proof: string }[];
};

const PAGES = [
  { route: 'cards', name: 'Cards', chunk: 'CollectionBrowser' },
  { route: 'rankings', name: 'Rankings', chunk: 'HallOfFamePage' },
  { route: 'profile', name: 'Profile', chunk: 'ProfilePage' },
  { route: 'settings', name: 'Settings', chunk: 'SettingsPage' },
] as const;
const CHUNK = new RegExp(`/assets/(${PAGES.map(({ chunk }) => chunk).join('|')})-[^/]+\\.js$`);

test.beforeEach(async ({ page }, testInfo) => {
  await page.setViewportSize(testInfo.project.name.startsWith('mobile') ? { width: 360, height: 740 } : { width: 1280, height: 800 });
});

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main', exact: true });
const tab = (page: Page, name: string) => nav(page).getByRole('button', { name, exact: true });
const gear = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true });
const pageNamed = (page: Page, name: string) => page.getByRole('main', { name, exact: true });
const opener = (page: Page) => page.getByRole('button', { name: 'Open pack', exact: true });
// The link under the pack; the summary's score panel has its own "Card guide" button.
const cardGuide = (page: Page) => page.locator('.card-guide-entry').getByRole('button', { name: 'Card guide', exact: true });
/** The control that marks a page current: its tab, or the gear for Settings. */
const marker = (page: Page, name: string) => (name === 'Settings' ? gear(page) : tab(page, name));

/** Page chunks the browser has asked for, by name. */
const watchChunks = (page: Page) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    const match = CHUNK.exec(new URL(request.url()).pathname);
    if (match) requested.push(match[1]);
  });
  return requested;
};

const noSideScroll = (page: Page) => page.evaluate(() => {
  const wide = [document.documentElement, ...Array.from(document.querySelectorAll('main.page'))].filter((el) => el.scrollWidth > el.clientWidth);
  return wide.map((el) => el.className || el.tagName);
});

async function onPage(page: Page, baseURL: string, { route, name }: { route: string; name: string }, focused: boolean) {
  await expect(page).toHaveURL(`${baseURL}#/${route}`);
  await expect(pageNamed(page, name)).toBeVisible();
  await expect(page).toHaveTitle(`${name} - Brainrot TCG`);
  await expect(marker(page, name)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (focused) await expect(pageNamed(page, name).getByRole('heading', { level: 1 })).toBeFocused();
  // The packs screen stays mounted under the page, out of sight and out of reach.
  await expect(opener(page)).toBeHidden();
  expect(await noSideScroll(page)).toEqual([]);
}

async function onOpen(page: Page, baseURL: string) {
  await expect(page.locator('main.page')).toHaveCount(0);
  await expect(page).toHaveURL(baseURL);
  await expect(tab(page, 'Open')).toHaveAttribute('aria-current', 'page');
  await expect(opener(page)).toBeEnabled();
  await expect(page.locator('.app-logo')).toBeFocused();
}

/**
 * Opens a pack and skips to its summary. The tabs and the gear are out of the way while it opens: on a
 * phone the header goes with them (focus mode, #312), and from 900px the gear stays in view, disabled.
 */
async function openPackSummary(page: Page) {
  await opener(page).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await expect(nav(page)).toBeHidden();
  if ((page.viewportSize()?.width ?? 0) < 900) await expect(page.locator('.app-header')).toBeHidden();
  else await expect(gear(page)).toBeDisabled();
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 15000 });
}

for (const target of PAGES) {
  test(`#/${target.route} opens the ${target.name} page directly, loading only its own chunk`, async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    const chunks = watchChunks(page);
    await page.goto(`./#/${target.route}`);
    await onPage(page, baseURL!, target, false);
    await expect(pageNamed(page, target.name).locator('.page-skeleton')).toHaveCount(0, { timeout: 15000 });
    expect(chunks).toEqual([target.chunk]);
    await pageNamed(page, target.name).getByRole('button', { name: `Close ${target.name}`, exact: true }).click();
    await expect(page.locator('main.page')).toHaveCount(0);
    await expect(page).toHaveURL(baseURL!);
    await expect(opener(page)).toBeEnabled();
    await expect(page).toHaveTitle(/Brainrot TCG/);
    expect(errors).toEqual([]);
  });
}

test('tabs and the gear open each page in turn, and Back walks them back to Open', async ({ page, baseURL }, testInfo) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  const chunks = watchChunks(page);
  await page.goto('./');
  await expect(opener(page)).toBeEnabled();
  const openTitle = await page.title();
  // No page chunk at startup: each loads when its tab is pointed at or pressed.
  await page.waitForTimeout(300);
  expect(chunks).toEqual([]);
  expect(await noSideScroll(page)).toEqual([]);

  // Four tabs of at least 44px: a bottom bar on phones, a row in the header on wide screens.
  const items = nav(page).locator('.app-nav-item');
  await expect(items).toHaveCount(4);
  for (const item of await items.all()) {
    const box = (await item.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const bar = (await nav(page).boundingBox())!;
  const header = (await page.locator('.app-header').boundingBox())!;
  if (testInfo.project.name.startsWith('mobile')) {
    await expect(nav(page)).toHaveCSS('position', 'fixed');
    expect(Math.abs(bar.y + bar.height - 740)).toBeLessThanOrEqual(1);
  } else {
    expect(bar.y).toBeGreaterThanOrEqual(header.y);
    expect(bar.y + bar.height).toBeLessThanOrEqual(header.y + header.height + 1);
  }

  for (const target of PAGES) {
    await (target.name === 'Settings' ? gear(page) : tab(page, target.name)).click();
    await onPage(page, baseURL!, target, true);
    await expect(pageNamed(page, target.name).locator('.page-skeleton')).toHaveCount(0, { timeout: 15000 });
  }
  expect([...new Set(chunks)].sort()).toEqual(PAGES.map(({ chunk }) => chunk).sort());

  for (const target of PAGES.slice(0, -1).reverse()) {
    await page.goBack();
    await onPage(page, baseURL!, target, false);
  }
  await page.goBack();
  await onOpen(page, baseURL!);
  await expect(page).toHaveTitle(openTitle);

  if (!testInfo.project.name.startsWith('mobile')) {
    // The narrowest header that holds the tabs still fits them on one row.
    await page.setViewportSize({ width: 900, height: 800 });
    expect(await noSideScroll(page)).toEqual([]);
    const narrowBar = (await nav(page).boundingBox())!;
    const narrowHeader = (await page.locator('.app-header').boundingBox())!;
    expect(narrowBar.y + narrowBar.height).toBeLessThanOrEqual(narrowHeader.y + narrowHeader.height + 1);
    // The logo (mark and wordmark) scales down with the row, so it ends before the first tab.
    for (const width of [900, 960, 1000]) {
      await page.setViewportSize({ width, height: 800 });
      const { logoRight, tabLeft } = await page.evaluate(() => {
        const parts = Array.from(document.querySelectorAll('.app-logo, .app-logo *'));
        const firstTab = document.querySelector('.app-header .app-nav-item')!;
        return {
          logoRight: Math.max(...parts.map((el) => el.getBoundingClientRect().right)),
          tabLeft: firstTab.getBoundingClientRect().left,
        };
      });
      expect(logoRight, `at ${width}px`).toBeLessThanOrEqual(tabLeft);
    }
  }
  expect(errors).toEqual([]);
});

test('a new player sees no tabs until their first pack is saved', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(opener(page)).toBeEnabled();
  await expect(nav(page)).toHaveCount(0);
  await expect(gear(page)).toBeVisible();
  // The card guide is there before the first pull, and Escape gives focus back to its button (#184).
  const guide = cardGuide(page);
  await expect(guide).toBeVisible();
  await guide.click();
  const sheet = page.getByRole('dialog', { name: 'Card guide', exact: true });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(guide).toBeFocused();
  await openPackSummary(page);
  await expect.poll(async () => (await snapshot(page)).stats?.packsOpened).toBe(1);
  // The tabs exist once the pack is saved, but focus mode keeps them aside until the player leaves it (#312).
  await expect(page.locator('.app-nav')).toHaveCount(1);
  await expect(page.locator('.app-nav')).toBeHidden();
  await expect(guide).toHaveCount(0);
  await page.getByRole('button', { name: 'Open another pack', exact: true }).click();
  await expect(tab(page, 'Cards')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the card guide link fits a 320 px phone at 200% text, under the pack it leaves alone', async ({ page, baseURL, hasTouch }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
  await page.setViewportSize({ width: 320, height: 568 });
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(opener(page)).toBeEnabled();
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const guide = cardGuide(page);
  await expect(guide).toBeVisible();
  const box = (await guide.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y + box.height).toBeLessThanOrEqual(568);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  // Nothing covers it, and the pack stays the big target above it.
  await guide.click();
  await expect(page.getByRole('dialog', { name: 'Card guide', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(opener(page)).toBeVisible();
  // The pack is still on screen and still opens with a swipe along its tear line (#486).
  const pack = page.locator('.pack-shell');
  await pack.scrollIntoViewIfNeeded();
  await expect(pack).toBeInViewport();
  const packBox = (await pack.boundingBox())!;
  const tearY = packBox.y + packBox.height * 0.19;
  const xAt = (fraction: number) => packBox.x + packBox.width * fraction;
  const finger = await fingerFor(page, hasTouch);
  await finger.press(xAt(0.3), tearY);
  for (let step = 1; step <= 6; step++) await finger.move(xAt(0.3 + (0.4 * step) / 6), tearY);
  await finger.release();
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
});

test('the card guide icon is 16 px as a Settings button too, as it is under the pack (#486)', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./#/settings');
  const guide = pageNamed(page, 'Settings').getByRole('button', { name: 'Card guide', exact: true });
  await expect(guide).toBeVisible();
  const size = await guide.locator('svg').evaluate((icon) => {
    const { width, height } = icon.getBoundingClientRect();
    return { width, height };
  });
  expect(size).toEqual({ width: 16, height: 16 });
  expect(errors).toEqual([]);
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a tab opens its page and Back returns to Open', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./');
    await expect(opener(page)).toBeEnabled();
    await tab(page, 'Rankings').click();
    await onPage(page, baseURL!, PAGES[1], true);
    await expect(pageNamed(page, 'Rankings').locator('.hall-of-fame')).toBeVisible({ timeout: 15000 });
    await page.goBack();
    await onOpen(page, baseURL!);
    expect(errors).toEqual([]);
  });
});

/** Back from the pack's own entry leaves it, at the address it started on, with the pack kept. */
async function backLeavesPack(page: Page, start: string) {
  await page.goBack();
  await expect(page.locator('.pack-summary')).toHaveCount(0, { timeout: 15000 });
  await expect(opener(page)).toBeVisible();
  expect(page.url()).toBe(start);
  await expect.poll(async () => (await snapshot(page)).stats?.packsOpened).toBe(2);
}

test('Back from a page opened over a pack returns to the pack, and the next Back leaves it', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(opener(page)).toBeEnabled();
  const start = page.url();
  await openPackSummary(page);
  const cards = await page.locator('.pack-summary').innerText();

  // Focus mode hides the tabs for the whole pack (#312), so a page reaches a pack's summary by its address.
  await page.evaluate(() => { location.hash = '#/cards'; });
  await onPage(page, baseURL!, PAGES[0], false);
  await tab(page, 'Rankings').click();
  await onPage(page, baseURL!, PAGES[1], true);
  await page.goBack();
  await onPage(page, baseURL!, PAGES[0], false);
  await page.goBack();
  // The pack in progress survived under the pages.
  await expect(page.locator('.pack-summary')).toBeVisible();
  expect(await page.locator('.pack-summary').innerText()).toBe(cards);
  expect(page.url()).toBe(start);
  await backLeavesPack(page, start);

  // Closing a page opened over a pack steps back onto the pack too.
  await openPackSummary(page);
  await page.evaluate(() => { location.hash = '#/profile'; });
  await onPage(page, baseURL!, PAGES[2], false);
  await pageNamed(page, 'Profile').getByRole('button', { name: 'Close Profile', exact: true }).click();
  await expect(page.locator('.pack-summary')).toBeVisible();
  expect(page.url()).toBe(start);
  await page.goBack();
  await expect(page.locator('.pack-summary')).toHaveCount(0, { timeout: 15000 });
  expect(page.url()).toBe(start);
  expect(errors).toEqual([]);
});

test('a page reached from a toast over a pack summary hands focus back to the summary when it closes', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(opener(page)).toBeEnabled();
  const start = page.url();
  await openPackSummary(page);

  // With the tabs out of the way, the first pack's unlock toast is how a player gets from its summary to a page.
  await page.locator('.toast-region').getByRole('button', { name: /achievements? unlocked/i }).click();
  await onPage(page, baseURL!, PAGES[2], false);
  await pageNamed(page, 'Profile').getByRole('button', { name: 'Close Profile', exact: true }).click();
  await expect(page.locator('.pack-summary')).toBeVisible();
  expect(page.url()).toBe(start);
  // On a phone the header, logo and all, is still out of the way; from 900px it shows. Either way the
  // summary is what the player came back to, so it takes focus, never the page body.
  if ((page.viewportSize()?.width ?? 0) < 900) await expect(page.locator('.app-header')).toBeHidden();
  else await expect(page.locator('.app-header')).toBeVisible();
  await expect(page.locator('.summary-title')).toBeFocused();
  expect(errors).toEqual([]);
});

test('closing a shared pull opened over a pack keeps the pack, and one Back then leaves it', async ({ page, baseURL }) => {
  // The viewer verifies the proof's Argon2id tickets in a worker, which is slow on a cold mobile run.
  test.setTimeout(90000);
  const vector = vectors.valid.find(({ note }) => note === 'empty name, archived set')!;
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(opener(page)).toBeEnabled();
  const start = page.url();
  await openPackSummary(page);

  await page.evaluate((proof) => { location.hash = `#/pull/${proof}`; }, vector.proof);
  const viewer = page.getByRole('dialog').filter({ hasText: 'Verified on this device' });
  await expect(viewer).toBeVisible({ timeout: 30000 });
  await viewer.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.pack-summary')).toBeVisible();
  expect(page.url()).toBe(start);
  // #436: this first Back used to do nothing.
  await page.goBack();
  await expect(page.locator('.pack-summary')).toHaveCount(0, { timeout: 15000 });
  await expect(opener(page)).toBeVisible();
  expect(page.url()).toBe(start);
  await expect.poll(async () => (await snapshot(page)).stats?.packsOpened).toBe(2);
  expect(errors).toEqual([]);
});

test('closing a link opened over a page returns to that page, and Back then goes to Open', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(opener(page)).toBeEnabled();
  await tab(page, 'Cards').click();
  await onPage(page, baseURL!, PAGES[0], true);

  await page.evaluate(() => { location.hash = '#/pull/cut-off'; });
  const notice = page.getByRole('dialog', { name: "This link doesn't work", exact: true });
  await expect(notice).toBeVisible();
  await expect(tab(page, 'Cards')).not.toHaveAttribute('aria-current', 'page');
  await notice.getByRole('button', { name: 'Close', exact: true }).first().click();
  await onPage(page, baseURL!, PAGES[0], false);
  await page.goBack();
  await onOpen(page, baseURL!);
  expect(errors).toEqual([]);
});

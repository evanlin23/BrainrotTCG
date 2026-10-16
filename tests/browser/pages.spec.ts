import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { monitor, snapshot } from './support';

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
const opener = (page: Page) => page.getByRole('button', { name: /^Open a .* pack$/ });
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

/** Opens a pack and skips to its summary. The tabs and the gear are out of the way while it opens. */
async function openPackSummary(page: Page) {
  await opener(page).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await expect(nav(page)).toBeHidden();
  await expect(gear(page)).toBeDisabled();
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
  await openPackSummary(page);
  await expect(tab(page, 'Cards')).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).stats?.packsOpened).toBe(1);
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

  await tab(page, 'Cards').click();
  await onPage(page, baseURL!, PAGES[0], true);
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
  await tab(page, 'Profile').click();
  await onPage(page, baseURL!, PAGES[2], true);
  await pageNamed(page, 'Profile').getByRole('button', { name: 'Close Profile', exact: true }).click();
  await expect(page.locator('.pack-summary')).toBeVisible();
  expect(page.url()).toBe(start);
  await page.goBack();
  await expect(page.locator('.pack-summary')).toHaveCount(0, { timeout: 15000 });
  expect(page.url()).toBe(start);
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

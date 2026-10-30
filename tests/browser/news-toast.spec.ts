import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { LATEST_NEWS_ID, monitor, recordShownToasts, scaleText } from './support';

/**
 * What's new (#1280): the news is a page (#/news) and, for the latest unread entry, a one-time toast in the
 * app's own toast queue, after a pack is put away and never over the tear, reveal or summary, nor on a
 * page load or a route change. The chip beside the Card guide link is gone, so that row carries no
 * announcements and the next goal is never hidden by one. The toast takes no room and covers no control
 * (as toast-home.spec.ts checks for the achievement toasts), and reading, dismissing or timing it out
 * reads the entry for good, even when storage refuses the write.
 */
// The page and the toast read the announcements the build ships (src/content/news.json), so these run
// against them: their words may change, what they must do may not.
const news = (JSON.parse(readFileSync(new URL('../../src/content/news.json', import.meta.url), 'utf8')) as { id: string; title: string; date: string; summary: string }[])
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

/** The chunk that carries the announcements: asked for only when the app wants to know whether there is news. */
const NEWS_CHUNK = /\/news-[\w-]+\.js/;
const shownToasts = (page: Page) => page.evaluate(() => (window as unknown as { __shownToasts: string[] }).__shownToasts.slice());

/** A returning player (the tabs show) who has not read the latest announcement; toasts are held, so no step races a timer. */
async function open(page: Page, baseURL: string, size: { width: number; height: number }, { unreadNews = true, path = './' } = {}) {
  await page.setViewportSize(size);
  await recordShownToasts(page, { hold: true });
  const errors = await monitor(page, baseURL, 0, { returning: true, unreadNews });
  await page.goto(path);
  return errors;
}

/** Opens a pack from the pack screen, skips to its summary, and puts it away with "Next pack". */
async function putPackAway(page: Page) {
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await page.getByRole('button', { name: /Next pack/ }).click();
  await expect(page.locator('.set-current')).toBeVisible();
}

const newsToast = (page: Page) => page.locator('.toast').filter({ has: page.locator('.toast-kicker', { hasText: "What's new" }) });

/** The pack's own toasts (achievements, a level-up) come first, one at a time; send each away until the news one is up. */
async function untilNewsToast(page: Page) {
  for (let step = 0; step < 8; step++) {
    await expect(page.locator('.toast')).toHaveCount(1, { timeout: 15000 });
    if (await newsToast(page).count()) break;
    // Sending one away brings the next in at once, so wait for this very toast to leave (or give way to another) rather than for none.
    const current = await page.locator('.toast').elementHandle();
    const words = await current!.evaluate((el) => el.textContent);
    await page.locator('.toast-dismiss').click();
    await page.waitForFunction(([el, was]) => !el!.isConnected || el!.textContent !== was, [current, words] as const);
  }
  await expect(newsToast(page)).toBeVisible();
}

/**
 * Sends each of the pack's toasts away, one at a time, until none is left. The pack's first toast is waited for (a pack
 * always has one); after that, sending one away brings the next in at once, so once the browser is idle again a toast
 * that is not there is one that is not coming. No timed wait stands in for "no more".
 */
async function sendAwayEveryToast(page: Page) {
  await expect(page.locator('.toast')).toHaveCount(1, { timeout: 15000 });
  for (let step = 0; step < 8; step++) {
    const handle = await page.$('.toast');
    if (!handle) return;
    const words = await handle.evaluate((el) => el.textContent);
    await page.locator('.toast-dismiss').click();
    await page.waitForFunction(([el, was]) => !el!.isConnected || el!.textContent !== was, [handle, words] as const);
    await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
  }
  throw new Error('The pack kept sending toasts');
}

/** A returning player with unread news, one pack put away, and the news toast on screen. */
async function toNewsToast(page: Page, baseURL: string, size: { width: number; height: number }) {
  const errors = await open(page, baseURL, size);
  await putPackAway(page);
  await untilNewsToast(page);
  return errors;
}

const CONTROLS = ['.set-step', '.set-current', '.pack-shell', '[data-pack-open]', '.card-guide-link', '.pack-milestone', '.app-utilities button', '.app-nav-item'];

/** The controls the toast overlaps, and those whose centre a touch would hand to something else. */
const blocked = (page: Page) => page.evaluate((selectors) => {
  const toast = document.querySelector('.toast')!.getBoundingClientRect();
  const problems: string[] = [];
  for (const selector of selectors) {
    for (const [index, el] of Array.from(document.querySelectorAll(selector)).entries()) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (toast.left < box.right && toast.right > box.left && toast.top < box.bottom && toast.bottom > box.top) problems.push(`${selector}[${index}] is under the toast`);
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!at || !el.contains(at)) problems.push(`${selector}[${index}] loses its centre to ${at?.closest('.toast') ? 'the toast' : at?.className}`);
    }
  }
  return problems;
}, CONTROLS);

/** Where every control sits, rounded to a pixel, for comparing the page with the toast up and after it has gone. */
const placed = (page: Page) => page.evaluate((selectors) => selectors.flatMap((selector) =>
  Array.from(document.querySelectorAll(selector)).map((el, index) => {
    const { left, top, width, height } = el.getBoundingClientRect();
    return `${selector}[${index}] ${Math.round(left)},${Math.round(top)} ${Math.round(width)}x${Math.round(height)}`;
  })), CONTROLS);

const noHorizontalScroll = (page: Page, width: number) =>
  expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

for (const [width, height, percent] of [[390, 844, 100], [360, 640, 100], [320, 568, 100], [320, 568, 200]] as const) {
  test(`toasts the latest news over the header without moving anything on a ${width} x ${height} phone at ${percent}% text`, async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
    test.setTimeout(120000);
    const errors = await toNewsToast(page, baseURL!, { width, height });
    if (percent !== 100) await scaleText(page, percent);
    const toast = newsToast(page);
    await expect(toast).toBeVisible();
    // The chip beside the Card guide link is gone: that row carries the guide and the next goal, no news.
    await expect(page.locator('.news-banner')).toHaveCount(0);
    await expect(page.locator('.card-guide-entry > :not(.card-guide-link, .pack-milestone)')).toHaveCount(0);
    await expect(page.locator('.card-guide-entry > .card-guide-link')).toHaveCount(1);
    // Unread news never hides the next goal (it did while the chip took the row first): on every phone with room for it.
    if (width > 320) await expect(page.locator('.card-guide-entry .pack-milestone')).toBeVisible();
    expect((await toast.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => blocked(page), { message: 'no control is under the news toast' }).toEqual([]);
    await noHorizontalScroll(page, width);
    // It takes no room: the page is laid out the same once it has gone.
    // The pack settles into place as the screen loads; measure once it has, with the toast still up.
    let previous = '';
    await expect.poll(async () => { const now = (await placed(page)).join(); const same = now === previous; previous = now; return same; }).toBe(true);
    const during = await placed(page);
    expect((await page.locator('.toast-region').boundingBox())!.height).toBe(0);
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.toast')).toHaveCount(0);
    expect(await placed(page)).toEqual(during);
    expect(errors).toEqual([]);
  });
}

// Where on a wide screen the toast sits (top right, for every toast, as toast-home.spec.ts checks) is the
// toast system's rule, not this feature's: this checks the news toast takes the same place and covers no control.
test('toasts the latest news at the top right on a wide screen, clear of every control', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A wide-screen layout check.');
  test.setTimeout(120000);
  const errors = await toNewsToast(page, baseURL!, { width: 1280, height: 800 });
  const toast = newsToast(page);
  await expect(page.locator('.card-guide-entry .pack-milestone')).toBeVisible();
  await expect.poll(() => blocked(page), { message: 'no control is under the news toast' }).toEqual([]);
  const box = (await toast.boundingBox())!;
  const settings = (await page.locator('.app-utilities button').first().boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  // At the right edge (the page's gutter is 2rem), under the header's row, on screen, and not over the Settings button.
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.x + box.width).toBeGreaterThanOrEqual(1280 - 40);
  expect(box.y).toBeGreaterThanOrEqual(settings.y + settings.height);
  expect(box.y).toBeLessThan(200);
  expect(box.x + box.width <= settings.x || box.y + box.height <= settings.y || box.y >= settings.y + settings.height).toBe(true);
  expect(errors).toEqual([]);
});

test('a returning player with unread news gets no toast on a page load or a route change, and the news is not even asked for', async ({ page, baseURL }) => {
  const asked: string[] = [];
  page.on('request', (request) => { if (NEWS_CHUNK.test(request.url())) asked.push(request.url()); });
  const errors = await open(page, baseURL!, { width: 390, height: 844 });
  await expect(page.locator('.set-current')).toBeVisible();
  // The next goal is on the row, with news unread: nothing hides it.
  await expect(page.locator('.card-guide-entry .pack-milestone')).toBeVisible();
  await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
  await page.evaluate(() => { location.hash = '#/cards'; });
  await expect(page.getByRole('main', { name: 'Cards', exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = ''; });
  await expect(page.locator('.set-current')).toBeVisible();
  await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(await shownToasts(page)).toEqual([]);
  expect(asked).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEYS.DISMISSED_NEWS)).toBeNull();
  expect(errors).toEqual([]);
});

test('tapping the toast opens What\'s new with every entry, and the entry is read for good', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  const errors = await toNewsToast(page, baseURL!, { width: 390, height: 844 });
  await newsToast(page).locator('.toast-open').click();
  const main = page.getByRole('main', { name: "What's new", exact: true });
  await expect(main.getByRole('heading', { level: 1, name: "What's new", exact: true })).toBeFocused();
  await expect(page).toHaveURL(`${baseURL}#/news`);
  await expect(page).toHaveTitle("What's new - Brainrot TCG");
  // Newest first, each with its title, date, tag and whole summary.
  const entries = main.locator('.news-entry');
  await expect(entries).toHaveCount(news.length);
  for (const [index, item] of news.entries()) {
    const entry = entries.nth(index);
    await expect(entry.getByRole('heading', { level: 2, name: item.title, exact: true })).toBeVisible();
    await expect(entry.locator('.news-entry-summary')).toHaveText(item.summary);
    await expect(entry.locator('time')).toHaveAttribute('datetime', item.date);
    await expect(entry.locator('.news-entry-tag')).not.toBeEmpty();
  }
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEYS.DISMISSED_NEWS)).toBe(LATEST_NEWS_ID);
  // Back home and after a reload: no second toast, once the app has asked about the news after another pack.
  await main.getByRole('button', { name: "Close What's new", exact: true }).click();
  await expect(page.locator('.set-current')).toBeVisible();
  await page.reload();
  const asked = page.waitForRequest(NEWS_CHUNK);
  await putPackAway(page);
  await asked;
  await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
  await expect(newsToast(page)).toHaveCount(0);
  expect((await shownToasts(page)).filter((kicker) => kicker === "What's new")).toEqual([]);
  expect(errors).toEqual([]);
});

test('dismissing the toast with its X reads it, kept across a reload and another pack', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  const errors = await toNewsToast(page, baseURL!, { width: 390, height: 844 });
  await newsToast(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(newsToast(page)).toHaveCount(0);
  await page.reload();
  const asked = page.waitForRequest(NEWS_CHUNK);
  await putPackAway(page);
  await asked;
  await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
  await expect(newsToast(page)).toHaveCount(0);
  expect((await shownToasts(page)).filter((kicker) => kicker === "What's new")).toEqual([]);
  expect(errors).toEqual([]);
});

test('a storage quota error on reading it still holds for the visit', async ({ page, baseURL }) => {
  test.setTimeout(150000);
  await page.addInitScript((key) => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, name: string, value: string) {
      if (name === key) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return write.call(this, name, value);
    };
  }, STORAGE_KEYS.DISMISSED_NEWS);
  const errors = await toNewsToast(page, baseURL!, { width: 390, height: 844 });
  await newsToast(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(newsToast(page)).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEYS.DISMISSED_NEWS)).toBeNull();
  // Another page, back, and another pack put away: not toasted again in this visit.
  await page.evaluate(() => { location.hash = '#/cards'; });
  await expect(page.getByRole('main', { name: 'Cards', exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = ''; });
  await expect(page.locator('.set-current')).toBeVisible();
  // The announcements are loaded already (no second request to wait for): the news would queue behind the
  // pack's own toasts, so send those all away and see that none follows them.
  await putPackAway(page);
  await sendAwayEveryToast(page);
  await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
  await expect(newsToast(page)).toHaveCount(0);
  expect((await shownToasts(page)).filter((kicker) => kicker === "What's new")).toEqual(["What's new"]);
  expect(errors).toEqual([]);
});

test('a player who already read the latest entry is not toasted after a pack', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  const errors = await open(page, baseURL!, { width: 390, height: 844 }, { unreadNews: false });
  const asked = page.waitForRequest(NEWS_CHUNK);
  await putPackAway(page);
  await asked;
  await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
  await expect(newsToast(page)).toHaveCount(0);
  expect((await shownToasts(page)).filter((kicker) => kicker === "What's new")).toEqual([]);
  expect(errors).toEqual([]);
});

test('comes after the pack is put away, behind the pack\'s own toasts, one at a time, never over the tear or reveal', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  await recordShownToasts(page, { hold: true });
  const errors = await monitor(page, baseURL!, 0, { unreadNews: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  // Nothing has been shown over the tear or the reveal.
  expect(await shownToasts(page)).toEqual([]);
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  // The summary still holds the pack screen: the pack's own notice may be up, the news waits for the pack to be put away.
  expect(await shownToasts(page)).not.toContain("What's new");
  await expect(newsToast(page)).toHaveCount(0);

  await page.getByRole('button', { name: /Next pack/ }).click();
  await expect(page.locator('.set-current')).toBeVisible();
  await untilNewsToast(page);
  const log = await shownToasts(page);
  expect(log.at(-1)).toBe("What's new");
  expect(log.length).toBeGreaterThan(1);
  expect(log.filter((kicker) => kicker === "What's new")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a returning player\'s waiting news does not jump ahead when the next pack starts: its notices show first on the summary, the news only after it is put away', async ({ page, baseURL }) => {
  test.setTimeout(150000);
  const errors = await open(page, baseURL!, { width: 390, height: 844 });
  await expect(page.locator('.set-current')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  // The pack's own notice is on screen over its summary; the news is not.
  await expect.poll(() => shownToasts(page), { message: 'the pack\'s notice shows on its summary' }).not.toEqual([]);
  expect(await shownToasts(page)).not.toContain("What's new");
  await expect(newsToast(page)).toHaveCount(0);

  // Put away: the notices are held on screen, so the news waits behind them, unshown. The next pack starts at once.
  await page.getByRole('button', { name: /Next pack/ }).click();
  await expect(page.locator('.set-current')).toBeVisible();
  expect(await shownToasts(page)).not.toContain("What's new");
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  // The queue the summary shows from has no news in it: it never lands ahead of the pack's notices.
  await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
  expect(await shownToasts(page)).not.toContain("What's new");
  await expect(newsToast(page)).toHaveCount(0);

  // Put away again: the news follows the notices, once.
  await page.getByRole('button', { name: /Next pack/ }).click();
  await expect(page.locator('.set-current')).toBeVisible();
  await untilNewsToast(page);
  const log = await shownToasts(page);
  expect(log.at(-1)).toBe("What's new");
  expect(log.filter((kicker) => kicker === "What's new")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('waits for the save warning: the toast would sit over the banner and its buttons, so it comes in once the warning is gone', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  const origin = new URL(baseURL!).origin;
  await page.addInitScript(({ key, archive, origin }) => {
    if (window.location.origin !== origin) return;
    try { localStorage.setItem(key, archive); } catch { /* storage blocked */ }
  }, { key: STORAGE_KEYS.COLLECTION_RECOVERY, archive: JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null }), origin });
  const errors = await open(page, baseURL!, { width: 360, height: 740 });
  const banner = page.locator('.save-warning[role="alert"]');
  await expect(banner).toBeVisible();
  await putPackAway(page);
  // The pack's own toasts show as they always do (the toast system's rule); the news is the one the banner holds back, so
  // send every one of them away: nothing is then left on screen, and the news, which is queued, must not take their place.
  await sendAwayEveryToast(page);
  await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done())));
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(await shownToasts(page)).not.toContain("What's new");
  await expect(banner).toBeVisible();
  // Hiding the note clears the warning: the news follows the pack's toasts, and the banner is gone from under it.
  await banner.getByRole('button', { name: 'Hide note' }).click();
  await expect(banner).toHaveCount(0);
  await untilNewsToast(page);
  expect(errors).toEqual([]);
});

test('What\'s new is a page for a first-time visitor with no save, and fits 320px at 200% text', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
  await page.setViewportSize({ width: 320, height: 568 });
  const errors = await monitor(page, baseURL!);
  await page.goto('./#/news');
  const main = page.getByRole('main', { name: "What's new", exact: true });
  await expect(main.locator('.news-entry')).toHaveCount(news.length);
  // No save and no first pack: no tabs, and no toast waiting behind the page.
  await expect(page.locator('.app-nav')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0);
  await scaleText(page, 200);
  await noHorizontalScroll(page, 320);
  const close = (await main.getByRole('button', { name: "Close What's new", exact: true }).boundingBox())!;
  expect(close.width).toBeGreaterThanOrEqual(44);
  expect(close.height).toBeGreaterThanOrEqual(44);
  // Entries stay inside the screen however long their words are.
  for (const entry of await main.locator('.news-entry').all()) {
    const box = (await entry.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  expect(errors).toEqual([]);
});

test('Settings leads to What\'s new, and closing it returns to the pack screen like any page', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/settings');
  const settings = page.getByRole('main', { name: 'Settings', exact: true });
  const button = settings.getByRole('button', { name: "What's new", exact: true });
  await expect(button).toBeVisible();
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await button.click();
  const main = page.getByRole('main', { name: "What's new", exact: true });
  await expect(main.locator('.news-entry')).toHaveCount(news.length);
  await expect(page).toHaveURL(`${baseURL}#/news`);
  await main.getByRole('button', { name: "Close What's new", exact: true }).click();
  await expect(main).toHaveCount(0);
  await expect(page.locator('.set-current')).toBeVisible();
  expect(errors).toEqual([]);
});

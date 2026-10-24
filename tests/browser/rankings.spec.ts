import { test, expect } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { expectRankingsChecked, monitor, relaysAnswerEmpty } from './support';

// Rankings pages its rows, and Profile's best pulls lead with the best packs. The leaderboard is a synthetic
// list served in place of hall-of-fame.json: its proofs are fake, and the page never re-derives a
// published pull (each row links to its proof instead). Nothing here fetches real data or submits anything.

const entries = Array.from({ length: 45 }, (_, i) => ({
  id: `fixture-${i}`,
  proof: `fixture-proof-${i}`,
  name: `Fixture ${i + 1}`,
  fingerprint: 'abcd',
  setId: 'right-now',
  setName: 'Right Now',
  hand: 'Full House',
  multiplier: 150,
  score: 50_000 - i,
  submittedAt: '2026-10-01T00:00:00.000Z',
  cards: [],
  issue: 1000 + i,
  githubUser: 'fixture',
}));

test('Rankings shows 20 rows, and each Show more adds 20 from the keyboard', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: entries }));
  await page.goto('./');
  const main = page.getByRole('navigation', { name: 'Main', exact: true });
  await main.getByRole('button', { name: 'Rankings', exact: true }).click();
  const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
  // Every fixture was filed on 1 Oct 2026, so they rank on All-time.
  await rankings.getByRole('tab', { name: 'All-time', exact: true }).click();
  const rows = rankings.locator('.hof-list .hof-entry');
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toHaveAttribute('aria-label', /^Number 1: /);
  await expect(rows.first()).toHaveAttribute('href', '#/pull/fixture-proof-0');

  const more = rankings.getByRole('button', { name: 'Show more', exact: true });
  await more.scrollIntoViewIfNeeded();
  expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Tab from the last row reaches it, and Enter carries on from the first new row.
  await rows.nth(19).focus();
  await page.keyboard.press('Tab');
  await expect(more).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(40);
  await expect(rows.nth(20)).toBeFocused();
  await expect(rows.nth(20)).toHaveAttribute('aria-label', /^Number 21: /);

  await more.click();
  await expect(rows).toHaveCount(45);
  await expect(rows.last()).toHaveAttribute('aria-label', /^Number 45: /);
  await expect(more).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe('at 320px with 200% text and reduced motion', () => {
  test.use({ reducedMotion: 'reduce', viewport: { width: 320, height: 640 } });

  test('Rankings opens on Today, moves to All-time by arrow key, and keeps the legends in a sheet', async ({ page, baseURL }) => {
    // 320px is an emulated phone width; 200% text doubles the root size the rem tokens use. Every
    // fixture was filed on 1 Oct 2026, so Today is empty and nothing reaches it from a relay.
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await relaysAnswerEmpty(page);
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: entries }));
    await page.goto('./#/rankings');
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
    const panel = rankings.getByRole('tabpanel');
    await expect(panel).toContainText('No pulls filed today yet.');
    await expect(panel).toContainText('Resets at 00:00 UTC');
    await expect(rankings.locator('.hof-list')).toHaveCount(0);
    await expect(rankings).not.toContainText('World firsts');

    const tabs = rankings.getByRole('tablist', { name: 'Rankings lists', exact: true }).getByRole('tab');
    await expect(tabs).toHaveText(['Today', 'All-time']);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    for (const box of await Promise.all((await tabs.all()).map((tab) => tab.boundingBox()))) {
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    const sideScroll = () => page.evaluate(() => [document.documentElement, ...Array.from(document.querySelectorAll('main.page'))]
      .filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.className || el.tagName));
    expect(await sideScroll()).toEqual([]);

    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.first()).toHaveAttribute('tabindex', '-1');
    await expect(rankings.locator('.hof-list .hof-entry')).toHaveCount(20);
    expect(await sideScroll()).toEqual([]);

    // Where it started: the hackathon's screenshots, opened from a quiet button below the lists.
    const origins = rankings.getByRole('button', { name: 'Where it started', exact: true });
    await origins.scrollIntoViewIfNeeded();
    expect((await origins.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await origins.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Where it started', exact: true });
    await expect(sheet).toContainText("Screenshots from the hackathon, before pulls could be verified, so they aren't ranked.");
    await expect(sheet.locator('.hof-legend img')).toHaveCount(3);
    expect(await sideScroll()).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(origins).toBeFocused();

    await tabs.nth(1).focus();
    await page.keyboard.press('Home');
    await expect(tabs.first()).toBeFocused();
    await expect(panel).toContainText('No pulls filed today yet.');
    expect(errors).toEqual([]);
  });
});

// One populated row at enlarged text: the fingerprint, score and the other fields must not paint over each
// other. Emulation, not native text zoom: the root font size is scaled, as the rem tokens read it.
const populated = {
  ...entries[0],
  id: 'row-fixture',
  proof: 'row-fixture-proof',
  name: 'Collector',
  fingerprint: '6HTG-Z65X',
  score: 546_000,
  cards: ['pirate-gaster', 'niu-lai', 'bukangi', 'huss-valley', 'la-peace'].map((cardId) => ({ cardId, isHolo: false })),
};

// `stacked` is the layout the row must be in (four columns, or rank/score over cards over text). Asserting it
// makes every case fail on a wrong threshold: no restack at all fails the stacked ones, and one threshold
// of 18rem + 98px at every width (the strip is 62px, not 102px, at 420px and under) fails the 390, 375 and
// 360px phones, and a threshold well above it, such as the old 110px, fails the 428 and 430px phones, which
// have room for the compact row.
// Row width = viewport - 2 x gutter (16px up to 400px, 4vw above, doubled with 200% text).
for (const { width, height, text, label, score = 546_000, stacked } of [
  { width: 320, height: 640, text: 200, label: '320x640 at 200% text', stacked: true },
  { width: 568, height: 320, text: 200, label: '568x320 at 200% text', stacked: true },
  // Ordinary phones at 100% text keep today's compact single row (62px card strip at 420px and under).
  { width: 390, height: 844, text: 100, label: 'a normal phone', stacked: false },
  { width: 375, height: 667, text: 100, label: '375px at 100% text', stacked: false },
  { width: 360, height: 800, text: 100, label: '360px at 100% text with an 8-digit score', score: 99_999_999, stacked: false },
  // iPhone Pro Max and Plus widths at 100% text: just above 420px, they keep the compact row too.
  { width: 428, height: 926, text: 100, label: '428px at 100% text', stacked: false },
  { width: 430, height: 932, text: 100, label: '430px at 100% text', stacked: false },
  { width: 1100, height: 800, text: 100, label: 'a wide screen', stacked: false },
  // Just above the restack threshold, where the fixed-width card strip used to push the row past its edge.
  { width: 650, height: 800, text: 200, label: '650px at 200% text', stacked: true },
  { width: 500, height: 800, text: 150, label: '500px at 150% text', stacked: true },
  { width: 430, height: 900, text: 125, label: '430px at 125% text', stacked: true },
  // Long scores: 8 digits is what a 5 of a Kind (x10,000) reaches with modifiers; the engine allows more.
  { width: 320, height: 640, text: 100, label: '320px with an 8-digit score', score: 99_999_999, stacked: true },
  { width: 320, height: 640, text: 200, label: '320px at 200% text with an 8-digit score', score: 99_999_999, stacked: true },
  { width: 500, height: 800, text: 150, label: '500px at 150% text with an 8-digit score', score: 99_999_999, stacked: true },
]) {
  test.describe(`a populated Rankings row at ${label}`, () => {
    test.use({ viewport: { width, height } });

    test('keeps hand, player, fingerprint, set and score apart, and still opens its proof', async ({ page, baseURL }) => {
      const errors = await monitor(page, baseURL!, 0, { returning: true });
      await relaysAnswerEmpty(page);
      await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [{ ...populated, score }] }));
      await page.goto('./#/rankings');
      await page.addStyleTag({ content: `html { font-size: ${text}% !important; }` });
      // Measure with the web fonts in, as phone-type-floor.spec.ts does: fallback glyphs have other widths.
      await page.evaluate(() => document.fonts.ready);
      const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
      await rankings.getByRole('tab', { name: 'All-time', exact: true }).click();
      const row = rankings.locator('.hof-list .hof-entry').first();
      await expect(row).toHaveAttribute('aria-label', `Number 1: Full House by Collector in Right Now, score ${score}, via GitHub`);
      await expect(row.locator('.hof-meta')).toHaveText('Right Now · via GitHub');
      await row.scrollIntoViewIfNeeded();
      // Four columns is the compact row; two is the restacked one.
      const tracks = await row.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      expect(tracks, stacked ? 'restacked' : 'compact').toBe(stacked ? 2 : 4);

      const fields = ['.hof-rank', '.hof-hand', '.hof-who', '.share-fp', '.hof-meta', '.hof-score'];
      const boxes = await Promise.all(fields.map(async (selector) => ({ selector, box: (await row.locator(selector).boundingBox())! })));
      expect(await row.locator('.hof-score').textContent()).toBe(score.toLocaleString('en-US'));
      expect(await row.locator('.share-fp').textContent()).toBe('#6HTG-Z65X');
      const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      // .hof-who contains .share-fp, so that pair is expected to touch; every other pair must be apart.
      const clashes = boxes.flatMap((a, i) => boxes.slice(i + 1)
        .filter((b) => !(a.selector === '.hof-who' && b.selector === '.share-fp') && overlap(a.box, b.box))
        .map((b) => `${a.selector} x ${b.selector}`));
      expect(clashes).toEqual([]);
      const rowBox = (await row.boundingBox())!;
      for (const { selector, box } of boxes) {
        expect(box.x, selector).toBeGreaterThanOrEqual(rowBox.x - 1);
        expect(box.x + box.width, selector).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

      // Leaving mid-check would abort its read of recent pulls (support.ts, expectRankingsChecked).
      await expectRankingsChecked(rankings, 'Rankings loaded.');
      await row.click();
      await expect(page).toHaveURL(/#\/pull\/row-fixture-proof$/);
      expect(errors).toEqual([]);
    });
  });
}

test.describe('How Rankings work at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('opens in place with its text inside the screen, and leaves the notes short', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await relaysAnswerEmpty(page);
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [populated] }));
    await page.goto('./#/rankings');
    await page.evaluate(() => document.fonts.ready);
    const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
    const how = rankings.locator('details.hof-how');
    const summary = how.locator('summary');
    await expect(summary).toHaveText('How Rankings work');
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Closed, the Today note is only the scope and the reset cue; the proof and filing mechanics live inside.
    await expect(rankings.locator('.hof-note')).not.toContainText('re-derived');
    await summary.click();
    await expect(how).toHaveJSProperty('open', true);
    for (const text of await how.locator('.hof-how-body p').all()) {
      const box = (await text.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(how).toContainText('Nothing is filed automatically');
    expect(errors).toEqual([]);
  });
});

test('Rankings says the live feed is down, not that the board is empty, and Retry asks again', async ({ page, baseURL }) => {
  // Every relay socket is closed (monitor), so recent pulls can't be seen. Nothing is sent or fetched.
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: entries }));
  await page.goto('./#/rankings');
  const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
  const panel = rankings.getByRole('tabpanel');
  const status = rankings.getByRole('status');
  await expect(status).toHaveText("Couldn't reach the live feed, so pulls sent recently may be missing. Try again.");
  await expect(status).toBeVisible();
  await expect(panel).toContainText('No filed pulls today that we can see.');
  await expect(panel).not.toContainText('No pulls filed today yet.');
  await expect(panel).not.toContainText('Yours could be first');
  const retry = rankings.getByRole('button', { name: 'Retry loading rankings', exact: true });
  await expect(retry).toBeVisible();
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // The relays come back with nothing stored: now an empty board is a real one.
  await relaysAnswerEmpty(page);
  await retry.click();
  await expect(panel).toContainText('No pulls filed today yet.');
  await expect(retry).toHaveCount(0);
  await expect(status).toHaveText('Rankings loaded.');
  expect(errors).toEqual([]);
});

test('Profile sorts best pulls first and names the filter for Rankings', async ({ page, baseURL }) => {
  // Three synthetic history rows, the same shape the performance runs use; never verified or sent.
  // They're stored newest first with the best in the middle, so Best and Newest differ.
  const errors = await monitor(page, baseURL!, 3, { returning: true });
  await page.addInitScript(({ key }) => {
    if (sessionStorage.getItem('rankings-fixture')) return;
    sessionStorage.setItem('rankings-fixture', '1');
    const row = (n: number, x: number) => ({ s: 'right-now', v: 2, n, k: '8a88e3dd7409f195', c: 'bukangi,niu-laiG,bukangi,la-peace,verity', h: 'Pair', x, t: n + 1 });
    localStorage.setItem(key, JSON.stringify([row(2, 600), row(1, 900), row(0, 300)]));
  }, { key: STORAGE_KEYS.HISTORY });
  await page.goto('./');
  const main = page.getByRole('navigation', { name: 'Main', exact: true });
  await main.getByRole('button', { name: 'Profile', exact: true }).click();
  const myCards = page.getByRole('main', { name: 'Profile', exact: true });

  const tabs = myCards.getByRole('tablist', { name: 'Sort packs', exact: true }).getByRole('tab');
  await expect(tabs).toHaveText(['Best', 'Newest', 'For Rankings · 0']);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  // "Best" is the shortest label: its text alone is about 35px wide, so the tab itself sets the 44px target.
  for (const box of await Promise.all((await tabs.all()).map((tab) => tab.boundingBox()))) {
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  const scores = myCards.locator('.pulls-list .pull-row-score');
  await expect(scores).toHaveText(['900', '600', '300']);
  await tabs.nth(1).click();
  await expect(scores).toHaveText(['600', '900', '300']);
  await tabs.nth(2).click();
  await expect(myCards.locator('.pulls-panel .pulls-note')).toContainText(/qualifies for Rankings\.$/);
  expect(errors).toEqual([]);
});

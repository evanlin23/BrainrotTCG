import { test, expect } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { monitor } from './support';

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
  const scores = myCards.locator('.pulls-list .pull-row-score');
  await expect(scores).toHaveText(['900', '600', '300']);
  await tabs.nth(1).click();
  await expect(scores).toHaveText(['600', '900', '300']);
  await tabs.nth(2).click();
  await expect(myCards.locator('.pulls-panel .pulls-note')).toContainText(/qualifies for Rankings\.$/);
  expect(errors).toEqual([]);
});

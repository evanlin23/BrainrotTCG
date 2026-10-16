import { test, expect } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { monitor } from './support';

// Rankings pages its rows, and Best pulls leads with the best packs. The leaderboard is a synthetic
// list served in place of hall-of-fame.json: its proofs are fake, so each row fails the page's own
// re-check, which changes nothing about paging. Nothing here fetches real data or submits anything.

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
  const errors = await monitor(page, baseURL!);
  await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: entries }));
  await page.goto('./');
  const main = page.getByRole('navigation', { name: 'Main', exact: true });
  await main.getByRole('button', { name: 'Rankings', exact: true }).click();
  const rankings = page.getByRole('dialog', { name: 'Rankings', exact: true });
  const rows = rankings.locator('.hof-list .hof-entry');
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toHaveAttribute('aria-label', /^Number 1: /);

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

test('Best pulls sorts best first and names the filter for Rankings', async ({ page, baseURL }) => {
  // Three synthetic history rows, the same shape the performance runs use; never verified or sent.
  // They're stored newest first with the best in the middle, so Best and Newest differ.
  const errors = await monitor(page, baseURL!, 3);
  await page.addInitScript(({ key }) => {
    if (sessionStorage.getItem('rankings-fixture')) return;
    sessionStorage.setItem('rankings-fixture', '1');
    const row = (n: number, x: number) => ({ s: 'right-now', v: 2, n, k: '8a88e3dd7409f195', c: 'bukangi,niu-laiG,bukangi,la-peace,verity', h: 'Pair', x, t: n + 1 });
    localStorage.setItem(key, JSON.stringify([row(2, 600), row(1, 900), row(0, 300)]));
  }, { key: STORAGE_KEYS.HISTORY });
  await page.goto('./');
  const main = page.getByRole('navigation', { name: 'Main', exact: true });
  await main.getByRole('button', { name: 'My cards', exact: true }).click();
  const myCards = page.getByRole('dialog', { name: 'My cards', exact: true });
  await myCards.getByRole('navigation', { name: 'My cards', exact: true }).getByRole('button', { name: 'Best pulls', exact: true }).click();

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

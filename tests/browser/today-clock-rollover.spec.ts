import { test, expect, type Page } from '@playwright/test';
import { expectDecoded, expectRecordedPack, monitor, relaysAnswerEmpty, snapshot } from './support';

/**
 * Codified live resilience checks for clock rollover at 00:00 UTC (#764).
 * Tests that:
 * 1. The Today board rolls over cleanly at 00:00 UTC without a page reload,
 *    moving yesterday's pull under "Yesterday's best" and showing "No pulls filed today yet".
 * 2. All-time tab preserves earlier pulls across rollover.
 * 3. Opening packs across midnight maintains strict ticket ordering ([0, 1], nextNonce 2)
 *    with no gaps or duplicates.
 * 4. A clock rollback across midnight restores the appropriate board display without
 *    compromising ticket progression.
 */

test.skip(({ isMobile }) => isMobile, 'Clock rollover behavior does not depend on viewport; desktop project runs it.');

const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });

async function packsScreen(page: Page) {
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectDecoded(page.locator('.pack-shell img'), 2);
}

async function openOne(page: Page) {
  await openPack(page).click();
  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
}

const cardCount = (collection: Record<string, { normalCount: number; holoCount: number }> | null) =>
  Object.values(collection ?? {}).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0);

const nextNonce = (page: Page) => page.evaluate(() => {
  try {
    const raw = localStorage.getItem('brainrot-player-v1');
    return raw ? (JSON.parse(raw) as { nextNonce: number }).nextNonce : null;
  } catch {
    return null;
  }
});

const tickets = async (page: Page) => (await snapshot(page)).history.map((record) => record.n).sort();

test.describe('clock crossing 00:00 UTC rollover', () => {
  test('the Today board rolls over at 00:00 UTC without reload, moves pull to Yesterday best, and keeps All-time', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await relaysAnswerEmpty(page);

    const filed = {
      id: 'fixture-today',
      proof: 'fixture-proof-today',
      name: 'Fixture today',
      fingerprint: 'abcd',
      setId: 'right-now',
      setName: 'Right Now',
      hand: 'Full House',
      multiplier: 150,
      score: 50000,
      submittedAt: '2026-10-01T12:00:00.000Z',
      cards: [],
      issue: 1000,
      githubUser: 'fixture',
    };
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [filed] }));
    await page.clock.install({ time: new Date('2026-10-01T23:59:00.000Z') });

    await page.goto('./#/rankings');
    const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
    await expect(rankings.getByRole('status')).toHaveText('Rankings loaded.');

    const rows = rankings.locator('.hof-list .hof-entry');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('href', '#/pull/fixture-proof-today');

    // Cross midnight UTC (run clock forward by 1 hour and 5 minutes)
    await page.clock.runFor('01:05');

    // The Today board rolls over live: Today is now empty, pull is under Yesterday's best
    await expect(rankings.getByRole('tabpanel')).toContainText('No pulls filed today yet.');
    const yesterday = rankings.getByRole('region', { name: "Yesterday's best", exact: true });
    await expect(yesterday.locator('.hof-entry')).toHaveCount(1);
    await expect(yesterday.locator('.hof-entry')).toHaveAttribute('href', '#/pull/fixture-proof-today');

    // All-time tab still displays the pull
    await rankings.getByRole('tab', { name: 'All-time', exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('href', '#/pull/fixture-proof-today');

    expect(errors).toEqual([]);
  });

  test('opening packs across the midnight UTC boundary maintains strict sequential tickets', async ({ page, baseURL }) => {
    // Start at 30 seconds before midnight
    await page.clock.install({ time: new Date('2026-10-01T23:59:30.000Z') });
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await packsScreen(page);

    // Open first pack before midnight
    await openOne(page);
    await expectRecordedPack(page, 0, 1);
    expect(await tickets(page)).toEqual([0]);
    expect(await nextNonce(page)).toBe(1);

    // Click "Next pack" to return to the sealed pack screen
    await page.getByRole('button', { name: 'Next pack', exact: true }).click();
    await packsScreen(page);

    // Advance clock across 00:00 UTC into the next day
    await page.clock.runFor('00:01:00'); // 1 minute forward -> 2026-10-02T00:00:30.000Z

    // Open second pack on the new day
    await openOne(page);

    // Final state assertions: ticket sequence has no gaps or duplicates
    const after = await snapshot(page);
    expect(await tickets(page)).toEqual([0, 1]);
    expect(await nextNonce(page)).toBe(2);
    expect(after.stats.packsOpened).toBe(2);
    expect(cardCount(after.collection)).toBe(10);
    expect(after.history).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  test('Rankings loaded after a clock rollback across midnight UTC displays pulls under Today', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await relaysAnswerEmpty(page);
    const filed = {
      id: 'fixture-today',
      proof: 'fixture-proof-today',
      name: 'Fixture today',
      fingerprint: 'abcd',
      setId: 'right-now',
      setName: 'Right Now',
      hand: 'Full House',
      multiplier: 150,
      score: 50000,
      submittedAt: '2026-10-01T12:00:00.000Z',
      cards: [],
      issue: 1000,
      githubUser: 'fixture',
    };
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [filed] }));

    // Start after midnight: pull is from yesterday
    await page.clock.install({ time: new Date('2026-10-02T00:05:00.000Z') });
    await page.goto('./#/rankings');
    const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
    await expect(rankings.getByRole('status')).toHaveText('Rankings loaded.');
    await expect(rankings.getByRole('tabpanel')).toContainText('No pulls filed today yet.');
    const yesterday = rankings.getByRole('region', { name: "Yesterday's best", exact: true });
    await expect(yesterday.locator('.hof-entry')).toHaveCount(1);

    // Roll clock back across midnight to before the day ended and reload
    await page.clock.setFixedTime(new Date('2026-10-01T23:55:00.000Z'));
    await page.reload();
    await expect(rankings.getByRole('status')).toHaveText('Rankings loaded.');
    const rows = rankings.locator('.hof-list .hof-entry');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('href', '#/pull/fixture-proof-today');
    await expect(rankings.getByRole('region', { name: "Yesterday's best", exact: true })).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});

import { test, expect, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { expectDecoded, monitor, snapshot } from './support';

/**
 * Codified live resilience checks for concurrent multi-tab pack opening (#764).
 * Two pages in one browser context share storage, BroadcastChannel and Web Locks.
 * When two tabs open packs at the same time:
 * - One tab claims the ticket and opens; the other either claims the next ticket sequentially
 *   or hears about the save change, keeps its pack sealed, and refuses honestly.
 * - Under all interleavings, ticket numbers have NO gaps and NO duplicates.
 * - The pending packs shelf is never left with orphaned packs.
 * - Every opened card is preserved in the collection.
 */

test.skip(({ isMobile }) => isMobile, 'Tab races do not depend on the viewport.');

const STALE_ALERT = 'This save changed in another tab';
const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });
const sealed = (page: Page) => page.locator('.pack-refusal-text');

async function openTab(page: Page, baseURL: string) {
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectDecoded(page.locator('.pack-shell img'), 2);
  return errors;
}

async function finishReveal(page: Page) {
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 20000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
}

async function settle(page: Page) {
  await expect(page.locator('.card-reveal-area').or(sealed(page))).toBeVisible({ timeout: 30000 });
  if (await sealed(page).isVisible()) return false;
  await finishReveal(page);
  return true;
}

const shelf = (page: Page) => page.evaluate(([list, prefix]) => [
  ...JSON.parse(localStorage.getItem(list) ?? '[]') as unknown[],
  ...Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
], [STORAGE_KEYS.PENDING_PACKS, STORAGE_KEYS.PENDING_PACK_PREFIX] as const);

const cardCount = (collection: Record<string, { normalCount: number; holoCount: number }> | null) =>
  Object.values(collection ?? {}).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0);

const playerNonce = (page: Page) => page.evaluate(() => {
  try {
    const raw = localStorage.getItem('brainrot-player-v1');
    return raw ? (JSON.parse(raw) as { nextNonce: number }).nextNonce : null;
  } catch {
    return null;
  }
});

test.describe('two tabs opening packs concurrently', () => {
  test('concurrent opens from a fresh profile leave no ticket gaps or duplicates', async ({ context, baseURL }) => {
    test.setTimeout(90000);
    const a = await context.newPage();
    const b = await context.newPage();
    const errorsA = await openTab(a, baseURL!);
    const errorsB = await openTab(b, baseURL!);

    // Both tabs trigger open simultaneously
    await Promise.all([openPack(a).click(), openPack(b).click()]);
    const [openedA, openedB] = await Promise.all([settle(a), settle(b)]);
    const opened = Number(openedA) + Number(openedB);
    expect(opened).toBeGreaterThanOrEqual(1);

    if (opened === 1) {
      const sealedTab = openedA ? b : a;
      await expect(sealed(sealedTab)).toHaveText(/^Your save changed in another tab, so this pack stayed sealed\./);
    }

    // Verify state from tab A
    await a.reload();
    await expect(a.locator('.app-logo')).toBeVisible();
    await expect.poll(async () => (await snapshot(a)).stats?.packsOpened, { timeout: 15000 }).toBe(opened);

    const savedA = await snapshot(a);
    const nonces = savedA.history.map((record) => record.n).sort();

    // Strict no-gap, no-duplicate assertions
    expect(nonces).toEqual(Array.from({ length: opened }, (_, i) => i));
    expect(new Set(nonces).size).toBe(opened);
    expect(cardCount(savedA.collection)).toBe(5 * opened);
    expect(await playerNonce(a)).toBe(opened);
    expect(await shelf(a)).toEqual([]);

    if (opened === 1) {
      // Stale tab reloads and opens: takes the next ticket sequentially
      await b.reload();
      await expect(b.locator('.app-logo')).toBeVisible();
      await expect(b.getByRole('alert').filter({ hasText: STALE_ALERT })).toHaveCount(0);
      await expectDecoded(b.locator('.pack-shell img'), 2);

      await openPack(b).click();
      await finishReveal(b);

      const savedB = await snapshot(b);
      const allNonces = savedB.history.map((record) => record.n).sort();
      expect(allNonces).toEqual([0, 1]);
      expect(new Set(allNonces).size).toBe(2);
      expect(await playerNonce(b)).toBe(2);
      expect(savedB.stats.packsOpened).toBe(2);
      expect(cardCount(savedB.collection)).toBe(10);
      expect(await shelf(b)).toEqual([]);
    }

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
    await a.close();
    await b.close();
  });

  test('concurrent opens when one ticket already exists continue strictly without gaps or duplicates', async ({ context, baseURL }) => {
    test.setTimeout(90000);
    const a = await context.newPage();
    const b = await context.newPage();
    const errorsA = await openTab(a, baseURL!);
    const errorsB = await openTab(b, baseURL!);

    // Tab A opens ticket 0 first
    await openPack(a).click();
    await finishReveal(a);
    await expect.poll(async () => (await snapshot(a)).stats?.packsOpened).toBe(1);

    // Tab B hears the write and warns about stale save
    await b.bringToFront();
    const warning = b.getByRole('alert').filter({ hasText: STALE_ALERT });
    await expect(warning).toBeVisible();

    // Reload Tab B so both tabs are current with 1 opened pack (ticket 0)
    await warning.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(b.locator('.app-logo')).toBeVisible();
    await expectDecoded(b.locator('.pack-shell img'), 2);

    // Tab A returns to the sealed pack screen ready for the next pack
    await a.bringToFront();
    await a.getByRole('button', { name: 'Next pack', exact: true }).click();
    await expect(a.locator('.app-logo')).toBeVisible();
    await expectDecoded(a.locator('.pack-shell img'), 2);

    // Now both tabs race to open ticket 1
    await Promise.all([openPack(a).click(), openPack(b).click()]);
    const [openedA, openedB] = await Promise.all([settle(a), settle(b)]);
    const newlyOpened = Number(openedA) + Number(openedB);
    expect(newlyOpened).toBeGreaterThanOrEqual(1);

    const totalOpened = 1 + newlyOpened;

    // Reload tab A and inspect final ticket sequence
    await a.reload();
    await expect(a.locator('.app-logo')).toBeVisible();
    await expect.poll(async () => (await snapshot(a)).stats?.packsOpened, { timeout: 15000 }).toBe(totalOpened);

    const finalSave = await snapshot(a);
    const finalNonces = finalSave.history.map((record) => record.n).sort();

    // Strict assertions: sequential sequence starting at 0 with no gaps or duplicates
    expect(finalNonces).toEqual(Array.from({ length: totalOpened }, (_, i) => i));
    expect(new Set(finalNonces).size).toBe(totalOpened);
    expect(cardCount(finalSave.collection)).toBe(5 * totalOpened);
    expect(await playerNonce(a)).toBe(totalOpened);
    expect(await shelf(a)).toEqual([]);

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
    await a.close();
    await b.close();
  });
});

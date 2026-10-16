import { test, expect, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { monitor, snapshot } from './support';

// Two pages in one browser context share an origin, localStorage, IndexedDB and Web Locks, as two
// tabs do. This is emulated Chromium evidence for #87, not a test on real devices or browsers.
test.describe('two tabs, emulated Chromium (not real devices)', () => {
  test.skip(({ isMobile }) => isMobile, 'Tab races do not depend on the viewport.');

  async function openTab(page: Page, baseURL: string) {
    const errors = await monitor(page, baseURL);
    await page.goto('./');
    await expect(page.locator('.pack-shell')).toBeVisible();
    return errors;
  }

  async function finishReveal(page: Page) {
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 20000 });
    await page.locator('button.reveal-skip').click({ timeout: 15000 });
    await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
  }

  const openButton = (page: Page) => page.getByRole('button', { name: 'Open pack', exact: true });

  test('concurrent opens claim different tickets and both packs are kept', async ({ context, baseURL }) => {
    test.setTimeout(90000);
    const a = await context.newPage();
    const b = await context.newPage();
    const errorsA = await openTab(a, baseURL!);
    const errorsB = await openTab(b, baseURL!);

    await Promise.all([openButton(a).click(), openButton(b).click()]);
    // Each tab either opens its pack or, having heard the other store progress first, refuses and
    // leaves its pack sealed (App's stale-save rule). The first to store always opens.
    const sealed = (page: Page) => page.getByText('so this pack stayed sealed', { exact: false }).first();
    const settle = async (page: Page) => {
      await expect(page.locator('.card-reveal-area').or(sealed(page))).toBeVisible({ timeout: 20000 });
      if (await sealed(page).isVisible()) return false;
      await finishReveal(page);
      return true;
    };
    const opened = (await Promise.all([settle(a), settle(b)])).filter(Boolean).length;
    expect(opened).toBeGreaterThanOrEqual(1);
    // At most one tab is told its save went stale.
    const warnings = (await a.locator('.save-warning').count()) + (await b.locator('.save-warning').count());
    expect(warnings).toBeLessThanOrEqual(1);

    // After a reload nothing opened is lost: one ticket per pack, every pack counted, all its cards.
    await a.reload();
    await expect(a.locator('.app-logo')).toBeVisible();
    await expect.poll(async () => (await snapshot(a)).stats.packsOpened, { timeout: 15000 }).toBe(opened);
    const saved = await snapshot(a);
    const packs = saved.history.filter((entry) => entry.c);
    expect(packs.map((entry) => entry.n).sort()).toEqual(opened === 2 ? [0, 1] : [packs[0].n]);
    expect(new Set(saved.history.map((entry) => entry.n)).size).toBe(saved.history.length);
    expect(Object.values(saved.collection).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0)).toBe(5 * opened);
    const player = await a.evaluate(() => JSON.parse(localStorage.getItem('brainrot-player-v1')!));
    expect(player.nextNonce).toBeGreaterThanOrEqual(opened);
    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
  });

  test('a profile switch in one tab stops the other from recording into the new player', async ({ context, baseURL }) => {
    test.setTimeout(90000);
    const a = await context.newPage();
    const b = await context.newPage();
    const errorsA = await openTab(a, baseURL!);
    const errorsB = await openTab(b, baseURL!);

    await openButton(b).click();
    // Tab A switches to another player while B mines or reveals, as a save import does: the new
    // identity, a fresh import stamp and the incoming player's (empty) progress.
    await a.evaluate((keys) => {
      for (const key of [keys.STATS, keys.COLLECTION, keys.HISTORY]) localStorage.removeItem(key);
      localStorage.setItem('brainrot-player-v1', JSON.stringify({
        secretKey: '02'.repeat(32), name: 'Second player', nextNonce: 0, createdAt: 2,
      }));
      localStorage.setItem('brainrot-save-stamp-v1', `switch-${Date.now()}`);
    }, STORAGE_KEYS);

    await expect(b.getByText("This save changed in another tab", { exact: false })).toBeVisible({ timeout: 30000 });
    await expect(b.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
    // Give any late write from B time to land before checking nothing crossed over.
    await b.waitForTimeout(3000);

    const saved = await snapshot(a);
    const player = await a.evaluate(() => JSON.parse(localStorage.getItem('brainrot-player-v1')!));
    expect(player.secretKey).toBe('02'.repeat(32));
    // The first player's pack must not appear in the second player's progress.
    for (const entry of saved.history ?? []) expect(entry.k).not.toBe('8a88e3dd7409f195');
    expect(saved.stats?.packsOpened ?? 0).toBe(0);
    expect(saved.collection ?? {}).toEqual({});
    expect(player.nextNonce).toBe(0);
    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
  });

  test('a storage quota error in one tab warns there and the pack is recovered', async ({ context, baseURL }) => {
    test.setTimeout(90000);
    const a = await context.newPage();
    const b = await context.newPage();
    const errorsA = await openTab(a, baseURL!);
    const errorsB = await openTab(b, baseURL!);

    // Progress writes in tab A fail as if storage were full.
    await a.evaluate((keys) => {
      const blocked = new Set<string>([keys.STATS, keys.COLLECTION, keys.HISTORY]);
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (blocked.has(key)) throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    }, STORAGE_KEYS);

    await openButton(a).click();
    await finishReveal(a);
    await expect(a.locator('.save-warning')).toContainText("Some changes couldn't be saved");
    await expect(a.locator('.summary-cards img')).toHaveCount(5);

    // Tab A's pack still claimed its ticket, so tab B (reloaded onto whatever A did store) claims
    // the next one rather than reusing A's.
    await b.reload();
    await expect(b.locator('.pack-shell')).toBeVisible();
    await openButton(b).click();
    await finishReveal(b);
    await expect(b.locator('.save-warning')).toHaveCount(0);
    const player = await b.evaluate(() => JSON.parse(localStorage.getItem('brainrot-player-v1')!));
    expect(player.nextNonce).toBe(2);

    // Reloading A (its storage works again) brings back the pack it couldn't save.
    await a.reload();
    await expect(a.locator('.app-logo')).toBeVisible();
    await expect.poll(async () => (await snapshot(a)).stats.packsOpened, { timeout: 15000 }).toBe(2);
    const saved = await snapshot(a);
    expect(saved.history.map((entry) => entry.n).sort()).toEqual([0, 1]);
    expect(Object.values(saved.collection).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0)).toBe(10);
    expect(errorsA.filter((error) => !/QuotaExceeded|Storage is full|Could not save pack history/.test(error))).toEqual([]);
    expect(errorsB).toEqual([]);
  });
});

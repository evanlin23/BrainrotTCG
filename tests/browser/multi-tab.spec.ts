import { test, expect, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { fromHex, publicKeyFromSecret, pullId } from '../../src/engine';
import { expectDecoded, expectRecordedPack, monitor, snapshot } from './support';

// Two tabs of one player (#73). The tab that opens a pack stores it; the other tab hears about it,
// says its save changed, keeps its pack sealed and writes nothing, until a reload brings it current.

const STALE = 'This save changed in another tab';
const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });

async function packsScreen(page: Page) {
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectDecoded(page.locator('.pack-shell img'), 2);
}

test('a second tab of the same player stops opening packs once the first stores one', async ({ context, page, baseURL }) => {
  test.setTimeout(90000);
  const errors = await monitor(page, baseURL!);
  await packsScreen(page);
  const other = await context.newPage();
  const otherErrors = await monitor(other, baseURL!);
  await packsScreen(other);
  await expect(other.getByRole('alert')).toHaveCount(0);

  // The first tab opens and stores its pack.
  await page.bringToFront();
  await openPack(page).click();
  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectRecordedPack(page);
  const stored = await snapshot(page);

  // The other tab heard the write and says why it can't go on.
  await other.bringToFront();
  const warning = other.getByRole('alert').filter({ hasText: STALE });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  // Its pack stays sealed and says so, and nothing it holds overwrites the first tab's save.
  await openPack(other).click();
  await expect(other.locator('.pack-refusal-text')).toHaveText(/^Your save changed in another tab, so this pack stayed sealed\./);
  await expect(other.locator('.card-reveal-area')).toHaveCount(0);
  await other.waitForTimeout(500);
  expect(await snapshot(other)).toEqual(stored);

  // A reload brings it current: no warning, the stored pack counted once, and the next ticket opens.
  await warning.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(other.locator('.app-logo')).toBeVisible();
  await expect(other.getByRole('alert').filter({ hasText: STALE })).toHaveCount(0);
  await expectDecoded(other.locator('.pack-shell img'), 2);
  await openPack(other).click();
  await other.locator('button.reveal-skip').click();
  await expect(other.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expect.poll(async () => (await snapshot(other)).history?.map((record) => record.n).sort()).toEqual([0, 1]);
  expect((await snapshot(other)).stats.packsOpened).toBe(2);
  expect(errors).toEqual([]);
  expect(otherErrors).toEqual([]);
});

// Two pages in one browser context share an origin, localStorage, IndexedDB and Web Locks, as two
// tabs do. This is emulated Chromium evidence for #87, not a test on real devices or browsers.
test.describe('two tabs at once, emulated Chromium (not real devices)', () => {
  test.skip(({ isMobile }) => isMobile, 'Tab races do not depend on the viewport.');

  const FIRST_PLAYER = '8a88e3dd7409f195';
  const sealed = (page: Page) => page.locator('.pack-refusal-text');
  const player = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('brainrot-player-v1')!) as { secretKey: string; nextNonce: number });
  // The pending shelf: earlier builds' list and this build's entry per pack.
  const shelf = (page: Page) => page.evaluate(([list, prefix]) => [
    ...JSON.parse(localStorage.getItem(list) ?? '[]') as unknown[],
    ...Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
  ], [STORAGE_KEYS.PENDING_PACKS, STORAGE_KEYS.PENDING_PACK_PREFIX] as const);
  const cardCount = (collection: Record<string, { normalCount: number; holoCount: number }> | null) =>
    Object.values(collection ?? {}).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0);
  const packNonces = async (page: Page) => ((await snapshot(page)).history ?? []).filter((entry) => entry.c).map((entry) => entry.n).sort();

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

  /** Waits for the tab's open to end: true once it revealed and summed up a pack, false if the pack stayed sealed. */
  async function settle(page: Page) {
    await expect(page.locator('.card-reveal-area').or(sealed(page))).toBeVisible({ timeout: 30000 });
    if (await sealed(page).isVisible()) return false;
    await finishReveal(page);
    return true;
  }

  test('concurrent opens claim different tickets and both packs are kept', async ({ context, baseURL }) => {
    test.setTimeout(90000);
    const a = await context.newPage();
    const b = await context.newPage();
    const errorsA = await openTab(a, baseURL!);
    const errorsB = await openTab(b, baseURL!);

    await Promise.all([openPack(a).click(), openPack(b).click()]);
    // Each tab either opens its pack or, having heard the other store progress first, refuses and
    // leaves its pack sealed without claiming a ticket. The first to store always opens.
    const [openedA, openedB] = await Promise.all([settle(a), settle(b)]);
    const opened = Number(openedA) + Number(openedB);
    expect(opened).toBeGreaterThanOrEqual(1);
    if (opened === 1) await expect(sealed(openedA ? b : a)).toHaveText(/^Your save changed in another tab, so this pack stayed sealed\./);

    // After a reload nothing opened is lost: one ticket per pack, every pack counted, all its cards,
    // and nothing left on the pending shelf.
    await a.reload();
    await expect(a.locator('.app-logo')).toBeVisible();
    await expect.poll(async () => (await snapshot(a)).stats?.packsOpened, { timeout: 15000 }).toBe(opened);
    const saved = await snapshot(a);
    expect(await packNonces(a)).toEqual(opened === 2 ? [0, 1] : [0]);
    expect(new Set(saved.history.map((entry) => entry.n)).size).toBe(saved.history.length);
    expect(cardCount(saved.collection)).toBe(5 * opened);
    expect((await player(a)).nextNonce).toBe(opened);
    expect(await shelf(a)).toEqual([]);

    if (opened === 1) {
      // The sealed tab claimed nothing, so the next open takes ticket 1, the one it left.
      await b.reload();
      await expect(b.locator('.pack-shell')).toBeVisible();
      await openPack(b).click();
      await finishReveal(b);
      await expect.poll(() => packNonces(b)).toEqual([0, 1]);
      expect((await player(b)).nextNonce).toBe(2);
      expect((await snapshot(b)).stats.packsOpened).toBe(2);
      expect(cardCount((await snapshot(b)).collection)).toBe(10);
    }
    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
  });

  test('a profile switch in one tab stops the other from recording into the new player', async ({ context, baseURL }) => {
    test.setTimeout(90000);
    const a = await context.newPage();
    const b = await context.newPage();
    const errorsA = await openTab(a, baseURL!);
    const errorsB = await openTab(b, baseURL!);

    await openPack(b).click();
    // Tab A switches to another player while B mines or reveals, as a save import does: the new
    // identity, a fresh import stamp and the incoming player's (empty) progress.
    await a.evaluate((keys) => {
      for (const key of [keys.STATS, keys.COLLECTION, keys.HISTORY]) localStorage.removeItem(key);
      localStorage.setItem('brainrot-player-v1', JSON.stringify({
        secretKey: '02'.repeat(32), name: 'Second player', nextNonce: 0, createdAt: 2,
      }));
      localStorage.setItem('brainrot-save-stamp-v1', `switch-${Date.now()}`);
    }, STORAGE_KEYS);

    await expect(b.getByText(STALE, { exact: false })).toBeVisible({ timeout: 30000 });
    await expect(b.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
    // B's open runs to its end (a sealed pack, or a revealed one whose writes the switch refuses)
    // before anything is checked, so a late write from it would already have landed.
    await settle(b);

    const saved = await snapshot(a);
    const switched = await player(a);
    expect(switched.secretKey).toBe('02'.repeat(32));
    // The first player's pack must not appear in the second player's progress.
    expect((saved.history ?? []).filter((entry) => entry.k === FIRST_PLAYER)).toEqual([]);
    expect(saved.stats?.packsOpened ?? 0).toBe(0);
    expect(saved.collection ?? {}).toEqual({});
    expect(switched.nextNonce).toBe(0);
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

    await openPack(a).click();
    await finishReveal(a);
    await expect(a.locator('.save-warning')).toContainText("Some changes couldn't be saved");
    await expect(a.locator('.summary-cards img')).toHaveCount(5);

    // Tab A's pack still claimed its ticket, so tab B (reloaded onto whatever A did store) claims
    // the next one rather than reusing A's.
    await b.reload();
    await expect(b.locator('.pack-shell')).toBeVisible();
    await openPack(b).click();
    await finishReveal(b);
    // B opened and stored its pack before its lack of a warning means anything.
    await expect(b.locator('.summary-card')).toHaveCount(5);
    await expect.poll(() => packNonces(b)).toContain(1);
    await expect(b.locator('.save-warning')).toHaveCount(0);
    expect((await player(b)).nextNonce).toBe(2);

    // Reloading A (its storage works again) brings back the pack it couldn't save.
    await a.reload();
    await expect(a.locator('.app-logo')).toBeVisible();
    await expect.poll(async () => (await snapshot(a)).stats.packsOpened, { timeout: 15000 }).toBe(2);
    const saved = await snapshot(a);
    expect(saved.history.map((entry) => entry.n).sort()).toEqual([0, 1]);
    expect(cardCount(saved.collection)).toBe(10);
    expect(await shelf(a)).toEqual([]);
    expect(errorsA.filter((error) => !/QuotaExceeded|Storage is full|Could not save pack history/.test(error))).toEqual([]);
    expect(errorsB).toEqual([]);
  });

  test('a Hall of Fame submission in one tab updates the other tab\'s Profile badge without a reload', async ({ context, baseURL }) => {
    test.setTimeout(60000);
    // A synthetic Full House for the fixture player (secret 01 x32) at a ticket it never opened. It is
    // shown from history only: nothing is submitted. monitor() answers every non-local request with an
    // empty 204 and closes every relay WebSocket, so no Hall of Fame note or issue can leave the browser.
    const id = pullId({ setId: 'right-now', setVersion: 2, publicKey: publicKeyFromSecret(fromHex('01'.repeat(32))), nonce: 0 });
    const a = await context.newPage();
    const b = await context.newPage();
    const errorsA = await monitor(a, baseURL!, 1, { returning: true });
    const errorsB = await monitor(b, baseURL!, 1, { returning: true });
    for (const page of [a, b]) {
      await page.addInitScript((key) => {
        // Once per tab, so a reload does not undo what the other tab stored.
        if (sessionStorage.getItem('full-house-seeded')) return;
        sessionStorage.setItem('full-house-seeded', '1');
        localStorage.setItem(key, JSON.stringify([{
          s: 'right-now', v: 2, n: 0, k: '8a88e3dd7409f195', c: 'bukangi,bukangi,bukangi,la-peace,la-peace', h: 'Full House', x: 0, t: 1,
        }]));
      }, STORAGE_KEYS.HISTORY);
    }

    const badge = async (page: Page) => {
      await page.goto('./#/profile');
      const row = page.getByRole('main', { name: 'Profile', exact: true }).locator('.pulls-history .pull-row').first();
      await expect(row).toBeVisible();
      // A marker that a reload would clear: the badge must change in this same document.
      await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });
      return row.locator('.pull-row-sent');
    };
    const badgeA = await badge(a);
    const badgeB = await badge(b);
    await expect(badgeA).toHaveText('Not submitted');
    await expect(badgeB).toHaveText('Not submitted');

    // Tab A records the submission exactly as share.ts does after a relay accepts it; the browser then
    // sends a real storage event to tab B (the writing tab gets none).
    await a.evaluate(([key, pull]) => {
      localStorage.setItem(key, JSON.stringify([pull]));
    }, ['brainrot-hof-submitted-v1', id] as const);

    await expect(badgeB).toHaveText('Submitted', { timeout: 10000 });
    await expect(badgeB).toHaveAttribute('title', 'Sent from this device');
    expect(await b.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
  });
});

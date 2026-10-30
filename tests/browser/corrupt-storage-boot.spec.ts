import { test, expect, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { REFUSAL_COPY } from '../../src/components/pack/refusal';
import {
  expectDecoded,
  expectRecordedPack,
  monitor,
  snapshot,
} from './support';

/**
 * Codified live resilience checks for corrupt storage boots (#764).
 * For each persisted key and combinations of keys: write garbage bytes, valid JSON with
 * wrong shape, truncated JSON, or absurd values; reload; and assert that the app boots
 * to an honest state (recovered or fresh with disclosure — never a crash or a blank screen).
 * Asserts final state (ticket sequence has no gaps or duplicates).
 */

test.skip(({ isMobile }) => isMobile, 'Storage corruption recovery behaves identically across viewports; desktop project runs it.');

const GARBAGE = '{"broken":\ufffd\ufffd\ufffd\ufffd\x00\x01\x02\x03';
const WRONG_SHAPE = '{"invalid":true,"nested":[1,2,3]}';
const ABSURD_ARRAY = '[1,2,3,4,5]';
const TRUNCATED = '{"secretKey":"010101010101';
const SEEDED = 'test-corrupt-storage-boot-seeded';
const PLAYER_KEY = 'brainrot-player-v1';
const DATA_VERSION_KEY = 'brainrot-data-version';

const COLLECTION_NOTE = /^Unreadable collection data was kept aside in this browser\./;
const STATS_NOTE = /^Unreadable stats data was kept aside in this browser\..* Your stats were rebuilt from your pack history and collection\./;
const PLAYER_REPAIRED = /^Unreadable player data was kept aside in this browser\..* Your player key was kept, and its ticket count was repaired\./;

const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });

async function assertHealthyBoot(page: Page) {
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(page.locator('.app-crash')).toHaveCount(0);
  await expect(page.locator('.pack-shell')).toBeVisible();
  await expectDecoded(page.locator('.pack-shell img'), 2);
}

async function openOne(page: Page) {
  await openPack(page).click();
  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
}

const raw = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

const nextNonce = (page: Page) => page.evaluate(() => {
  try {
    const rawVal = localStorage.getItem('brainrot-player-v1');
    return rawVal ? (JSON.parse(rawVal) as { nextNonce: number }).nextNonce : null;
  } catch {
    return null;
  }
});

const tickets = async (page: Page) => (await snapshot(page)).history.map((record) => record.n).sort();

const cardCount = (collection: Record<string, { normalCount: number; holoCount: number }> | null) =>
  Object.values(collection ?? {}).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0);

/** A realistic baseline save of one opened pack (ticket 0). */
let saved: Record<string, string>;

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.use.isMobile) return;
  const baseURL = testInfo.project.use.baseURL!;
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await assertHealthyBoot(page);
  await openOne(page);
  await expectRecordedPack(page);
  saved = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!])));
  expect(errors).toEqual([]);
  await context.close();
});

async function seedCorruptSave(page: Page, baseURL: string, changes: Record<string, string | null>) {
  await page.addInitScript(({ save, mark }) => {
    if (localStorage.getItem(mark)) return;
    for (const [key, value] of Object.entries(save)) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    localStorage.setItem(mark, 'yes');
  }, { save: { ...saved, ...changes }, mark: SEEDED });
  return monitor(page, baseURL);
}

test.describe('corrupt storage boots to an honest state', () => {
  test('unreadable player record boots honestly, discloses refusal on open, and links to Settings without crashing', async ({ page, baseURL }) => {
    const errors = await seedCorruptSave(page, baseURL!, { [PLAYER_KEY]: GARBAGE });
    await page.goto('./');
    await assertHealthyBoot(page);

    await openPack(page).click();
    const refusal = page.locator('.pack-refusal-text');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText(REFUSAL_COPY.unreadable.message);

    const backupButton = page.getByRole('button', { name: REFUSAL_COPY.unreadable.action });
    await expect(backupButton).toBeVisible();
    await backupButton.click();

    await expect(page).toHaveURL(/.*#\/settings$/);
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.locator('.app-crash')).toHaveCount(0);
    expect(await raw(page, PLAYER_KEY)).toBe(GARBAGE);
    expect(errors).toEqual([
      expect.stringMatching(/^Could not open pack PlayerUnreadableError: /),
    ]);
  });

  test('player record with valid key but damaged nextNonce boots honestly, discloses repair, and continues sequential tickets', async ({ page, baseURL }) => {
    const playerWithDamagedNonce = JSON.stringify({
      ...(JSON.parse(saved[PLAYER_KEY]) as object),
      nextNonce: 'corrupted_string',
    });
    const errors = await seedCorruptSave(page, baseURL!, { [PLAYER_KEY]: playerWithDamagedNonce });
    await page.goto('./');
    await assertHealthyBoot(page);

    await expect(page.getByRole('alert').filter({ hasText: PLAYER_REPAIRED })).toBeVisible();
    await openOne(page);

    expect(await tickets(page)).toEqual([0, 1]);
    expect(await nextNonce(page)).toBe(2);
    expect(cardCount((await snapshot(page)).collection)).toBe(10);
    expect(errors).toEqual([]);
  });

  test('unreadable collection boots honestly, discloses kept-aside alert upon opening pack, and records new pack', async ({ page, baseURL }) => {
    const errors = await seedCorruptSave(page, baseURL!, { [STORAGE_KEYS.COLLECTION]: GARBAGE });
    await page.goto('./');
    await assertHealthyBoot(page);

    await openOne(page);
    await expect(page.getByRole('alert').filter({ hasText: COLLECTION_NOTE })).toBeVisible();

    const after = await snapshot(page);
    expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
    expect(cardCount(after.collection)).toBe(5);
    expect(after.stats.packsOpened).toBe(2);
    expect(await nextNonce(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('unreadable stats boots honestly, discloses rebuilding alert, and increments pack counts', async ({ page, baseURL }) => {
    const errors = await seedCorruptSave(page, baseURL!, { [STORAGE_KEYS.STATS]: GARBAGE });
    await page.goto('./');
    await assertHealthyBoot(page);

    await expect(page.getByRole('alert').filter({ hasText: STATS_NOTE })).toBeVisible();
    await openOne(page);

    const after = await snapshot(page);
    expect(after.stats.packsOpened).toBe(2);
    expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
    expect(cardCount(after.collection)).toBe(10);
    expect(await nextNonce(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('absurdly large pack count in stats boots honestly, never blank, and continues counting', async ({ page, baseURL }) => {
    const absurdStats = JSON.stringify({
      ...(JSON.parse(saved[STORAGE_KEYS.STATS]) as object),
      packsOpened: 999_999_999,
    });
    const errors = await seedCorruptSave(page, baseURL!, { [STORAGE_KEYS.STATS]: absurdStats });
    await page.goto('./');
    await assertHealthyBoot(page);

    await openOne(page);
    const after = await snapshot(page);
    expect(after.stats.packsOpened).toBe(1_000_000_000);
    expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
    expect(cardCount(after.collection)).toBe(10);
    expect(await nextNonce(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('ticket counter set below zero boots honestly and advances past existing history tickets', async ({ page, baseURL }) => {
    const negativeNoncePlayer = JSON.stringify({
      ...(JSON.parse(saved[PLAYER_KEY]) as object),
      nextNonce: -50,
    });
    const errors = await seedCorruptSave(page, baseURL!, { [PLAYER_KEY]: negativeNoncePlayer });
    await page.goto('./');
    await assertHealthyBoot(page);

    await openOne(page);
    expect(await tickets(page)).toEqual([0, 1]);
    expect(await nextNonce(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('wrong-shape or garbage secondary storage keys boot honestly and record pack in full', async ({ page, baseURL }) => {
    const secondaryCorruptions: Record<string, string> = {
      [STORAGE_KEYS.SETTINGS]: WRONG_SHAPE,
      [STORAGE_KEYS.ACHIEVEMENTS]: ABSURD_ARRAY,
      [STORAGE_KEYS.BEST_CARDS]: GARBAGE,
      [STORAGE_KEYS.STORED_PACKS]: WRONG_SHAPE,
      [STORAGE_KEYS.HALL_OF_FAME]: GARBAGE,
      [STORAGE_KEYS.SELECTED_SET]: '{"not":"a-string"}',
      [STORAGE_KEYS.PENDING_PACKS]: WRONG_SHAPE,
      [STORAGE_KEYS.PENDING_PACK]: GARBAGE,
      [DATA_VERSION_KEY]: '999999',
    };
    const errors = await seedCorruptSave(page, baseURL!, secondaryCorruptions);
    await page.goto('./');
    await assertHealthyBoot(page);

    await openOne(page);
    const after = await snapshot(page);
    expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
    expect(cardCount(after.collection)).toBe(10);
    expect(after.stats.packsOpened).toBe(2);
    expect(await nextNonce(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('truncated JSON across multiple storage keys boots honestly without blank screen', async ({ page, baseURL }) => {
    const truncatedStorage = {
      [STORAGE_KEYS.SETTINGS]: TRUNCATED,
      [STORAGE_KEYS.STATS]: '{"packsOpened":',
      [STORAGE_KEYS.ACHIEVEMENTS]: '{"first_pack":',
    };
    const errors = await seedCorruptSave(page, baseURL!, truncatedStorage);
    await page.goto('./');
    await assertHealthyBoot(page);

    await openOne(page);
    const after = await snapshot(page);
    expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
    expect(cardCount(after.collection)).toBe(10);
    expect(await nextNonce(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('every single storage key corrupted at once boots to an honest screen, never blank', async ({ page, baseURL }) => {
    const allCorrupt: Record<string, string> = {
      [PLAYER_KEY]: GARBAGE,
      [STORAGE_KEYS.COLLECTION]: GARBAGE,
      [STORAGE_KEYS.HISTORY]: GARBAGE,
      [STORAGE_KEYS.STATS]: GARBAGE,
      [STORAGE_KEYS.SETTINGS]: GARBAGE,
      [STORAGE_KEYS.ACHIEVEMENTS]: GARBAGE,
      [STORAGE_KEYS.BEST_CARDS]: GARBAGE,
      [STORAGE_KEYS.HALL_OF_FAME]: GARBAGE,
      [STORAGE_KEYS.SELECTED_SET]: GARBAGE,
      [STORAGE_KEYS.STORED_PACKS]: GARBAGE,
      [STORAGE_KEYS.PENDING_PACKS]: GARBAGE,
      [STORAGE_KEYS.PENDING_PACK]: GARBAGE,
      [DATA_VERSION_KEY]: GARBAGE,
    };
    const errors = await seedCorruptSave(page, baseURL!, allCorrupt);
    await page.goto('./');
    await assertHealthyBoot(page);

    // Attempting to open refuses honestly because player record is unreadable
    await openPack(page).click();
    await expect(page.locator('.pack-refusal-text')).toContainText(REFUSAL_COPY.unreadable.message);
    await expect(page.locator('.app-crash')).toHaveCount(0);
    expect(errors).toEqual([
      expect.stringMatching(/^Could not open pack PlayerUnreadableError: /),
    ]);
  });
});

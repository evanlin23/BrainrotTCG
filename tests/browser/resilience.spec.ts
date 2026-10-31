import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { STORAGE_KEYS } from '../../src/constants/config';
import {
  FEED_DOWN, expectDecoded, expectRecordedPack, holdTickets, monitor, pickWithImport, relaysAnswerEmpty, releaseTickets, sameStorage,
  settingsOf, snapshot, storageOf,
} from './support';

/**
 * The live resilience checks of #764, kept as specs: damaged storage, damaged backup files, going
 * offline mid-session, and the Today board crossing 00:00 UTC. Each starts from a real save
 * (monitor()'s fixture player opens ticket 0 here), damages one thing, and checks what the player is
 * told and what storage holds afterwards: nothing readable is lost, nothing invalid is written, and
 * the ticket count never goes back.
 *
 * Elsewhere: the export, wipe and import round trip and a cut-short or tampered-collection file
 * (backup-round-trip.spec.ts, #1020), two tabs racing (multi-tab.spec.ts), Rankings' chunk offline
 * (deferred-styles.spec.ts) and art offline (card-image-*.spec.ts).
 */

// Backup files hold the player's secret key: keep them out of traces and videos.
test.use({ trace: 'off', video: 'off' });

const GARBAGE = '\u0000ÿ{not json';
const COLLECTION_NOTE = /^Unreadable collection data was kept aside in this browser\./;
const SAVE_WARNING = "Some changes couldn't be saved in this browser and may be lost when you close or reload. Backups only include data already saved.";
const STATS_NOTE = /^Unreadable stats data was kept aside in this browser\..* Your stats were rebuilt from your pack history and collection\./;
const PLAYER_REPAIRED = /^Unreadable player data was kept aside in this browser\..* Your player key was kept, and its ticket count was repaired\./;
const PLAYER_PAUSED = /^Unreadable player data was kept aside in this browser\..* Packs are paused until you restore a backup or start a new player in Settings > Save & backup\./;
const PLAYER_SEALED = "Your player record in this browser is damaged and can't be read, so this pack stayed sealed. Nothing was lost."
  + ' In Save & backup you can restore a backup, download the save with the damaged record, or start a new player.';

/** Marks a browser whose save was seeded, so a reload keeps what storage holds by then. */
const SEEDED = 'test-resilience-seeded';
const PLAYER_KEY = 'brainrot-player-v1';

const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main', exact: true });

async function packsScreen(page: Page) {
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectDecoded(page.locator('.pack-shell img'), 2);
}

const packToastsReady = (page: Page) => expect(page.locator('.app')).toHaveAttribute('data-toasts-ready', 'true');

/** Delay a real toast dependency past the other warmups, without depending on their network order. */
async function holdToastStyles(page: Page) {
  let release = () => {};
  let requested = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route(/\/AchievementToasts-[^/]+\.css$/, async (route) => {
    requested();
    await held;
    await route.fallback();
  });
  return async () => {
    await started;
    // A JS response alone isn't readiness: Vite still has to load its dependent stylesheet.
    await expect(page.locator('.app')).not.toHaveAttribute('data-toasts-ready', 'true');
    release();
    await packToastsReady(page);
  };
}

async function openOne(page: Page) {
  await openPack(page).click();
  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
}

const raw = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const nextNonce = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem('brainrot-player-v1')!) as { nextNonce: number }).nextNonce);
const tickets = async (page: Page) => (await snapshot(page)).history.map((record) => record.n).sort();
const cardCount = (collection: Record<string, { normalCount: number; holoCount: number }> | null) =>
  Object.values(collection ?? {}).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0);
/**
 * Stats as they score: the best pack's cards by key and finish (rebuilt stats rebuild their display
 * fields from the card registry), without the legacy pack value that only older saves need.
 */
const scored = (stats: Awaited<ReturnType<typeof snapshot>>['stats'] & { highestPackValue?: number }) => {
  const rest: Partial<typeof stats> = { ...stats };
  delete rest.highestPackValue;
  return { ...rest, highestPackCards: stats.highestPackCards?.map((card) => ({ key: card.key, finish: card.finish ?? null, isHolo: card.isHolo })) };
};
/** What the kept-aside archive holds: each payload's storage key (none for the collection) and its exact bytes. */
const keptAside = async (page: Page) => {
  const archive = JSON.parse((await raw(page, STORAGE_KEYS.COLLECTION_RECOVERY))!) as { raw: string; key?: string; later?: { raw: string; key?: string }[] };
  return [archive, ...(archive.later ?? [])].map((entry) => ({ key: entry.key, raw: entry.raw }));
};

/** A real save of one pack (ticket 0), opened once by monitor()'s fixture player and read back. */
let saved: Record<string, string>;

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.use.isMobile) return;
  const baseURL = testInfo.project.use.baseURL!;
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await packsScreen(page);
  await openOne(page);
  await expectRecordedPack(page);
  saved = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!])));
  expect(errors).toEqual([]);
  await context.close();
});

// What a load keeps, what an import refuses and what the clock does don't depend on the viewport.
test.skip(({ isMobile }) => isMobile, 'Storage and network recovery are the same on every viewport; the desktop project runs them.');

/**
 * Puts the saved pack in storage with `changes` made first (null removes a key), as a browser that had
 * them would, before the page loads. Returns monitor()'s errors; routes added after this take precedence.
 */
async function seedSave(page: Page, baseURL: string, changes: Record<string, string | null> = {}) {
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

async function loadSave(page: Page, baseURL: string, changes: Record<string, string | null> = {}) {
  const errors = await seedSave(page, baseURL, changes);
  await page.goto('./');
  await packsScreen(page);
  return errors;
}

const withPlayer = (changes: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(saved[PLAYER_KEY]) as object, ...changes });

/** The saved pack's backup file, exported through Settings in a browser profile of its own. */
async function exportedBackup(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const page = await context.newPage();
  await holdTickets(page);
  const errors = await seedSave(page, baseURL);
  await page.goto('./#/settings');
  const settings = settingsOf(page);
  await expect(settings.main).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await settings.backUp.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloaded;
  const backup = await readFile((await download.path())!);
  await download.delete();
  expect(errors).toEqual([]);
  await context.close();
  return backup;
}

test.describe('damaged storage', () => {
  for (const [kind, value] of [['unreadable', GARBAGE], ['the wrong shape', '[1,2,3]']] as const) {
    test(`a collection that is ${kind} is kept aside and said so, and the next pack saves`, async ({ page, baseURL }) => {
      const errors = await loadSave(page, baseURL!, { [STORAGE_KEYS.COLLECTION]: value });
      // Nothing is written over the damaged collection just by loading it.
      expect(await raw(page, STORAGE_KEYS.COLLECTION)).toBe(value);

      await openOne(page);
      // The damaged bytes are kept aside, exactly, and said so; the live collection is valid and holds the new pack.
      const archive = JSON.parse((await raw(page, STORAGE_KEYS.COLLECTION_RECOVERY))!) as { raw: string };
      expect(archive.raw).toBe(value);
      await expect(page.getByRole('alert').filter({ hasText: COLLECTION_NOTE })).toBeVisible();
      expect(cardCount((await snapshot(page)).collection)).toBe(5);
      expect(await tickets(page)).toEqual([0, 1]);
      expect(await nextNonce(page)).toBe(2);
      expect(errors).toEqual([]);
    });
  }

  for (const [kind, value] of [['unreadable', GARBAGE], ['the wrong shape', '{"a":1}']] as const) {
    test(`a pack history that is ${kind} is never overwritten, and the next pack says what wasn't saved`, async ({ page, baseURL }) => {
      const errors = await loadSave(page, baseURL!, { [STORAGE_KEYS.HISTORY]: value });
      await openOne(page);
      // The history is the only record of which set each ticket opened: it stays as it was, and the
      // player is told this pack's record wasn't saved. The ticket count still moves on, never back.
      expect(await raw(page, STORAGE_KEYS.HISTORY)).toBe(value);
      await expect(page.getByRole('alert').filter({ hasText: SAVE_WARNING })).toBeVisible();
      expect(await nextNonce(page)).toBe(2);
      expect(cardCount(JSON.parse((await raw(page, STORAGE_KEYS.COLLECTION))!))).toBe(10);
      expect(errors).toEqual([]);
    });
  }

  // Keys the save can lose without losing a card or a ticket, all unreadable at once.
  test('unreadable settings, achievements, best cards, stored packs, Hall of Fame entries and data version still load, and the next pack is recorded in full', async ({ page, baseURL }) => {
    const keys = [STORAGE_KEYS.SETTINGS, STORAGE_KEYS.ACHIEVEMENTS, STORAGE_KEYS.BEST_CARDS, STORAGE_KEYS.STORED_PACKS, STORAGE_KEYS.HALL_OF_FAME, 'brainrot-data-version'];
    const errors = await loadSave(page, baseURL!, Object.fromEntries(keys.map((key) => [key, GARBAGE])));
    await openOne(page);
    const after = await snapshot(page);
    expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
    expect(cardCount(after.collection)).toBe(10);
    expect(after.stats.packsOpened).toBe(2);
    expect(await nextNonce(page)).toBe(2);
    expect(await page.getByRole('alert').allInnerTexts()).toEqual([]);
    // Each damaged key is left as it was, or replaced by a value that reads.
    for (const key of keys) {
      const now = await raw(page, key);
      expect(now === GARBAGE || now === null || (() => { try { JSON.parse(now); return true; } catch { return false; } })(), key).toBe(true);
    }
    expect(errors).toEqual([]);
  });

  for (const [key, name] of [
    [STORAGE_KEYS.SETTINGS, 'settings'],
    [STORAGE_KEYS.ACHIEVEMENTS, 'achievements'],
    [STORAGE_KEYS.BEST_CARDS, 'best cards'],
    [STORAGE_KEYS.STORED_PACKS, 'stored packs'],
    [STORAGE_KEYS.HALL_OF_FAME, 'Hall of Fame entries'],
    [STORAGE_KEYS.SELECTED_SET, 'selected set'],
    [STORAGE_KEYS.PENDING_PACK, 'legacy pending pack'],
    [STORAGE_KEYS.PENDING_PACKS, 'pending packs shelf'],
    [STORAGE_KEYS.PULLS, 'legacy pull log'],
    ['brainrot-data-version', 'data version'],
  ] as const) {
    for (const [kind, value] of [['unreadable', GARBAGE], ['the wrong shape', '{"invalid":true}']] as const) {
      test(`${name} that is ${kind} still loads, and the next pack is recorded in full`, async ({ page, baseURL }) => {
        const errors = await loadSave(page, baseURL!, { [key]: value });
        await openOne(page);
        const after = await snapshot(page);
        expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
        expect(cardCount(after.collection)).toBe(10);
        expect(after.stats.packsOpened).toBe(2);
        expect(await nextNonce(page)).toBe(2);
        expect(await page.getByRole('alert').allInnerTexts()).toEqual([]);
        const now = await raw(page, key);
        expect(now === value || now === null || (() => { try { JSON.parse(now); return true; } catch { return false; } })(), key).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  }

  for (const [kind, value] of [['unreadable', GARBAGE], ['the wrong shape', '{"invalid":true}']] as const) {
    test(`a collection recovery archive that is ${kind} still loads, says unreadable data was kept aside, and the next pack is recorded in full`, async ({ page, baseURL }) => {
      const errors = await loadSave(page, baseURL!, { [STORAGE_KEYS.COLLECTION_RECOVERY]: value });
      await expect(page.getByRole('alert').filter({ hasText: COLLECTION_NOTE })).toBeVisible();
      await openOne(page);
      const after = await snapshot(page);
      expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
      expect(cardCount(after.collection)).toBe(10);
      expect(after.stats.packsOpened).toBe(2);
      expect(await nextNonce(page)).toBe(2);
      const now = await raw(page, STORAGE_KEYS.COLLECTION_RECOVERY);
      expect(now === value || now === null || (() => { try { JSON.parse(now); return true; } catch { return false; } })(), STORAGE_KEYS.COLLECTION_RECOVERY).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  test('a ticket counter set below zero moves on past the tickets already opened', async ({ page, baseURL }) => {
    const errors = await loadSave(page, baseURL!, { [PLAYER_KEY]: withPlayer({ nextNonce: -1 }) });
    await openOne(page);
    // Ticket 0 is in the history, so the next pack takes ticket 1, never 0 again.
    expect(await tickets(page)).toEqual([0, 1]);
    expect(await nextNonce(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('a ticket counter at its limit refuses the pack, says so, and changes nothing', async ({ page, baseURL }) => {
    const errors = await loadSave(page, baseURL!, { [PLAYER_KEY]: withPlayer({ nextNonce: Number.MAX_SAFE_INTEGER }) });
    const before = await storageOf(page);
    await openPack(page).click();
    await expect(page.locator('.pack-refusal-text').first()).toHaveText("This pack didn't open, and no cards were dealt.");
    await expect(page.locator('.summary-card')).toHaveCount(0);
    expect(sameStorage(await storageOf(page), before)).toBe(true);
    expect(errors).toEqual([
      expect.stringMatching(/^Ticket counter exhausted: /),
      expect.stringMatching(/^Could not open pack RangeError: This player has no ticket numbers left/),
    ]);
  });

  test('an absurd pack count keeps counting, and the pack is recorded in full', async ({ page, baseURL }) => {
    const stats = JSON.stringify({ ...JSON.parse(saved[STORAGE_KEYS.STATS]) as object, packsOpened: 999_999_999 });
    const errors = await loadSave(page, baseURL!, { [STORAGE_KEYS.STATS]: stats });
    await openOne(page);
    const after = await snapshot(page);
    expect(after.stats.packsOpened).toBe(1_000_000_000);
    expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
    expect(cardCount(after.collection)).toBe(10);
    expect(errors).toEqual([]);
  });

  for (const [kind, value] of [['unreadable', GARBAGE], ['the wrong shape', '{"packsOpened":"many"}']] as const) {
    test(`stats that are ${kind} are kept aside, rebuilt from the history and collection, and keep counting`, async ({ page, baseURL }) => {
      const errors = await loadSave(page, baseURL!, { [STORAGE_KEYS.STATS]: value });
      // The damaged bytes are kept aside, exactly, and said so. The stats in use are rebuilt from the
      // saved pack, not started over, and stored at once.
      await expect(page.getByRole('alert').filter({ hasText: STATS_NOTE })).toBeVisible();
      expect(await keptAside(page)).toEqual([{ key: STORAGE_KEYS.STATS, raw: value }]);
      await expect.poll(() => raw(page, STORAGE_KEYS.STATS)).not.toBe(value);
      expect(scored((await snapshot(page)).stats)).toEqual(scored(JSON.parse(saved[STORAGE_KEYS.STATS])));

      await openOne(page);
      const after = await snapshot(page);
      expect(after.stats.packsOpened).toBe(2);
      expect(after.history.map((record) => record.n).sort()).toEqual([0, 1]);
      expect(cardCount(after.collection)).toBe(10);
      expect(await nextNonce(page)).toBe(2);
      expect(errors).toEqual([]);
    });
  }

  test('a player record whose key reads but whose ticket count does not keeps its key and counts on past the opened tickets', async ({ page, baseURL }) => {
    const damaged = withPlayer({ nextNonce: 'twelve' });
    const errors = await loadSave(page, baseURL!, { [PLAYER_KEY]: damaged });
    // The damaged bytes are kept aside, exactly, and said so; the stored record keeps everything that
    // read and counts past ticket 0, the one the history shows this key used.
    await expect(page.getByRole('alert').filter({ hasText: PLAYER_REPAIRED })).toBeVisible();
    expect(await keptAside(page)).toEqual([{ key: PLAYER_KEY, raw: damaged }]);
    expect(JSON.parse((await raw(page, PLAYER_KEY))!)).toEqual({ ...JSON.parse(saved[PLAYER_KEY]) as object, nextNonce: 1 });

    await openOne(page);
    expect(await tickets(page)).toEqual([0, 1]);
    expect(await nextNonce(page)).toBe(2);
    expect((await snapshot(page)).stats.packsOpened).toBe(2);
    expect(errors).toEqual([]);
  });

  test('a player record with no key that reads pauses packs and keeps its bytes, and restoring a backup carries on from the next ticket', async ({ page, browser, baseURL }) => {
    test.setTimeout(90000);
    const backup = await exportedBackup(browser, baseURL!);
    // Nothing mines a ticket until the restored save is loaded, so the import's reload aborts no request.
    await holdTickets(page);
    const errors = await loadSave(page, baseURL!, { [PLAYER_KEY]: GARBAGE });

    // The bytes stay where they are, a copy is kept aside, and the player is told packs are paused.
    await expect(page.getByRole('alert').filter({ hasText: PLAYER_PAUSED })).toBeVisible();
    expect(await raw(page, PLAYER_KEY)).toBe(GARBAGE);
    expect(await keptAside(page)).toEqual([{ key: PLAYER_KEY, raw: GARBAGE }]);
    const paused = await storageOf(page);

    // A pack stays sealed, says why and where to go, and changes nothing.
    await openPack(page).click();
    await expect(page.locator('.pack-refusal-text').first()).toHaveText(PLAYER_SEALED);
    await expect(page.locator('.summary-card')).toHaveCount(0);
    expect(sameStorage(await storageOf(page), paused)).toBe(true);

    // Save & backup offers Restore first; the backup brings the player and its pack back.
    await page.getByRole('button', { name: 'Open Save & backup', exact: true }).click();
    const settings = settingsOf(page);
    await expect(settings.main).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await settings.main.getByRole('button', { name: 'Restore a backup', exact: true }).click();
    await (await chooser).setFiles({ name: 'backup.txt', mimeType: 'text/plain', buffer: backup });
    await expect(settings.restoreNote).toHaveText("Replace this browser's save (1 pack) with the file's (Browser smoke fixture, 1 pack)? Yours is kept as a backup.");
    // The import reloads the page; everything after is checked in the new document.
    const restored = page.waitForEvent('load');
    await settings.replace.click();
    await restored;
    await expect(settings.main).toBeVisible();
    await expect(settings.restoreNote).toHaveText('Load a backup file');
    expect(await raw(page, PLAYER_KEY)).toBe(saved[PLAYER_KEY]);

    // The next pack takes ticket 1: none lost, none reused. The damaged bytes stay in the copy the
    // import kept of the save it replaced.
    await page.goto('./');
    await packsScreen(page);
    await releaseTickets(page);
    await openOne(page);
    // The damaged bytes stay kept aside, for Download, but the restored key unpauses packs.
    await expect(page.getByRole('alert').filter({ hasText: /^Unreadable player data was kept aside in this browser\./ })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: PLAYER_PAUSED })).toHaveCount(0);
    expect(await tickets(page)).toEqual([0, 1]);
    expect(await nextNonce(page)).toBe(2);
    expect((await snapshot(page)).stats.packsOpened).toBe(2);
    expect(cardCount((await snapshot(page)).collection)).toBe(10);
    expect((JSON.parse((await raw(page, 'brainrot-before-import-v1'))!) as Record<string, string>)[PLAYER_KEY]).toBe(GARBAGE);
    // The sealed pack's refusal, logged once.
    expect(errors).toEqual([expect.stringMatching(/^Could not open pack PlayerUnreadableError: The player record can't be read, so no ticket can be claimed/)]);
  });

  test('a player record with no key that reads can give way to a new player, and the old save is kept whole in a copy', async ({ page, baseURL }) => {
    // Nothing mines a ticket until the new player is loaded, so the reload after the switch aborts no request.
    await holdTickets(page);
    const errors = await loadSave(page, baseURL!, { [PLAYER_KEY]: GARBAGE });
    await expect(page.getByRole('alert').filter({ hasText: PLAYER_PAUSED })).toBeVisible();
    const old = Object.fromEntries(Object.entries(await storageOf(page)).filter(([key]) => key.startsWith('brainrot-')));

    await page.goto('./#/settings');
    const settings = settingsOf(page);
    const row = settings.main.locator('.settings-row').filter({ has: page.locator('.settings-label', { hasText: /^Player record$/ }) });
    await row.getByRole('button', { name: 'Start a new player', exact: true }).click();
    await expect(row.getByRole('status')).toHaveText(/^Start a new player\? You start over with a new key/);
    // The page reloads with the new player, and Save & backup has nothing left to ask.
    const reloaded = page.waitForEvent('load');
    await row.getByRole('button', { name: 'Start a new player', exact: true }).click();
    await reloaded;
    await expect(settings.main).toBeVisible();
    await expect(row).toHaveCount(0);

    // The new key starts at ticket 0 with none of the old player's progress, and the old save, damaged
    // bytes and its pack included, is kept as it was.
    await page.goto('./');
    await packsScreen(page);
    await releaseTickets(page);
    await openOne(page);
    // The damaged bytes stay kept aside, for Download, but the new key unpauses packs.
    await expect(page.getByRole('alert').filter({ hasText: /^Unreadable player data was kept aside in this browser\./ })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: PLAYER_PAUSED })).toHaveCount(0);
    const player = JSON.parse((await raw(page, PLAYER_KEY))!) as { secretKey: string; nextNonce: number };
    expect(player.secretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(player.secretKey === JSON.parse(saved[PLAYER_KEY]).secretKey).toBe(false);
    expect(player.nextNonce).toBe(1);
    const after = await snapshot(page);
    expect(after.history.map((record) => record.n)).toEqual([0]);
    expect(after.history[0].k).not.toBe(JSON.parse(saved[STORAGE_KEYS.HISTORY])[0].k);
    expect(after.stats.packsOpened).toBe(1);
    expect(cardCount(after.collection)).toBe(5);
    const copy = JSON.parse((await raw(page, 'brainrot-before-new-player-v1'))!) as Record<string, string>;
    expect(sameStorage(Object.fromEntries(Object.keys(copy).sort().map((key) => [key, copy[key]])), old)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('damaged backup files', () => {
  test('a file that is garbage, the wrong shape or holds invalid numbers is refused, says why, and leaves the save as it was', async ({ page, baseURL }) => {
    await holdTickets(page);
    const errors = await seedSave(page, baseURL!);
    await page.goto('./#/settings');
    const settings = settingsOf(page);
    await expect(settings.main).toBeVisible();

    // This browser's own backup, to tamper with.
    const downloaded = page.waitForEvent('download');
    await settings.backUp.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloaded;
    const backup = JSON.parse(await readFile((await download.path())!, 'utf8')) as Record<string, unknown>;
    await download.delete();
    const field = (name: string) => JSON.parse(backup[name] as string) as Record<string, unknown> & unknown[];
    const tampered = (changes: Record<string, unknown>) => JSON.stringify({ ...backup, ...changes });
    const untouched = await storageOf(page);

    const files: [string, string | Buffer, boolean, string][] = [
      ['garbage bytes', Buffer.from([0x00, 0xff, 0xfe, 0x7b, 0x22, 0x9c, 0x0a]), false, "Couldn't read that file. Is it a save exported from Save & backup?"],
      ['an HTML document', '<!DOCTYPE html><html><body>not a save</body></html>', false, "Couldn't read that file. Is it a save exported from Save & backup?"],
      ['a plain text file', 'Brainrot TCG save export preview text', false, "Couldn't read that file. Is it a save exported from Save & backup?"],
      ['a truncated backup file', JSON.stringify(backup).slice(0, 60), false, "Couldn't read that file. Is it a save exported from Save & backup?"],
      ['a JSON list', '[1,2,3]', false, "That file isn't a supported Brainrot TCG save."],
      ['an object with no save in it', '{"a":1}', true, "That file isn't a supported Brainrot TCG save."],
      ['an unknown backup version', tampered({ version: 99 }), false, "That file isn't a supported Brainrot TCG save."],
      ['an unknown data version', tampered({ dataVersion: 99 }), false, 'This save uses an unsupported data version.'],
      ['a data version below one', tampered({ dataVersion: 0 }), false, 'This save uses an unsupported data version.'],
      ['a negative pack count', tampered({ stats: JSON.stringify({ ...field('stats'), packsOpened: -1 }) }), true, 'The stats in this save is invalid. Nothing was imported.'],
      ['a negative ticket in the history', tampered({ history: JSON.stringify((field('history') as Record<string, unknown>[]).map((record) => ({ ...record, n: -1 }))) }), false, 'The history in this save is invalid. Nothing was imported.'],
      ['a negative ticket counter', tampered({ player: JSON.stringify({ ...field('player'), nextNonce: -1 }) }), false, "That file's player record can't be read, so it has no player key that works and can't be restored. Nothing was imported."],
      ['an invalid player secret key', tampered({ player: JSON.stringify({ ...field('player'), secretKey: 'not-a-valid-hex-key' }) }), true, "That file's player record can't be read, so it has no player key that works and can't be restored. Nothing was imported."],
    ];
    for (const [name, content, asks, refusal] of files) {
      await test.step(name, async () => {
        await pickWithImport(page, { name: 'backup.txt', buffer: Buffer.isBuffer(content) ? content : Buffer.from(content) });
        if (asks) {
          // Restore asks before replacing a different save; the file is checked in full once the player says yes.
          await expect(settings.restoreNote).toHaveText(/^Replace this browser's save \(Browser smoke fixture, 1 pack\) with the file's /);
          await settings.replace.click();
        }
        await expect(settings.restoreNote).toHaveText(refusal);
        await expect(settings.importButton).toBeVisible();
        expect(sameStorage(await storageOf(page), untouched)).toBe(true);
      });
    }

    await test.step('a file too big for storage', async () => {
      const huge = tampered({ settings: JSON.stringify({ cardBack: 'x'.repeat(6 * 1024 * 1024) }) });
      await pickWithImport(page, { name: 'backup.txt', buffer: Buffer.from(huge) });
      await expect(settings.restoreNote).toHaveText("There's no room in this browser's storage for this file and a copy of your current save. Nothing changed. Export your save first if you want to keep it, then replace it without a copy.");
      const replaceWithoutCopy = settings.restore.getByRole('button', { name: 'Replace without a copy', exact: true });
      await expect(replaceWithoutCopy).toBeVisible();
      await replaceWithoutCopy.click();
      await expect(settings.restoreNote).toHaveText("This file is too big for this browser's storage, so it can't be imported here. Nothing changed.");
      await expect(settings.importButton).toBeVisible();
      expect(sameStorage(await storageOf(page), untouched)).toBe(true);
    });

    expect(errors).toEqual([]);
  });

  test("importing another player's save asks first and leaves storage untouched when cancelled", async ({ page, baseURL }) => {
    await holdTickets(page);
    const errors = await seedSave(page, baseURL!);
    await page.goto('./#/settings');
    const settings = settingsOf(page);
    await expect(settings.main).toBeVisible();

    const downloaded = page.waitForEvent('download');
    await settings.backUp.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloaded;
    const backup = JSON.parse(await readFile((await download.path())!, 'utf8')) as Record<string, unknown>;
    await download.delete();
    const untouched = await storageOf(page);

    const otherPlayer = JSON.stringify({
      ...JSON.parse(backup.player as string) as object,
      secretKey: 'ab'.repeat(32),
      name: 'Other player',
    });
    const fileContent = JSON.stringify({ ...backup, player: otherPlayer });

    await pickWithImport(page, { name: 'other-player.txt', buffer: Buffer.from(fileContent) });
    await expect(settings.restoreNote).toHaveText("Replace this browser's save (Browser smoke fixture, 1 pack) with the file's (Other player, 1 pack)? Yours is kept as a backup.");
    await settings.keep.click();
    await expect(settings.restoreNote).toHaveText('Kept your save.');
    await expect(settings.importButton).toBeVisible();
    expect(sameStorage(await storageOf(page), untouched)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('offline mid-session', () => {
  test('packs still open offline, art comes back online without a reload, and Rankings says the feed is down until it recovers', async ({ page, baseURL }) => {
    const errors = await seedSave(page, baseURL!);
    let offline = false;
    const cut: string[] = [];
    await relaysAnswerEmpty(page, () => offline);
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [] }));
    await page.route('**/*', (route) => {
      if (!offline) return route.fallback();
      cut.push(route.request().url());
      return route.abort('internetdisconnected');
    });
    // Each toggle comes once the page is idle, but the browser's own favicon fetch can still be in flight, so
    // in-flight requests aren't counted here; the exact error list at the end fails on any other cut request.
    const setOffline = async (value: boolean) => {
      offline = value;
      await page.context().setOffline(value);
    };
    // The next pack's ticket mines only once the connection is down, so prefetchNextPack can't put this
    // pack's art in the memory cache first (it fetches the pictures as soon as the ticket is in).
    await holdTickets(page);
    const finishToastWarmup = await holdToastStyles(page);
    // The confetti library is fetched once the packs screen idles; the connection only drops after it is in.
    const confettiLoaded = page.waitForResponse((response) => /\/confettiEffects-[^/]+\.js$/.test(response.url()));
    await page.goto('./');
    await packsScreen(page);
    await confettiLoaded;
    await finishToastWarmup();

    // Offline: the pack opens and is recorded; only pictures fail to load. It opens before any card art
    // has shown on this page (Rankings shows the saved pack's), and its prefetch ran offline, so none of
    // it can come from the page's memory cache without a request.
    await setOffline(true);
    await releaseTickets(page);
    await openOne(page);
    expect(await tickets(page)).toEqual([0, 1]);
    expect(await nextNonce(page)).toBe(2);
    expect(cardCount((await snapshot(page)).collection)).toBe(10);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.filter((url) => !/\.(webp|png|svg)$/.test(new URL(url).pathname))).toEqual([]);
    const art = page.locator('.summary-cards img');
    await expect(art).toHaveCount(5);
    for (const image of await art.all()) await expect(image).toHaveAttribute('data-state', 'failed');

    // Back online, the art loads in place.
    await setOffline(false);
    await expectDecoded(art, 5);

    // Rankings loads online; offline, it says the live feed is down; back online, Retry brings it back.
    await page.getByRole('button', { name: /^Open .+ again$/ }).click();
    await packsScreen(page);
    const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
    const rankingsStatus = rankings.getByRole('status');
    await nav(page).getByRole('button', { name: 'Rankings', exact: true }).click();
    await expect(rankingsStatus).toHaveText('Rankings loaded.');
    await page.getByRole('button', { name: 'Close Rankings', exact: true }).click();
    await packsScreen(page);
    await setOffline(true);
    await nav(page).getByRole('button', { name: 'Rankings', exact: true }).click();
    await expect(rankingsStatus).toHaveText(FEED_DOWN);
    await setOffline(false);
    const retry = rankings.getByRole('button', { name: 'Retry loading rankings', exact: true });
    await retry.click();
    await expect(rankingsStatus).toHaveText('Rankings loaded.');
    await expect(retry).toHaveCount(0);

    // Every error is a request cut while offline, or a card finish that couldn't load its cut picture.
    const finishes = errors.filter((error) => error.startsWith('Could not render card finish '));
    for (const finish of finishes) expect(cut.some((url) => finish.includes(new URL(url).pathname)), finish).toBe(true);
    expect([...errors].sort()).toEqual([
      ...cut.flatMap((url) => [`net::ERR_INTERNET_DISCONNECTED ${url}`, 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED']),
      ...finishes,
    ].sort());
  });

  test('a fresh player opens ticket 0 offline into an empty save, and the Cards page already loaded shows the pack', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!);
    let offline = false;
    const cut: string[] = [];
    await relaysAnswerEmpty(page, () => offline);
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [] }));
    await page.route('**/*', (route) => {
      if (!offline) return route.fallback();
      cut.push(route.request().url());
      return route.abort('internetdisconnected');
    });
    // No seeded save: this player has never opened a pack, so the ticket opened offline is ticket 0.
    await holdTickets(page);
    const finishToastWarmup = await holdToastStyles(page);
    const confettiLoaded = page.waitForResponse((response) => /\/confettiEffects-[^/]+\.js$/.test(response.url()));
    await page.goto('./');
    await packsScreen(page);
    await confettiLoaded;
    await finishToastWarmup();

    // A fresh player has no navigation yet, and the Cards page is a lazy chunk that nothing prefetches: visit
    // it online (an empty collection) so its script and stylesheet are in before the connection drops.
    // (The chunk failing offline, and its Retry, is deferred-screens.spec.ts.)
    await page.evaluate(() => { location.hash = '#/cards'; });
    const cards = page.getByRole('main', { name: 'Cards', exact: true });
    await expect(cards.locator('.collection-empty')).toHaveText('Open packs to start your collection.');
    await page.evaluate(() => { location.hash = '#/'; });
    await packsScreen(page);

    offline = true;
    await page.context().setOffline(true);
    await releaseTickets(page);
    await openOne(page);
    expect(await tickets(page)).toEqual([0]);
    expect(await nextNonce(page)).toBe(1);
    const collection = (await snapshot(page)).collection!;
    expect(cardCount(collection)).toBe(5);

    // Cards, offline, reads the saved pack: one tile per distinct card, none of them the empty note.
    await page.getByRole('button', { name: /^Open .+ again$/ }).click();
    await packsScreen(page);
    // The first saved pack is also the first time the news chunk is asked for (a fresh player never loads it
    // online): offline it gives no news, so there is no news toast, and nothing else breaks.
    const newsChunk = /\/assets\/news-[^/]+\.js$/;
    await expect.poll(() => cut.some((url) => newsChunk.test(url))).toBe(true);
    await expect(page.locator('.toast').filter({ hasText: "What's new" })).toHaveCount(0);
    await nav(page).getByRole('button', { name: 'Cards', exact: true }).click();
    await expect(cards.getByRole('alert')).toHaveCount(0);
    await expect(cards.locator('.collection-empty')).toHaveCount(0);
    const tiles = cards.locator('.collection-item');
    await expect(tiles).toHaveCount(Object.keys(collection).length);
    // Pictures are all that can't load: wait for the tiles' art to settle so every cut request is in `cut`.
    for (const image of await tiles.locator('img').all()) await expect(image).toHaveAttribute('data-state', 'failed');

    // Whole run, Cards step included: only pictures and the news chunk were cut, never the Cards chunk, a
    // stylesheet or a font.
    expect(cut.filter((url) => !/\.(webp|png|svg)$/.test(new URL(url).pathname) && !newsChunk.test(url))).toEqual([]);
    const finishes = () => errors.filter((error) => error.startsWith('Could not render card finish '));
    // Each cut request is reported after the fact: wait until all of them (and nothing else) have been.
    const expected = () => [
      ...cut.flatMap((url) => [`net::ERR_INTERNET_DISCONNECTED ${url}`, 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED']),
      ...finishes(),
    ].sort();
    await expect(async () => { expect([...errors].sort()).toEqual(expected()); }).toPass({ timeout: 5000 });
    for (const finish of finishes()) expect(cut.some((url) => finish.includes(new URL(url).pathname)), finish).toBe(true);
  });
});

test.describe('Argon2 chunk fetched ahead (#776)', () => {
  test('a pack still opens offline when the ticket worker fails and mining falls back to the main thread', async ({ page, baseURL }) => {
    const errors = await seedSave(page, baseURL!);
    let offline = false;
    const cut: string[] = [];
    await relaysAnswerEmpty(page, () => offline);
    await page.route('**/*', (route) => {
      if (!offline) return route.fallback();
      cut.push(route.request().url());
      return route.abort('internetdisconnected');
    });
    // A ticket worker that takes its jobs and then fails, as one that can't start does: mining goes to the
    // main thread, which needs Argon2 in the page itself. Its jobs wait until `__failTicketWorker`, so the
    // failure comes only once the connection is down.
    await page.addInitScript(() => {
      let failed = false;
      const waiting: FailingWorker[] = [];
      class FailingWorker {
        onmessage: unknown = null;
        onerror: ((event: unknown) => void) | null = null;
        postMessage() {
          if (failed) queueMicrotask(() => this.fail());
          else if (!waiting.includes(this)) waiting.push(this);
        }
        fail() { this.onerror?.({ preventDefault() {}, message: 'blocked' }); }
        terminate() {}
      }
      window.Worker = FailingWorker as unknown as typeof Worker;
      Object.defineProperty(window, '__failTicketWorker', {
        value: () => { failed = true; waiting.splice(0).forEach((worker) => worker.fail()); },
      });
    });
    // The Argon2 chunk comes with the card back once the packs screen idles; the connection only drops after it is in.
    const finishToastWarmup = await holdToastStyles(page);
    const argon2Loaded = page.waitForResponse((response) => /\/argon2-[^/]+\.js$/.test(response.url()));
    await page.goto('./');
    await packsScreen(page);
    await argon2Loaded;
    await finishToastWarmup();

    offline = true;
    await page.context().setOffline(true);
    await page.evaluate(() => (window as unknown as { __failTicketWorker: () => void }).__failTicketWorker());
    await openOne(page);
    expect(await tickets(page)).toEqual([0, 1]);
    expect(await nextNonce(page)).toBe(2);
    expect(cardCount((await snapshot(page)).collection)).toBe(10);
    // Only pictures were cut: nothing the main-thread mining needed was missing.
    expect(cut.filter((url) => !/\.(webp|png|svg)$/.test(new URL(url).pathname))).toEqual([]);
    const art = page.locator('.summary-cards img');
    await expect(art).toHaveCount(5);
    for (const image of await art.all()) await expect(image).toHaveAttribute('data-state', 'failed');

    // Back online, the art loads in place; by then every cut request has been reported.
    offline = false;
    await page.context().setOffline(false);
    await expectDecoded(art, 5);
    const finishes = errors.filter((error) => error.startsWith('Could not render card finish '));
    for (const finish of finishes) expect(cut.some((url) => finish.includes(new URL(url).pathname)), finish).toBe(true);
    expect([...errors].sort()).toEqual([
      ...cut.flatMap((url) => [`net::ERR_INTERNET_DISCONNECTED ${url}`, 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED']),
      ...finishes,
    ].sort());
  });

  test('the Best cards rebuild finishes offline, on the main thread, from the Argon2 chunk already fetched', async ({ page, baseURL }) => {
    const errors = await seedSave(page, baseURL!);
    let offline = false;
    const cut: string[] = [];
    await relaysAnswerEmpty(page, () => offline);
    await page.route('**/*', (route) => {
      if (!offline) return route.fallback();
      cut.push(route.request().url());
      return route.abort('internetdisconnected');
    });
    // The page fetches the chunk once the packs screen idles; the connection only drops after it is in.
    const argon2Loaded = page.waitForResponse((response) => /\/argon2-[^/]+\.js$/.test(response.url()));
    await page.goto('./');
    await packsScreen(page);
    await openOne(page);
    await argon2Loaded;
    await page.getByRole('button', { name: 'Back to packs', exact: true }).click();
    await packsScreen(page);

    // Profile's own chunk is loaded now, and its Best cards list is the two packs' cards, best first.
    await nav(page).getByRole('button', { name: 'Profile', exact: true }).click();
    const bestCards = () => page.getByRole('main', { name: 'Profile', exact: true }).getByRole('region', { name: 'Best cards', exact: true });
    const rows = () => bestCards().locator('button.best-card-row');
    await expect(rows()).toHaveCount(10);
    const before = await rows().locator('.pull-row-score').allTextContents();
    await nav(page).getByRole('button', { name: 'Open', exact: true }).click();
    await packsScreen(page);
    await packToastsReady(page);

    // Leave every winner without its cached card, so coming back to Profile has to rebuild them from their tickets
    // (Argon2 again, on the main thread), now with no connection.
    await page.evaluate((key) => {
      const store = JSON.parse(localStorage.getItem(key)!) as Record<string, { b: { c?: string }[] }>;
      for (const list of Object.values(store)) for (const winner of list.b) delete winner.c;
      localStorage.setItem(key, JSON.stringify(store));
    }, STORAGE_KEYS.BEST_CARDS);
    offline = true;
    await page.context().setOffline(true);
    await nav(page).getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(rows()).toHaveCount(10, { timeout: 30000 });
    expect(await rows().locator('.pull-row-score').allTextContents()).toEqual(before);
    await expect(bestCards().getByRole('status')).toHaveCount(0);
    expect(await page.evaluate((key) => Object.values(JSON.parse(localStorage.getItem(key)!) as Record<string, { b: { c?: string }[] }>)
      .every((list) => list.b.every((winner) => typeof winner.c === 'string')), STORAGE_KEYS.BEST_CARDS)).toBe(true);
    // Nothing the rebuild needed was missing: only pictures were cut.
    expect(cut.filter((url) => !/\.(webp|png|svg)$/.test(new URL(url).pathname))).toEqual([]);

    offline = false;
    await page.context().setOffline(false);
    // Back online, the rows' pictures that were cut load in place; by then every cut request has been reported.
    await expect(rows().locator('img[data-state="failed"]')).toHaveCount(0);
    const finishes = errors.filter((error) => error.startsWith('Could not render card finish '));
    for (const finish of finishes) expect(cut.some((url) => finish.includes(new URL(url).pathname)), finish).toBe(true);
    expect([...errors].sort()).toEqual([
      ...cut.flatMap((url) => [`net::ERR_INTERNET_DISCONNECTED ${url}`, 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED']),
      ...finishes,
    ].sort());
  });
});

test.describe('confetti library cut', () => {
  test('a pack still opens, is recorded and throws nothing when the confetti chunk never arrives', async ({ page, baseURL }) => {
    const errors = await seedSave(page, baseURL!);
    const cut: string[] = [];
    await page.route('**/confettiEffects-*.js', (route) => {
      cut.push(route.request().url());
      return route.abort('failed');
    });
    await page.goto('./');
    await packsScreen(page);
    await openOne(page);

    expect(cut.length).toBeGreaterThan(0);
    expect(await tickets(page)).toEqual([0, 1]);
    expect(cardCount((await snapshot(page)).collection)).toBe(10);
    // The only errors are the cut requests themselves: nothing thrown or rejected unhandled.
    expect([...errors].sort()).toEqual(cut.flatMap((url) => [`net::ERR_FAILED ${url}`, 'Failed to load resource: net::ERR_FAILED']).sort());
  });
});

test.describe('clock rollover', () => {
  test('the Today board starts a new day at 00:00 UTC without a reload, and All-time keeps the pull', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await relaysAnswerEmpty(page);
    const filed = {
      id: 'fixture-today', proof: 'fixture-proof-today', name: 'Fixture today', fingerprint: 'abcd', setId: 'right-now',
      setName: 'Right Now', hand: 'Full House', multiplier: 150, score: 50000, submittedAt: '2026-10-01T12:00:00.000Z',
      cards: [], issue: 1000, githubUser: 'fixture',
    };
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [filed] }));
    await page.clock.install({ time: new Date('2026-10-01T23:59:00.000Z') });
    await page.goto('./#/rankings');
    const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
    await expect(rankings.getByRole('status')).toHaveText('Rankings loaded.');
    const rows = rankings.locator('.hof-list .hof-entry');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('href', '#/pull/fixture-proof-today');

    // Past midnight the board starts the new day: today is empty, and the pull moves under yesterday's best.
    await page.clock.runFor('01:05');
    await expect(rankings.getByRole('tabpanel')).toContainText('No pulls filed today yet.');
    const yesterday = rankings.getByRole('region', { name: "Yesterday's best", exact: true });
    await expect(yesterday.locator('.hof-entry')).toHaveCount(1);
    await expect(yesterday.locator('.hof-entry')).toHaveAttribute('href', '#/pull/fixture-proof-today');
    await expect(rows).toHaveCount(1);

    await rankings.getByRole('tab', { name: 'All-time', exact: true }).click();
    await expect(rows).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('opening a pack after the clock rolls back keeps the ticket sequence and records in full', async ({ page, baseURL }) => {
    await page.clock.install({ time: new Date('2026-10-02T12:00:00.000Z') });
    const errors = await seedSave(page, baseURL!);
    await page.goto('./');
    await packsScreen(page);

    // Roll clock back by 24 hours to an earlier date
    await page.clock.setFixedTime(new Date('2026-10-01T12:00:00.000Z'));
    await openOne(page);

    // Tickets sequence strictly continues from nextNonce, never moves back
    expect(await tickets(page)).toEqual([0, 1]);
    expect(await nextNonce(page)).toBe(2);
    const after = await snapshot(page);
    expect(after.stats.packsOpened).toBe(2);
    expect(cardCount(after.collection)).toBe(10);
    expect(after.history).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  test('Rankings loaded after a clock rollback across midnight UTC displays pulls under Today', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await relaysAnswerEmpty(page);
    const filed = {
      id: 'fixture-today', proof: 'fixture-proof-today', name: 'Fixture today', fingerprint: 'abcd', setId: 'right-now',
      setName: 'Right Now', hand: 'Full House', multiplier: 150, score: 50000, submittedAt: '2026-10-01T12:00:00.000Z',
      cards: [], issue: 1000, githubUser: 'fixture',
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

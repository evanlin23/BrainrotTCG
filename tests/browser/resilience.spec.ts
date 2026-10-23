import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { STORAGE_KEYS } from '../../src/constants/config';
import {
  expectDecoded, expectRecordedPack, holdTickets, monitor, pickWithImport, relaysAnswerEmpty, releaseTickets, sameStorage,
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
 * (deferred-styles.spec.ts) and art offline (card-image-*.spec.ts). Left out until they're fixed: a
 * damaged player record (#1052) and damaged stats (#1053).
 */

// Backup files hold the player's secret key: keep them out of traces and videos.
test.use({ trace: 'off', video: 'off' });

const GARBAGE = '\u0000ÿ{not json';
const COLLECTION_NOTE = /^Unreadable collection data was kept aside in this browser\./;
const SAVE_WARNING = "Some changes couldn't be saved in this browser and may be lost when you close or reload. Backups only include data already saved.";
const FEED_DOWN = "Couldn't reach the live feed, so pulls sent recently may be missing. Try again.";

/** Marks a browser whose save was seeded, so a reload keeps what storage holds by then. */
const SEEDED = 'test-resilience-seeded';
const PLAYER_KEY = 'brainrot-player-v1';

const openPack = (page: Page) => page.getByRole('button', { name: /^Open pack/ });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main', exact: true });

async function packsScreen(page: Page) {
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectDecoded(page.locator('.pack-shell img'), 2);
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
      ['a JSON list', '[1,2,3]', false, "That file isn't a supported Brainrot TCG save."],
      ['an object with no save in it', '{"a":1}', true, "That file isn't a supported Brainrot TCG save."],
      ['an unknown data version', tampered({ dataVersion: 99 }), false, 'This save uses an unsupported data version.'],
      ['a negative pack count', tampered({ stats: JSON.stringify({ ...field('stats'), packsOpened: -1 }) }), true, 'The stats in this save is invalid. Nothing was imported.'],
      ['a negative ticket in the history', tampered({ history: JSON.stringify((field('history') as Record<string, unknown>[]).map((record) => ({ ...record, n: -1 }))) }), false, 'The history in this save is invalid. Nothing was imported.'],
      ['a negative ticket counter', tampered({ player: JSON.stringify({ ...field('player'), nextNonce: -1 }) }), false, "That file's player record can't be read, so it has no player key that works and can't be restored. Nothing was imported."],
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
    // The confetti library is fetched once the packs screen idles; the connection only drops after it is in.
    const confettiLoaded = page.waitForResponse((response) => /\/confettiEffects-[^/]+\.js$/.test(response.url()));
    await page.goto('./');
    await packsScreen(page);
    await confettiLoaded;

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
    await page.getByRole('button', { name: 'Next pack', exact: true }).click();
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
});

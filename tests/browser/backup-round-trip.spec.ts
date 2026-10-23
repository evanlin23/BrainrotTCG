import { test, expect, type Browser } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitor, expectDecoded, expectRecordedPack, holdTickets, pickWithImport, sameStorage, settingsOf, snapshot, storageOf } from './support';

/**
 * Back up and Restore in Save & backup (#744), through the browser's own file controls: the Export
 * download is saved to a temporary file, and that file is picked with the file chooser that Import
 * opens, in a separate browser profile. Nothing here calls the import code directly; every step goes
 * through the Settings controls, their status notes and a reload.
 *
 * The backup holds the player's secret key. The keys here are throwaway fixtures, but the spec still
 * keeps file contents out of failure output: traces and videos (which record picked files and storage)
 * are off, key checks are booleans, and the temporary download is deleted afterwards.
 */
test.use({ trace: 'off', video: 'off' });

const PLAYER_KEY = 'brainrot-player-v1';
const BEFORE_IMPORT_KEY = 'brainrot-before-import-v1';
/** The fixture player monitor() seeds in the source profile. */
const SOURCE_SECRET = '01'.repeat(32);
/** The destination profile's own player, with progress, so Restore asks before replacing it. */
const DESTINATION_SECRET = 'cd'.repeat(32);
const DESTINATION_MARK = 'test-destination-seeded';
/** A player field the backup omits (see `clears` in saveFile.ts): the old player's copy must not survive the import. */
const RECOVERY_KEY = 'brainrot-collection-recovery-v1';
const DESTINATION_RECOVERY = JSON.stringify({ raw: 'destination-recovery-marker', player: null });

/**
 * A fresh, isolated profile (its own storage) whose player is not the source's and has opened packs.
 * The seed runs once: it wipes what monitor() seeded, whichever init script ran first, and marks the
 * profile so a later load (the reload after an import) keeps what storage holds by then.
 */
async function destination(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(({ secret, mark, origin, recoveryKey, recovery }) => {
    if (location.origin !== origin || localStorage.getItem(mark)) return;
    localStorage.clear();
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: secret, name: 'Destination player', nextNonce: 3, createdAt: 1 }));
    localStorage.setItem(recoveryKey, recovery);
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
    localStorage.setItem('brainrot-stats-v1', JSON.stringify({ packsOpened: 3, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
    localStorage.setItem(mark, 'yes');
  }, { secret: DESTINATION_SECRET, mark: DESTINATION_MARK, origin: new URL(baseURL).origin, recoveryKey: RECOVERY_KEY, recovery: DESTINATION_RECOVERY });
  const page = await context.newPage();
  const errors = await monitor(page, baseURL);
  // Nothing mines the next pack (and then prefetches its art) in the background: the import's reload
  // can't abort those requests, so any failed request is a real one.
  await holdTickets(page);
  return { context, page, errors };
}

test('a backup exported in one profile restores exactly in another, after a cancel and a refused file (#744)', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000);
  const folder = await mkdtemp(join(tmpdir(), 'brainrot-backup-'));
  try {
    // Source: open one real pack, as the pack opener smoke does.
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    const packShell = page.locator('.pack-shell');
    await expect(packShell).toBeVisible();
    await expectDecoded(packShell.locator('img'), 2);
    await page.getByRole('button', { name: 'Open pack', exact: true }).click();
    await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
    await page.locator('button.reveal-skip').click({ timeout: 15000 });
    await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
    await expectDecoded(page.locator('.summary-cards img'), 5);
    const opened = await expectRecordedPack(page);
    const sourcePlayer = await page.evaluate((key) => localStorage.getItem(key), PLAYER_KEY);

    // Export through Settings: the browser's own download, saved to a temporary file.
    await page.goto('./#/settings');
    const source = settingsOf(page);
    await expect(source.main).toBeVisible();
    const downloading = page.waitForEvent('download');
    await source.backUp.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^brainrot-tcg-save-\d{4}-\d{2}-\d{2}\.txt$/);
    const file = join(folder, download.suggestedFilename());
    await download.saveAs(file);
    await download.delete();
    await expect(source.backUp.locator('.settings-desc')).toHaveText('Backup downloaded — keep it private. It includes your secret player key.');

    // The file, read in memory: the format, identity, exact tickets, cards and modifiers.
    const text = await readFile(file, 'utf8');
    const backup = JSON.parse(text) as Record<string, unknown>;
    expect(backup).toMatchObject({ version: 2, dataVersion: 3 });
    expect(Number.isFinite(Date.parse(backup.exportedAt as string))).toBe(true);
    const filePlayer = JSON.parse(backup.player as string) as { secretKey: string; name: string; nextNonce: number };
    expect(filePlayer.secretKey === SOURCE_SECRET).toBe(true);
    expect(filePlayer).toMatchObject({ name: 'Browser smoke fixture', nextNonce: 1 });
    expect(JSON.parse(backup.stats as string)).toEqual(opened.stats);
    expect(JSON.parse(backup.collection as string)).toEqual(opened.collection);
    expect(JSON.parse(backup.history as string)).toEqual(opened.history);
    expect(errors).toEqual([]);

    const dest = await destination(browser, baseURL!);
    try {
      const target = dest.page;
      await target.goto(new URL('#/settings', baseURL).href);
      const restore = settingsOf(target);
      await expect(restore.main).toBeVisible();
      await expect(restore.restoreNote).toHaveText('Load a backup file');
      const untouched = await storageOf(target);
      expect(untouched[PLAYER_KEY]?.includes(DESTINATION_SECRET)).toBe(true);
      expect(untouched[RECOVERY_KEY] === DESTINATION_RECOVERY).toBe(true);

      // A damaged file (the backup cut short) is refused when read, and storage stays byte for byte.
      await pickWithImport(target, { name: 'cut-short.txt', buffer: Buffer.from(text.slice(0, Math.floor(text.length / 2))) });
      await expect(restore.restoreNote).toHaveText("Couldn't read that file. Is it a save exported from Save & backup?");
      await expect(restore.importButton).toBeVisible();
      expect(sameStorage(await storageOf(target), untouched)).toBe(true);

      // A file with a bad field asks first, like any other save; Replace then refuses it, changing nothing.
      const tampered = JSON.stringify({ ...backup, collection: JSON.stringify({ broken: { card: null, normalCount: 'two' } }) });
      await pickWithImport(target, { name: 'tampered.txt', buffer: Buffer.from(tampered) });
      await expect(restore.replace).toBeVisible();
      await restore.replace.click();
      await expect(restore.restoreNote).toHaveText('The collection in this save is invalid. Nothing was imported.');
      await expect(restore.importButton).toBeVisible();
      expect(sameStorage(await storageOf(target), untouched)).toBe(true);

      // The real backup: the replacement question names both saves; Keep mine changes nothing.
      const question = "Replace this browser's save (Destination player, 3 packs) with the file's (Browser smoke fixture, 1 pack)? Yours is kept as a backup.";
      await pickWithImport(target, file);
      await expect(restore.restoreNote).toHaveText(question);
      await restore.keep.click();
      await expect(restore.restoreNote).toHaveText('Kept your save.');
      await expect(restore.importButton).toBeVisible();
      expect(sameStorage(await storageOf(target), untouched)).toBe(true);

      // Picked again and accepted: the page reloads with the restored save.
      await pickWithImport(target, file);
      await expect(restore.restoreNote).toHaveText(question);
      const reloaded = target.waitForEvent('load');
      await restore.replace.click();
      await reloaded;
      await expect(restore.main).toBeVisible();
      await expect(restore.restoreNote).toHaveText('Load a backup file');

      // After the reload: the source's exact save under the source's identity, and nothing of the
      // destination player's mixed in. Their save is kept aside as the copy from before the import.
      await target.goto(new URL('#/profile', baseURL).href);
      const profile = target.getByRole('main', { name: 'Profile', exact: true });
      await expect(profile.getByRole('heading', { name: 'Browser smoke fixture', exact: true })).toBeVisible();
      await expect(profile).toContainText('All packs · 1');
      expect(await snapshot(target)).toEqual(opened);
      const restored = await storageOf(target);
      expect(restored[PLAYER_KEY] === sourcePlayer).toBe(true);
      expect(restored[PLAYER_KEY]?.includes(DESTINATION_SECRET)).toBe(false);
      expect(restored[BEFORE_IMPORT_KEY]?.includes(DESTINATION_SECRET)).toBe(true);
      // The backup carries no recovery archive (null), so the old player's is gone from the active save.
      expect(backup.collectionRecovery ?? null).toBeNull();
      expect(restored[RECOVERY_KEY] ?? null).toBeNull();
      expect(dest.errors).toEqual([]);
    } finally {
      await dest.context.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('an early backup without a player key restores into a new player through Import (#744)', async ({ page, baseURL }) => {
  // The first file format (version 1): no player identity, and a card under its legacy id, which
  // this app's migrations upgrade (genesis "image2" is Amogus). A new player has nothing to replace,
  // so it imports without a question, and the browser keeps its own identity.
  const early = JSON.stringify({
    version: 1, exportedAt: '2025-01-01T00:00:00Z',
    collection: JSON.stringify({ image2: { card: { id: 'image2' }, count: 2 } }),
    stats: '{"packsOpened":2,"holoCards":{}}', settings: '{"soundEnabled":false}',
    achievements: '{"first_pack":1}',
  });
  const errors = await monitor(page, baseURL!);
  await holdTickets(page);
  await page.goto('./#/settings');
  const restore = settingsOf(page);
  await expect(restore.main).toBeVisible();
  const player = await page.evaluate((key) => localStorage.getItem(key), PLAYER_KEY);
  expect(player?.includes(SOURCE_SECRET)).toBe(true);

  const reloaded = page.waitForEvent('load');
  await pickWithImport(page, { name: 'early-save.txt', buffer: Buffer.from(early) });
  await reloaded;
  await expect(restore.main).toBeVisible();
  await expect(restore.restoreNote).toHaveText('Load a backup file');

  await page.goto('./#/cards');
  await expect(page.getByRole('button', { name: /^Amogus, .*, 2 owned$/ })).toBeVisible();
  const { stats, collection } = await snapshot(page);
  expect(stats.packsOpened).toBe(2);
  expect(collection['genesis/amogus']).toMatchObject({ normalCount: 2, holoCount: 0 });
  const stored = await storageOf(page);
  expect(stored['brainrot-data-version']).toBe('3');
  expect(stored[PLAYER_KEY] === player).toBe(true);
  expect(errors).toEqual([]);
});

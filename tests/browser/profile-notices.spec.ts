import { test, expect } from '@playwright/test';
import { monitor, PLAYER_KEY_PREFIX } from './support';
import { STORAGE_KEYS } from '../../src/constants/config';

/**
 * Profile sections start folded, but a save or trust notice must never wait inside a closed one: a role=alert in a
 * closed fold is never announced. The saved packs failing to read opens Level and Card back and foil, and says so
 * in their headers.
 */

test('a failed read of the saved packs shows its alert, with the sections that hold it open', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  // Two packs whose cards this device lost (history keeps hand and score only), and a pack store that will not open.
  await page.addInitScript(({ keys, prefix }) => {
    if (sessionStorage.getItem('failed-read-seeded')) return;
    sessionStorage.setItem('failed-read-seeded', '1');
    const player = JSON.parse(localStorage.getItem('brainrot-player-v1')!) as { nextNonce: number };
    player.nextNonce = 2;
    localStorage.setItem('brainrot-player-v1', JSON.stringify(player));
    localStorage.setItem(keys.HISTORY, JSON.stringify([
      { s: 'right-now', v: 2, n: 1, k: prefix, h: 'Pair', x: 1_020, t: 2_000 },
      { s: 'right-now', v: 2, n: 0, k: prefix, h: 'Pair', x: 500, t: 1_000 },
    ]));
    localStorage.setItem('brainrot-data-version', '3');
    indexedDB.open = () => { throw new Error('Blocked by the test'); };
  }, { keys: STORAGE_KEYS, prefix: PLAYER_KEY_PREFIX });
  await page.goto('./#/profile');
  const profile = page.getByRole('main', { name: 'Profile', exact: true });
  await expect(profile.getByRole('heading', { name: 'Browser smoke fixture', exact: true })).toBeVisible();

  const alert = profile.getByRole('alert').filter({ hasText: "Couldn't read your saved packs on this device just now" });
  await expect(alert.first()).toBeVisible({ timeout: 15000 });
  // Level, stats and collection and Card back and foil each hold one, and each says so in its header.
  await expect(alert).toHaveCount(2);
  const level = profile.locator('.profile-fold').filter({ has: page.getByRole('heading', { name: 'Level, stats and collection', exact: true }) });
  await expect(level.locator('summary .profile-fold-note')).toHaveText("Couldn't read your saved packs");
  await expect(profile.locator('#rewards summary .profile-fold-note')).toHaveText("Couldn't read your saved packs");
  await expect(level.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(errors.filter((error) => !error.includes('Reading saved packs failed'))).toEqual([]);
});

test('Enter and Space on a section heading that has focus fold and unfold it', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await page.goto('./#/profile');
  const profile = page.getByRole('main', { name: 'Profile', exact: true });
  await expect(profile.getByRole('heading', { name: 'Browser smoke fixture', exact: true })).toBeVisible();
  const fold = profile.locator('#achievements > details');
  await expect(fold).not.toHaveJSProperty('open', true);
  // Script focus on the heading, as a retry or Show more leaves it.
  await profile.locator('#achievements h2').focus();
  await page.keyboard.press('Enter');
  await expect(fold).toHaveJSProperty('open', true);
  await page.keyboard.press('Space');
  await expect(fold).toHaveJSProperty('open', false);
  expect(errors).toEqual([]);
});

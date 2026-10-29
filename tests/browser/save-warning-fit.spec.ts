import { test, expect } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { monitor } from './support';

/**
 * Save warning banner on phone viewports with enlarged text (#1079):
 * When kept-aside recovery data is stored (with or without an unreadable player record),
 * the save warning banner above the header stays within a bounded height and scrolls inside itself,
 * so the pack screen, resting pack, and refusal actions remain reachable and on-screen.
 */

const ARCHIVE = JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null });
const DAMAGED_PLAYER = 'not-valid-json';

test.describe('save warning banner fit (#1079)', () => {
  test('at 200% text on a 360x740 phone, banner height is bounded and pack controls remain on screen', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    const origin = new URL(baseURL!).origin;

    await page.addInitScript(({ key, archive, origin }) => {
      if (window.location.origin !== origin) return;
      try {
        localStorage.setItem(key, archive);
      } catch { /* storage blocked */ }
    }, { key: STORAGE_KEYS.COLLECTION_RECOVERY, archive: ARCHIVE, origin });

    await page.goto('./');
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await page.evaluate(() => document.fonts.ready);

    const banner = page.locator('.save-warning[role="alert"]');
    await expect(banner).toBeVisible();

    const bannerBox = (await banner.boundingBox())!;
    // Banner height is bounded to at most 35dvh (~259px on 740px viewport), not 550px+
    expect(bannerBox.height).toBeLessThanOrEqual(740 * 0.35 + 2);

    // Banner is scrollable inside itself at 200% text
    const scrollInfo = await banner.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(scrollInfo.overflowY).toBe('auto');
    expect(scrollInfo.scrollHeight).toBeGreaterThan(scrollInfo.clientHeight);

    // Header and pack opener stage remain within the viewport
    const header = page.locator('.app-header');
    await expect(header).toBeVisible();
    const headerBox = (await header.boundingBox())!;
    expect(headerBox.y).toBeGreaterThanOrEqual(bannerBox.y + bannerBox.height - 1);
    expect(headerBox.y + headerBox.height).toBeLessThan(740);

    const packStage = page.locator('.app-main');
    await expect(packStage).toBeVisible();
    const packBox = (await packStage.boundingBox())!;
    expect(packBox.y).toBeLessThan(740);

    // No horizontal page scrolling
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(360);

    expect(errors).toEqual([]);
  });

  test('with unreadable player and 200% text, refusal button remains reachable and clickable', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    const origin = new URL(baseURL!).origin;

    await page.addInitScript(({ recoveryKey, playerKey, archive, player, origin }) => {
      if (window.location.origin !== origin) return;
      try {
        localStorage.setItem(recoveryKey, archive);
        localStorage.setItem(playerKey, player);
      } catch { /* storage blocked */ }
    }, {
      recoveryKey: STORAGE_KEYS.COLLECTION_RECOVERY,
      playerKey: 'brainrot-player-v1',
      archive: ARCHIVE,
      player: DAMAGED_PLAYER,
      origin,
    });

    await page.goto('./');
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await page.evaluate(() => document.fonts.ready);

    const banner = page.locator('.save-warning[role="alert"]');
    await expect(banner).toBeVisible();

    const bannerBox = (await banner.boundingBox())!;
    expect(bannerBox.height).toBeLessThanOrEqual(740 * 0.35 + 2);

    // Clicking "Open pack" triggers the refusal because player record is unreadable
    const openPackBtn = page.getByRole('button', { name: /Open pack/ });
    await expect(openPackBtn).toBeVisible();
    await openPackBtn.click();

    // Refusal button "Open Save & backup" is reachable and clickable (scrolling the home screen reaches it, #1079)
    const openSaveBtn = page.getByRole('button', { name: 'Open Save & backup' });
    await expect(openSaveBtn).toBeAttached();
    await openSaveBtn.scrollIntoViewIfNeeded();
    await expect(openSaveBtn).toBeVisible();

    // Clicking it navigates to Settings > Save & backup
    await openSaveBtn.click();
    await expect(page).toHaveURL(/#\/settings/);
    await expect(page.locator('.settings-panel').first()).toBeVisible();

    expect(errors).toEqual([expect.stringMatching(/^Could not open pack PlayerUnreadableError: The player record can't be read, so no ticket can be claimed/)]);
  });
});

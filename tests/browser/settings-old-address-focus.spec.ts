import { test, expect, type Page } from '@playwright/test';
import { createServer as listen } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

/**
 * Settings, From the old address (#978): the Replace question's Keep mine and Replace leave the row
 * with the answer, and the keyboard focus they held goes to Bring it, which stays in the row, not to
 * the page. The new address is this app served by Vite with VITE_OLD_ORIGIN set (the preview build has
 * none); the old address is a made-up origin whose routed page answers the popup with a save. Nothing
 * leaves the machine. Keyboard only, and every wait is on the row's own state.
 */
const OLD_ORIGIN = 'http://old.test';
const OLD_URL = `${OLD_ORIGIN}/BrainrotTCG/`;
// FULL_MOVE_NOTE (src/game/move.ts reads Vite's env as it loads, so it can't be imported here).
const FULL_NOTE = "This browser's storage is full, so nothing changed. Free up some space, then try again.";
const player = (hex: string) => JSON.stringify({ secretKey: hex.repeat(32), name: 'Combo Miner', nextNonce: 3, createdAt: 1 });
const COLLECTION = 'brainrot-found-collection-v1';
const OLD_SAVE = { 'brainrot-player-v1': player('aa'), 'brainrot-data-version': '3' };

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = listen();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});

let vite: ViteDevServer;
let NEW_URL: string;

test.describe('Settings: the old address Replace question hands the focus back', () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(120000);
    const port = await freePort();
    const env = { VITE_OLD_ORIGIN: process.env.VITE_OLD_ORIGIN, VITE_OLD_SITE_URL: process.env.VITE_OLD_SITE_URL };
    process.env.VITE_OLD_ORIGIN = OLD_ORIGIN;
    process.env.VITE_OLD_SITE_URL = OLD_URL;
    try {
      vite = await createServer({
        root: fileURLToPath(new URL('../../', import.meta.url)),
        base: '/BrainrotTCG/',
        clearScreen: false,
        logLevel: 'error',
        server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
      });
      await vite.listen();
    } finally {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    NEW_URL = `http://127.0.0.1:${port}/BrainrotTCG/`;
    // The first load makes Vite prepare dependencies; do it before any test is timed.
    const warm = await browser.newContext();
    const page = await warm.newPage();
    await page.goto(NEW_URL);
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 90000 });
    await warm.close();
  });

  test.afterAll(async () => {
    await vite?.close();
  });

  /** Settings with a different save already here, and an old address that answers the popup with its save. */
  async function openSettings(page: Page, { storageFull }: { storageFull: boolean }) {
    const origin = new URL(NEW_URL).origin;
    await page.addInitScript(({ here, collection }) => {
      if (location.origin !== here || localStorage.getItem('seeded')) return;
      localStorage.setItem('seeded', '1');
      localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: 'bb'.repeat(32), name: 'Combo Miner', nextNonce: 3, createdAt: 1 }));
      localStorage.setItem(collection, JSON.stringify({ 'genesis/amogus': { card: { id: 1, key: 'genesis/amogus' }, normalCount: 2, holoCount: 0 } }));
      localStorage.setItem('brainrot-data-version', '3');
    }, { here: origin, collection: COLLECTION });
    // The copy of this save that Replace takes first is the write the browser refuses.
    if (storageFull) {
      await page.addInitScript((here) => {
        if (location.origin !== here) return;
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === 'brainrot-before-move-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
          write.call(this, key, value);
        };
      }, origin);
    }
    await page.context().route(`${OLD_ORIGIN}/**`, (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>old</title><script>opener.postMessage({ type: 'brainrot-save', save: ${JSON.stringify(OLD_SAVE)} }, '*');</script>`,
    }));
    await page.goto(`${NEW_URL}#/settings`);
    const main = page.getByRole('main', { name: 'Settings', exact: true });
    await expect(main).toBeVisible({ timeout: 30000 });
    const row = main.locator('.settings-row').filter({ has: page.locator('.settings-label', { hasText: /^From the old address$/ }) });
    const bring = row.getByRole('button', { name: 'Bring it', exact: true });
    await bring.focus();
    await page.keyboard.press('Enter');
    // The question is asked in the row, and the safe answer holds the focus.
    const keepMine = row.getByRole('button', { name: 'Keep mine', exact: true });
    await expect(keepMine).toBeFocused({ timeout: 15000 });
    return { row, bring, keepMine, replace: row.getByRole('button', { name: 'Replace', exact: true }) };
  }

  test('Keep mine leaves the focus on Bring it', async ({ page }) => {
    test.setTimeout(90000);
    const { row, bring, keepMine } = await openSettings(page, { storageFull: false });
    await page.keyboard.press('Enter');
    await expect(row.locator('.settings-desc')).toHaveText('Kept the save you have here.');
    await expect(keepMine).toHaveCount(0);
    await expect(bring).toBeFocused();
  });

  test('a Replace that cannot be done leaves the focus on Bring it', async ({ page }) => {
    test.setTimeout(90000);
    const { row, bring, replace } = await openSettings(page, { storageFull: true });
    await replace.focus();
    await page.keyboard.press('Enter');
    await expect(row.locator('.settings-desc')).toHaveText(FULL_NOTE);
    await expect(replace).toHaveCount(0);
    await expect(bring).toBeFocused();
  });
});

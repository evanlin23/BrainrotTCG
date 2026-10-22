import { test, expect, type Browser } from '@playwright/test';
import { createServer as listen } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { redirectPage } from '../../scripts/redirect-site.ts';

/**
 * Bringing a save over from the old address (scripts/redirect-site.ts) into the new one
 * (receiveSave in src/game/move.ts), in real windows on two origins. The new address is this app,
 * served by Vite with VITE_OLD_ORIGIN set (the preview build has none); the old address is the
 * redirect page, served by routing a made-up origin. Nothing leaves the machine.
 */
const OLD_ORIGIN = 'http://old.test';
const OLD_URL = `${OLD_ORIGIN}/BrainrotTCG/`;
// FULL_MOVE_NOTE (src/game/move.ts reads Vite's env as it loads, so it can't be imported here).
const FULL_NOTE = "This browser's storage is full, so nothing changed. Free up some space, then try again.";
const PLAYER = JSON.stringify({ secretKey: 'ab'.repeat(32), name: 'Combo Miner', nextNonce: 3, createdAt: 1 });

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

test.describe('bringing a save from the old address', () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    if (testInfo.project.name !== 'desktop-chromium') return;
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
    // The first load makes Vite prepare dependencies; do it before any window is timed.
    const warm = await browser.newContext();
    await (await warm.newPage()).goto(NEW_URL);
    await expect((await warm.pages())[0].locator('#root')).not.toBeEmpty({ timeout: 90000 });
    await warm.close();
  });

  test.afterAll(async () => {
    await vite?.close();
  });

  /**
   * A context where the old address serves the redirect page, with an old save in its storage, and
   * the new address's storage refuses the player key (a full storage area) until `makeRoom`.
   * `leaving` is what happens to the old address's tab when it sends the player on: 'stays' cancels
   * that load, so the tab keeps its page; 'arrives' shows a stand-in, so the game doesn't start there.
   */
  const setUp = async (browser: Browser, leaving: 'stays' | 'arrives') => {
    const context = await browser.newContext();
    const newOrigin = new URL(NEW_URL).origin;
    await context.addInitScript((origin) => {
      if (location.origin !== origin) return;
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'brainrot-player-v1' && localStorage.getItem('test-room') !== 'yes') {
          throw new DOMException('Injected quota failure', 'QuotaExceededError');
        }
        write.call(this, key, value);
      };
    }, newOrigin);
    await context.route(`${OLD_ORIGIN}/**`, (route) => route.fulfill({
      contentType: 'text/html',
      body: new URL(route.request().url()).pathname.endsWith('/seed') ? '<!doctype html><title>seed</title>' : redirectPage(NEW_URL),
    }));
    const oldPage = await context.newPage();
    await oldPage.goto(`${OLD_URL}seed`);
    await oldPage.evaluate((player) => {
      localStorage.setItem('brainrot-player-v1', player);
      localStorage.setItem('brainrot-data-version', '3');
    }, PLAYER);
    await oldPage.route(`${NEW_URL}**`, (route) => (leaving === 'stays' ? route.abort('aborted')
      : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>arrived</title>' })));
    await oldPage.goto(OLD_URL);

    const popupOpened = oldPage.waitForEvent('popup');
    await oldPage.getByRole('button', { name: 'Bring my save and go' }).click();
    const popup = await popupOpened;
    await expect(popup.locator('#root')).toHaveText(FULL_NOTE);
    // The original save stays where it was.
    if (leaving === 'arrives') await oldPage.waitForURL(`${NEW_URL}**`);
    const makeRoom = () => popup.evaluate(() => localStorage.setItem('test-room', 'yes'));
    /** The save at the new address, read from a stand-in page there. */
    const savedThere = async () => {
      const reader = await context.newPage();
      await reader.route(`${NEW_URL}**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>read</title>' }));
      await reader.goto(NEW_URL);
      return reader.evaluate(() => localStorage.getItem('brainrot-player-v1'));
    };
    /** The old address's storage: its save, and whether it's marked moved. */
    const oldStorage = async () => {
      const reader = await context.newPage();
      await reader.goto(`${OLD_URL}seed`);
      return reader.evaluate(() => [localStorage.getItem('brainrot-player-v1'), !!localStorage.getItem('brainrot-moved-v1')]);
    };
    return { context, oldPage, popup, makeRoom, savedThere, oldStorage };
  };

  test('a retry after storage was full works in the popup that stayed open', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Two windows on two origins; the desktop project runs it.');
    const { context, oldPage, popup, makeRoom, savedThere, oldStorage } = await setUp(browser, 'stays');
    expect(await savedThere()).toBeNull();
    expect(await oldStorage()).toEqual([PLAYER, false]);

    // Room again, and the player taps Bring once more: the same named window, and only its fragment
    // changes (#/receive again), so nothing loads and main.tsx doesn't run again.
    await makeRoom();
    let loads = 0;
    popup.on('load', () => { loads += 1; });
    let popups = 0;
    oldPage.on('popup', () => { popups += 1; });
    const closed = popup.waitForEvent('close', { timeout: 20000 });
    await oldPage.getByRole('button', { name: 'Bring my save and go' }).click();
    await closed;
    expect([popups, loads]).toEqual([0, 0]);
    expect(await savedThere()).toBe(PLAYER);
    expect(await oldStorage()).toEqual([PLAYER, true]);
    await context.close();
  });

  test('a retry from an old link, once the tab went on, brings the save over', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Two windows on two origins; the desktop project runs it.');
    const { context, oldPage, makeRoom, savedThere, oldStorage } = await setUp(browser, 'arrives');
    await makeRoom();
    // Following an old link from where the tab went. Whether the browser finds the named window
    // that stayed open from here or opens another, the save comes over.
    await Promise.all([oldPage.waitForURL(OLD_URL), oldPage.evaluate((url) => { location.href = url; }, OLD_URL)]);
    await oldPage.getByRole('button', { name: 'Bring my save and go' }).click();
    await oldPage.waitForURL(`${NEW_URL}**`);
    expect(await savedThere()).toBe(PLAYER);
    expect(await oldStorage()).toEqual([PLAYER, true]);
    await context.close();
  });
});

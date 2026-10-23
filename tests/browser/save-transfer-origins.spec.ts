import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as listen, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview, type PreviewServer } from 'vite';
import { redirectPage } from '../../scripts/redirect-site.ts';
import { monitor, type MonitorErrors } from './support';

/**
 * The save hand-over between the site's old address and its new one (docs/HOSTING.md), with both
 * sides real and on two local origins, as the deploy sets them up after a move:
 * - the old address is the forwarding page scripts/redirect-site.ts generates, served for
 *   http://127.0.0.1:<port>/BrainrotTCG/ as GitHub Pages serves it;
 * - the new address is this app, built for the root with VITE_OLD_ORIGIN and VITE_OLD_SITE_URL
 *   naming that old address (the deploy's Cloudflare build), served at http://localhost:<port>/;
 * - a third local origin stands in for any other site.
 * The network guard allows those three origins, each under its own path only, and nothing else.
 * Every save here is a disposable fixture: its keys read 7e57 ("test") and nothing is published.
 *
 * Pop-up blocking is simulated (window.open returns null, as a browser's blocker makes it do); this
 * is browser pop-up behaviour in Chromium, not a check of how a real phone handles pop-ups.
 * The quota failures each step can meet are module tests (src/game/move.test.ts), not repeated here.
 */

// Traces and videos would keep the fixture keys these tests type into pages; nothing is kept.
test.use({ trace: 'off', video: 'off' });

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OLD_BASE = '/BrainrotTCG/';
const OLD_SECRET = '7e57'.repeat(16);
const HERE_SECRET = '7e5700aa'.repeat(8);
const PLAYER = 'brainrot-player-v1';
const COLLECTION = 'brainrot-found-collection-v1';
const STATS = 'brainrot-stats-v1';
const VERSION = 'brainrot-data-version';
const STAMP = 'brainrot-save-stamp-v1';
const MOVED = 'brainrot-moved-v1';
const BACKUP = 'brainrot-before-move-v1';
const RECEIVING = 'Bringing your save over…';
const BRING = 'Bring my save and go';

type Storage = Record<string, string>;
const player = (secretKey: string, name: string, nextNonce: number) => JSON.stringify({ secretKey, name, nextNonce, createdAt: 1 });
const collection = (normalCount: number) => JSON.stringify({ 'genesis/amogus': { card: { id: 'amogus', key: 'genesis/amogus' }, normalCount, holoCount: 1 } });
const stats = (packsOpened: number) => JSON.stringify({ packsOpened, holoCards: {}, highestPackValue: 0, highestPackCards: [] });

/** The save at the old address: what is handed over, less its stamp (the new browser gets its own). */
const OLD_SAVE: Storage = {
  [PLAYER]: player(OLD_SECRET, 'Old address fixture', 4),
  [COLLECTION]: collection(3),
  [STATS]: stats(4),
  [VERSION]: '3',
  [STAMP]: 'old-address-stamp',
};
/** Also at the old address and never handed over: its own backup, and a key that isn't the game's. */
const OLD_EXTRAS: Storage = { [BACKUP]: JSON.stringify({ [PLAYER]: player('7e57'.repeat(15) + '0001', 'Older fixture', 1) }), 'not-the-game': 'left alone' };
const OLD_STORAGE = { ...OLD_SAVE, ...OLD_EXTRAS };
const { [STAMP]: oldStamp, ...HANDED_OVER } = OLD_SAVE;
/** A different save with progress already at the new address. */
const HERE_SAVE: Storage = {
  [PLAYER]: player(HERE_SECRET, 'New address fixture', 2),
  [COLLECTION]: collection(1),
  [STATS]: stats(2),
  [VERSION]: '3',
  [STAMP]: 'new-address-stamp',
};
/** What may never show up in a request, a URL, a console line or a header. */
const SENSITIVE = [OLD_SECRET, HERE_SECRET, '7e57'.repeat(15), 'secretKey', PLAYER];

/** Holds a free port while the app builds for it; `release` frees it just before the app takes it. */
const reservePort = () => new Promise<{ port: number; release: () => Promise<void> }>((resolve, reject) => {
  const server = listen();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as AddressInfo).port,
    release: () => new Promise<void>((done) => server.close(() => done())),
  }));
});
const serve = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});

let OLD_ORIGIN = '';
let OLD_URL = '';
let NEW_ORIGIN = '';
let NEW_URL = '';
let THIRD_ORIGIN = '';
let THIRD_URL = '';
let oldServer: Server;
let thirdServer: Server;
let app: PreviewServer;
let outDir = '';

test.beforeAll(async () => {
  test.setTimeout(240000);
  // The old address, as the deploy publishes it: index.html at its base, and the same page as
  // 404.html (which GitHub Pages serves, with a 404, for every other path).
  oldServer = createHttpServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', OLD_ORIGIN);
    res.writeHead(pathname === OLD_BASE || pathname === `${OLD_BASE}index.html` ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(redirectPage(NEW_URL, OLD_BASE));
  });
  thirdServer = createHttpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Another site</title><p>Another site</p></html>');
  });
  OLD_ORIGIN = `http://127.0.0.1:${await serve(oldServer)}`;
  OLD_URL = `${OLD_ORIGIN}${OLD_BASE}`;
  THIRD_ORIGIN = `http://127.0.0.1:${await serve(thirdServer)}`;
  THIRD_URL = `${THIRD_ORIGIN}/fixture/`;
  const { port, release } = await reservePort();
  NEW_ORIGIN = `http://localhost:${port}`;
  NEW_URL = `${NEW_ORIGIN}/`;

  // The deploy's build after a move (.github/workflows/deploy.yml), for this machine's addresses.
  outDir = mkdtempSync(join(tmpdir(), 'brainrot-two-origins-'));
  const env: Record<string, string> = { VITE_OLD_ORIGIN: OLD_ORIGIN, VITE_OLD_SITE_URL: OLD_URL, SITE_URL: NEW_URL, VITE_STAGING_HOST_SUFFIX: '' };
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    await build({ root: ROOT, base: '/', logLevel: 'error', build: { outDir, emptyOutDir: true } });
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await release();
  }
  app = await preview({ root: ROOT, base: '/', logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port, strictPort: true } });
});

test.afterAll(async () => {
  await app?.close();
  await new Promise((resolve) => oldServer?.close(resolve));
  await new Promise((resolve) => thirdServer?.close(resolve));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

/** Everything that left a page: request URLs, headers and bodies, page URLs, console lines. */
let seen: string[] = [];
let errors: MonitorErrors | undefined;

test.afterEach(() => {
  expect(seen.filter((text) => SENSITIVE.some((secret) => text.includes(secret)))).toEqual([]);
  expect(errors ?? []).toEqual([]);
  seen = [];
  errors = undefined;
});

/** The context with these saves in place, guarded, and every request and page URL recorded. */
async function setUp(page: Page, saves: { old?: Storage; here?: Storage }) {
  const context = page.context();
  const origins = [[OLD_ORIGIN, saves.old], [NEW_ORIGIN, saves.here]] as const;
  await context.setStorageState({
    cookies: [],
    origins: origins.flatMap(([origin, save]) => (save ? [{ origin, localStorage: Object.entries(save).map(([name, value]) => ({ name, value })) }] : [])),
  });
  errors = await monitor(page, NEW_URL, 0, { localOrigins: { [OLD_ORIGIN]: [OLD_BASE], [THIRD_ORIGIN]: ['/fixture/'] } });
  context.on('request', (request) => {
    seen.push(request.url(), decodeURIComponent(request.url()), ...Object.values(request.headers()), request.postData() ?? '');
  });
  context.on('console', (message) => seen.push(message.text()));
  const watch = (p: Page) => p.on('framenavigated', (frame) => seen.push(frame.url()));
  watch(page);
  context.on('page', watch);
}

/** The storage at one origin, read live. */
const storageAt = async (context: BrowserContext, origin: string): Promise<Storage> => Object.fromEntries(
  (await context.storageState()).origins.find((o) => o.origin === origin)?.localStorage.map(({ name, value }) => [name, value]) ?? [],
);
const game = (save: Storage) => Object.fromEntries(Object.entries(save).filter(([key]) => key.startsWith('brainrot-')));
const notGame = (save: Storage) => Object.fromEntries(Object.entries(save).filter(([key]) => !key.startsWith('brainrot-')));

/** When this page goes on to the new address, a stand-in arrives there, so the game doesn't start on top of the result. */
const standInAtNewAddress = (page: Page) => page.route((url) => url.origin === NEW_ORIGIN, (route) => (route.request().isNavigationRequest()
  ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Arrived</title>' })
  : route.fallback()));

/** Resolves when the window closes, also when it already has. */
const closing = (popup: Page) => (popup.isClosed() ? Promise.resolve() : new Promise<void>((resolve) => popup.once('close', () => resolve())));

type Heard = { origin: string; type?: string; probe?: string; result?: string; fromOpener: boolean };
type Probe = Window & { heard?: Heard[]; waiting?: Record<string, Promise<Heard>> };

/**
 * Starts listening in `target` for the first message whose `type` or `probe` is `key` (await it with
 * `heard`), and logs every message it hears (`allHeard`). Listeners added after the page's own see
 * each message after it, so once one is heard here the page has already handled it.
 */
const listenFor = (target: Page, key: string) => target.evaluate((k) => {
  const w = window as Probe;
  const read = (e: MessageEvent): Heard => {
    const data = (e.data && typeof e.data === 'object' ? e.data : {}) as Partial<Heard>;
    return { origin: e.origin, type: data.type, probe: data.probe, result: data.result, fromOpener: !!opener && e.source === opener };
  };
  if (!w.heard) {
    const log: Heard[] = [];
    w.heard = log;
    addEventListener('message', (e) => log.push(read(e)));
  }
  w.waiting ??= {};
  w.waiting[k] = new Promise((resolve) => {
    const hear = (e: MessageEvent) => {
      const message = read(e);
      if (message.type !== k && message.probe !== k) return;
      removeEventListener('message', hear);
      resolve(message);
    };
    addEventListener('message', hear);
  });
}, key);
const heard = (target: Page, key: string) => target.evaluate((k) => (window as Probe).waiting![k], key);
const allHeard = (target: Page) => target.evaluate(() => (window as Probe).heard ?? []);

/**
 * `from` sends `probe` to its opener, from the same window as anything it sent before, so once the
 * opener hears it, it has heard (or the browser has dropped) all of those.
 */
const roundTrip = async (from: Page, opener: Page, probe: string) => {
  await listenFor(opener, probe);
  await from.evaluate((p) => (window.opener as Window).postMessage({ probe: p }, '*'), probe);
  return heard(opener, probe);
};

const settingsRow = async (page: Page) => {
  await page.goto(`${NEW_URL}#/settings`);
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main).toBeVisible({ timeout: 30000 });
  const row = main.locator('.settings-row').filter({ has: page.locator('.settings-label', { hasText: /^From the old address$/ }) });
  return { row, note: row.locator('.settings-desc'), bring: row.getByRole('button', { name: 'Bring it', exact: true }) };
};

test.describe('the old address brings its save to the new one', () => {
  test('into a browser with no save: everything comes over, and the old address keeps its copy', async ({ page }) => {
    await setUp(page, { old: OLD_STORAGE });
    await standInAtNewAddress(page);
    await page.goto(OLD_URL);
    const popupOpened = page.waitForEvent('popup');
    await page.getByRole('button', { name: BRING }).click();
    const popup = await popupOpened;
    // The new window takes the save, closes, and the old tab goes on to the new address, no fragment.
    await Promise.all([closing(popup), page.waitForURL(NEW_URL)]);
    const here = await storageAt(page.context(), NEW_ORIGIN);
    expect(here).toEqual({ ...HANDED_OVER, [STAMP]: expect.any(String) });
    expect(here[STAMP]).not.toBe(oldStamp);
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual({ ...OLD_STORAGE, [MOVED]: expect.any(String) });
  });

  test('to a browser that already has this player: nothing is written', async ({ page }) => {
    const sameHere = { [PLAYER]: OLD_SAVE[PLAYER], [VERSION]: '3', [STAMP]: 'new-address-stamp' };
    await setUp(page, { old: OLD_STORAGE, here: sameHere });
    await standInAtNewAddress(page);
    await page.goto(OLD_URL);
    const popupOpened = page.waitForEvent('popup');
    await page.getByRole('button', { name: BRING }).click();
    const popup = await popupOpened;
    await Promise.all([closing(popup), page.waitForURL(NEW_URL)]);
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual(sameHere);
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual({ ...OLD_STORAGE, [MOVED]: expect.any(String) });
  });

  for (const answer of ['keep', 'replace'] as const) {
    test(`over a different save with progress, answering ${answer}`, async ({ page }) => {
      await setUp(page, { old: OLD_STORAGE, here: HERE_SAVE });
      const asked: string[] = [];
      page.context().on('dialog', (dialog) => {
        asked.push(`${dialog.type()}: ${dialog.message()}`);
        void (answer === 'replace' ? dialog.accept() : dialog.dismiss());
      });
      await standInAtNewAddress(page);
      await page.goto(OLD_URL);
      const popupOpened = page.waitForEvent('popup');
      await page.getByRole('button', { name: BRING }).click();
      const popup = await popupOpened;
      await Promise.all([closing(popup), page.waitForURL(NEW_URL)]);
      expect(asked).toEqual(['confirm: Bring over your save from the old Brainrot TCG address? It replaces the save in this browser now (that one is kept as a backup).']);
      const here = await storageAt(page.context(), NEW_ORIGIN);
      const old = await storageAt(page.context(), OLD_ORIGIN);
      if (answer === 'keep') {
        expect(here).toEqual(HERE_SAVE);
        // Kept: the old address still offers its save next time.
        expect(old).toEqual(OLD_STORAGE);
      } else {
        expect(here).toEqual({ ...HANDED_OVER, [STAMP]: expect.any(String), [BACKUP]: expect.any(String) });
        expect(JSON.parse(here[BACKUP])).toEqual(HERE_SAVE);
        expect(old).toEqual({ ...OLD_STORAGE, [MOVED]: expect.any(String) });
      }
    });
  }
});

test.describe("the new address's Settings fetches the old save", () => {
  test('over a different save with progress: Replace keeps a backup of it', async ({ page }) => {
    await setUp(page, { old: OLD_STORAGE, here: HERE_SAVE });
    const { row, note, bring } = await settingsRow(page);
    await bring.click();
    await expect(note).toHaveText('This browser has a different save. Replace it with the old one? The one here is kept as a backup.', { timeout: 15000 });
    // Asking wrote nothing. The page reloads after Replace; a stand-in arrives instead of the game.
    const before = await storageAt(page.context(), NEW_ORIGIN);
    expect(before[PLAYER]).toBe(HERE_SAVE[PLAYER]);
    await standInAtNewAddress(page);
    await row.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(page).toHaveTitle('Arrived');
    const here = await storageAt(page.context(), NEW_ORIGIN);
    expect(here).toEqual({ ...notGame(before), ...HANDED_OVER, [STAMP]: expect.any(String), [BACKUP]: expect.any(String) });
    expect(here[STAMP]).not.toBe(oldStamp);
    expect(JSON.parse(here[BACKUP])).toEqual(game(before));
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual(OLD_STORAGE);
  });

  test('over a different save with progress: Keep mine changes nothing here', async ({ page }) => {
    await setUp(page, { old: OLD_STORAGE, here: HERE_SAVE });
    const { row, note, bring } = await settingsRow(page);
    await bring.click();
    const keep = row.getByRole('button', { name: 'Keep mine', exact: true });
    await expect(keep).toBeVisible({ timeout: 15000 });
    const before = await storageAt(page.context(), NEW_ORIGIN);
    await keep.click();
    await expect(note).toHaveText('Kept the save you have here.');
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual(before);
    expect(before[PLAYER]).toBe(HERE_SAVE[PLAYER]);
    // Sending isn't arriving: the old address keeps its save and doesn't mark it moved (#1035).
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual(OLD_STORAGE);
  });

  test('when this player is already here: it says so and writes nothing', async ({ page }) => {
    await setUp(page, { old: OLD_STORAGE, here: { [PLAYER]: OLD_SAVE[PLAYER], [VERSION]: '3', [STAMP]: 'new-address-stamp' } });
    const { note, bring } = await settingsRow(page);
    const before = await storageAt(page.context(), NEW_ORIGIN);
    await bring.click();
    await expect(note).toHaveText('Your save from the old address is already here.', { timeout: 15000 });
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual(before);
  });
});

test.describe('messages from anyone else hand nothing over', () => {
  test('another site can neither hand a save in nor get one out', async ({ page }) => {
    await setUp(page, { old: OLD_STORAGE });
    await page.goto(THIRD_URL);
    await listenFor(page, 'never');
    // It opens the new address's receiver itself, so the receiver's "ready" goes to the old origin only.
    const receiverOpened = page.waitForEvent('popup');
    await page.evaluate((url) => { window.open(url, 'brainrot-receive', 'popup'); }, `${NEW_URL}#/receive`);
    const receiver = await receiverOpened;
    // The receiver gives up after 15s with nothing (receiveSave, src/game/move.ts) and the game starts
    // there; its checks below run within about a second of it opening, so well inside that.
    await expect(receiver.locator('#root')).toHaveText(RECEIVING);
    await listenFor(receiver, 'stranger');
    await page.evaluate((save) => {
      window.open('', 'brainrot-receive')!.postMessage({ type: 'brainrot-save', probe: 'stranger', save }, '*');
    }, OLD_SAVE);
    expect(await heard(receiver, 'stranger')).toMatchObject({ origin: THIRD_ORIGIN, fromOpener: true });
    await expect(receiver.locator('#root')).toHaveText(RECEIVING);
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual({});
    expect((await roundTrip(receiver, page, 'after-receiver')).origin).toBe(NEW_ORIGIN);

    // It opens the old address's #/send: the save is addressed to the new origin only, so it never arrives.
    const senderOpened = page.waitForEvent('popup');
    await page.evaluate((url) => { window.open(url, 'brainrot-send', 'popup'); }, `${OLD_URL}#/send`);
    const sender = await senderOpened;
    await expect(sender.locator('#status')).toHaveText(`Sent to ${new URL(NEW_URL).host}. You can close this window.`);
    expect((await roundTrip(sender, page, 'after-sender')).origin).toBe(OLD_ORIGIN);
    expect((await allHeard(page)).map((m) => m.type ?? m.probe)).toEqual(['after-receiver', 'after-sender']);
    // Whatever another site does, the old address keeps its save, and it doesn't mark it moved, since
    // nothing arrived (#1035).
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual(OLD_STORAGE);
  });

  /**
   * The old address's tab, with the receiver open but Bring not tapped, so its page isn't answering yet.
   * The receiver gives up after 15s with nothing (receiveSave, src/game/move.ts); the tests using it
   * reach Bring within about a second of it opening, so well inside that.
   */
  const openReceiverFromOldAddress = async (page: Page) => {
    await standInAtNewAddress(page);
    await page.goto(OLD_URL);
    await expect(page.getByRole('button', { name: BRING })).toBeVisible();
    const receiverOpened = page.waitForEvent('popup');
    // The same window name and address the page's Bring button opens.
    await page.evaluate((url) => { window.open(url, 'brainrot-receive', 'popup,width=440,height=360'); }, `${NEW_URL}#/receive`);
    const receiver = await receiverOpened;
    await expect(receiver.locator('#root')).toHaveText(RECEIVING);
    return receiver;
  };

  /** Tapping Bring now reuses the receiver window, restarts its handshake, and the save comes over. */
  const bringIntoOpenReceiver = async (page: Page, receiver: Page) => {
    const closed = closing(receiver);
    await page.getByRole('button', { name: BRING }).click();
    await Promise.all([closed, page.waitForURL(NEW_URL)]);
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual({ ...HANDED_OVER, [STAMP]: expect.any(String) });
  };

  test('a window of the old origin that did not open the receiver is ignored', async ({ page }) => {
    await setUp(page, { old: OLD_STORAGE });
    const receiver = await openReceiverFromOldAddress(page);
    await listenFor(receiver, 'sibling');
    // A second window of the old origin (about:blank inherits it) posts the save to the receiver.
    await page.evaluate(({ origin, save }) => {
      const target = window.open('', 'brainrot-receive')!;
      const other = window.open('about:blank', 'not-the-opener')! as Window & { target?: Window };
      other.target = target;
      const script = other.document.createElement('script');
      script.textContent = `target.postMessage(${JSON.stringify({ type: 'brainrot-save', probe: 'sibling', save })}, ${JSON.stringify(origin)});`;
      other.document.body.append(script);
    }, { origin: NEW_ORIGIN, save: OLD_SAVE });
    expect(await heard(receiver, 'sibling')).toEqual({ origin: OLD_ORIGIN, type: 'brainrot-save', probe: 'sibling', fromOpener: false });
    await expect(receiver.locator('#root')).toHaveText(RECEIVING);
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual({});
    await bringIntoOpenReceiver(page, receiver);
  });

  test('malformed messages from the opener import nothing', async ({ page }) => {
    await setUp(page, { old: OLD_STORAGE });
    const receiver = await openReceiverFromOldAddress(page);
    await listenFor(page, 'brainrot-move-result');
    const bad = { [PLAYER]: player('not-a-key', 'Malformed fixture', 1), [VERSION]: '3' };
    await page.evaluate(({ origin, save }) => {
      const target = window.open('', 'brainrot-receive')!;
      // Not a message at all, the wrong type, then a save whose player key is no key.
      for (const message of ['brainrot-save', null, { type: 'brainrot-ready' }, { type: 'brainrot-save', save }]) target.postMessage(message, origin);
    }, { origin: NEW_ORIGIN, save: bad });
    expect(await heard(page, 'brainrot-move-result')).toEqual({ origin: NEW_ORIGIN, type: 'brainrot-move-result', result: 'invalid', fromOpener: false });
    await expect(receiver.locator('#root')).toHaveText('Nothing was changed. You can close this window.');
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual({});
    await bringIntoOpenReceiver(page, receiver);
  });

  test("Settings takes a save only from the old address's window it opened", async ({ page }) => {
    // No save here yet (the guard's fixture guest), so the first save Settings accepts is imported at
    // once: had it taken a stranger's, that would be in storage and its window would have closed.
    await setUp(page, { old: OLD_STORAGE });
    const stranger = { [PLAYER]: player('7e57beef'.repeat(8), 'Stranger fixture', 9), [VERSION]: '3' };
    // The window's first page at the old address answers nothing, and holds another old-address window.
    let quiet = true;
    await page.context().route((url) => url.origin === OLD_ORIGIN, (route) => {
      if (!route.request().isNavigationRequest()) return route.fallback();
      if (new URL(route.request().url()).pathname === `${OLD_BASE}other`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Another old-address window</title>' });
      if (!quiet) return route.fallback();
      quiet = false;
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Old address, quiet</title><iframe name="other" src="${OLD_URL}other"></iframe>` });
    });
    const { bring } = await settingsRow(page);
    const before = await storageAt(page.context(), NEW_ORIGIN);
    await standInAtNewAddress(page);
    const popupOpened = page.waitForEvent('popup');
    await bring.click();
    const popup = await popupOpened;
    await expect(popup).toHaveTitle('Old address, quiet');
    await popup.waitForLoadState('load');
    // Settings gives up after 20s (fetchOldSave, src/game/move.ts); from here to the real save
    // takes about a second, and the page's own steps don't depend on a timer.
    await listenFor(page, 'from-old-other');
    await listenFor(page, 'from-third');

    // The old origin, from a window that is not the one Settings opened.
    await popup.frame({ name: 'other' })!.evaluate((save) => {
      (window.parent.opener as Window).postMessage({ type: 'brainrot-save', probe: 'from-old-other', save }, '*');
    }, stranger);
    expect(await heard(page, 'from-old-other')).toEqual({ origin: OLD_ORIGIN, type: 'brainrot-save', probe: 'from-old-other', fromOpener: false });
    // The window Settings opened, gone on to another site.
    await popup.goto(THIRD_URL);
    await popup.evaluate((save) => {
      (window.opener as Window).postMessage({ type: 'brainrot-save', probe: 'from-third', save }, '*');
    }, stranger);
    expect(await heard(page, 'from-third')).toEqual({ origin: THIRD_ORIGIN, type: 'brainrot-save', probe: 'from-third', fromOpener: false });
    expect(popup.isClosed()).toBe(false);
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual(before);

    // Back at the old address, the same window sends the real save, and only that one comes in.
    const closed = closing(popup);
    await popup.evaluate((url) => { location.assign(url); }, `${OLD_URL}#/send`);
    await Promise.all([closed, expect(page).toHaveTitle('Arrived')]);
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual({ ...before, ...HANDED_OVER, [STAMP]: expect.any(String) });
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual(OLD_STORAGE);
  });
});

test.describe('a pop-up that was blocked or closed, then tapped again (simulated browser pop-up behaviour)', () => {
  /** window.open at `origin` returns null the first time, as a pop-up blocker makes it. */
  const blockFirstPopup = (page: Page, origin: string) => page.context().addInitScript((at) => {
    if (location.origin !== at) return;
    const open = window.open.bind(window);
    let refusals = 1;
    window.open = (...args: Parameters<typeof window.open>) => {
      if (refusals > 0) {
        refusals -= 1;
        return null;
      }
      return open(...args);
    };
  }, origin);

  test('Bring my save, blocked, then again', async ({ page }) => {
    await setUp(page, { old: OLD_STORAGE });
    await blockFirstPopup(page, OLD_ORIGIN);
    await standInAtNewAddress(page);
    await page.goto(OLD_URL);
    let popups = 0;
    page.on('popup', () => { popups += 1; });
    await page.getByRole('button', { name: BRING }).click();
    await expect(page.locator('#status')).toHaveText('Your browser blocked the window. Allow pop-ups for this page, then tap again.');
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual(OLD_STORAGE);
    const popupOpened = page.waitForEvent('popup');
    await page.getByRole('button', { name: BRING }).click();
    const popup = await popupOpened;
    await Promise.all([closing(popup), page.waitForURL(NEW_URL)]);
    expect(popups).toBe(1);
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual({ ...HANDED_OVER, [STAMP]: expect.any(String) });
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual({ ...OLD_STORAGE, [MOVED]: expect.any(String) });
  });

  test('Bring my save, dismissed and then left loading, then again', async ({ page }) => {
    await setUp(page, { old: OLD_STORAGE });
    // The first two windows get a page that never says it is ready (still loading, or it gave up).
    let stalled = 0;
    await page.context().route((url) => url.origin === NEW_ORIGIN, (route) => {
      if (stalled >= 2 || !route.request().isNavigationRequest()) return route.fallback();
      stalled += 1;
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Still loading</title>' });
    });
    await standInAtNewAddress(page);
    await page.goto(OLD_URL);
    // The player closes the first window themselves.
    const firstOpened = page.waitForEvent('popup');
    await page.getByRole('button', { name: BRING }).click();
    const first = await firstOpened;
    await expect(first).toHaveTitle('Still loading');
    await first.close();
    // The old page says the transfer didn't finish 15s after a tap (scripts/redirect-site.ts); this
    // is checked within about a second of the tap, so well inside that.
    await expect(page.locator('#status')).toHaveText(RECEIVING);
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual({});
    // The second is left open; tapping again closes it and opens a fresh one.
    const secondOpened = page.waitForEvent('popup');
    await page.getByRole('button', { name: BRING }).click();
    const second = await secondOpened;
    await expect(second).toHaveTitle('Still loading');
    const thirdOpened = page.waitForEvent('popup');
    await Promise.all([closing(second), page.getByRole('button', { name: BRING }).click()]);
    const third = await thirdOpened;
    await Promise.all([closing(third), page.waitForURL(NEW_URL)]);
    expect(stalled).toBe(2);
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual({ ...HANDED_OVER, [STAMP]: expect.any(String) });
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual({ ...OLD_STORAGE, [MOVED]: expect.any(String) });
  });

  test("Settings' Bring it, blocked, then again", async ({ page }) => {
    // No save here yet: the guard's fixture guest, with no progress, is replaced without asking.
    await setUp(page, { old: OLD_STORAGE });
    await blockFirstPopup(page, NEW_ORIGIN);
    const { note, bring } = await settingsRow(page);
    await bring.click();
    await expect(note).toHaveText('Your browser blocked the window. Allow pop-ups for this site, then try again.');
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual(OLD_STORAGE);
    const before = await storageAt(page.context(), NEW_ORIGIN);
    await standInAtNewAddress(page);
    const popupOpened = page.waitForEvent('popup');
    await bring.click();
    await closing(await popupOpened);
    await expect(page).toHaveTitle('Arrived');
    expect(await storageAt(page.context(), NEW_ORIGIN)).toEqual({ ...before, ...HANDED_OVER, [STAMP]: expect.any(String) });
    expect(await storageAt(page.context(), OLD_ORIGIN)).toEqual(OLD_STORAGE);
  });
});

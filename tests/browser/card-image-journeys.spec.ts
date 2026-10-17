import { readdirSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { monitor, expectDecoded, holdArt, routeArt, unexpectedArtErrors } from './support';

/**
 * Card art journeys in the collection grid (#226): art that fails, art that is slow, and a page that is
 * resized or sent to the background while art is still loading. A tile is never left blank: it shows
 * art, the loading placeholder, or the failed slot, and it keeps the same box in all three. Every wait
 * is on a tile's state with a bounded timeout, never on time.
 *
 * The fixture is a saved collection of one whole set, one card of it with a Gold finish (so its tile
 * asks for a finish thumbnail first), written by an init script the way monitor() seeds a player.
 * Nothing is sent anywhere: cross-origin traffic is already answered with an empty 204.
 */

const SET = 'right-now';
const ids = readdirSync(new URL(`../../src/content/sets/${SET}/cards/`, import.meta.url))
  .filter((file) => file.endsWith('.webp'))
  .map((file) => file.slice(0, -'.webp'.length));

async function seedCollection(page: Page, baseURL: string) {
  const collection = Object.fromEntries(ids.map((id, index) => {
    const key = `${SET}/${id}`;
    return [key, { card: { id, key, setId: SET }, normalCount: 1, holoCount: 0, ...(index === 0 ? { finishes: { GOLD: 1 } } : {}) }];
  }));
  await page.addInitScript(({ storageKey, collection, origin }) => {
    if (window.location.origin !== origin) return;
    if (localStorage.getItem(storageKey)) return;
    localStorage.setItem(storageKey, JSON.stringify(collection));
    // Current data version: the one-time migrations would otherwise rewrite the finish away.
    localStorage.setItem('brainrot-data-version', '3');
  }, { storageKey: STORAGE_KEYS.COLLECTION, collection, origin: new URL(baseURL).origin });
}

async function openCollection(page: Page, baseURL: string) {
  const errors = await monitor(page, baseURL, 0, { returning: true });
  await seedCollection(page, baseURL);
  return errors;
}

async function showCollection(page: Page) {
  await page.goto('./#/cards');
  const main = page.getByRole('main', { name: 'Cards', exact: true });
  await expect(main.locator('.collection-grid').first()).toBeVisible();
  const tiles = main.locator('.collection-grid button.collection-item img.card-image');
  await expect(tiles).toHaveCount(ids.length);
  return { main, tiles };
}

interface Tile { state: string; shown: boolean; width: number; height: number; x: number; y: number }

/** What a player sees of each tile: its state, whether that state draws something, and its box. */
const tileFacts = (tiles: Locator) => tiles.evaluateAll((images) => (images as HTMLImageElement[]).map((img): Tile => {
  const box = img.getBoundingClientRect();
  const state = img.dataset.state ?? '';
  const background = getComputedStyle(img).backgroundImage;
  const shown = state === 'ready' ? img.complete && img.naturalWidth > 1
    : state === 'failed' ? background.includes('repeating-linear-gradient')
      // Loading shows the shimmer and nothing else: a placeholder, not a broken image or empty box.
      : state === 'loading' ? background.startsWith('linear-gradient')
        : false;
  return { state, shown, width: box.width, height: box.height, x: box.x, y: box.y };
}));

/** Lazy tiles only load near the screen, so a journey brings each one into view before it waits on it. */
async function bringIntoView(tiles: Locator) {
  for (const tile of await tiles.all()) await tile.scrollIntoViewIfNeeded();
}

/** Every tile is in `state` and draws it (never blank), within `timeout`. */
async function expectTiles(tiles: Locator, state: 'ready' | 'failed' | 'loading', timeout = 15_000) {
  await bringIntoView(tiles);
  await expect.poll(async () => (await tileFacts(tiles)).map((tile) => (tile.shown ? tile.state : `blank ${tile.state}`)), {
    message: `every tile shows ${state}`,
    timeout,
  }).toEqual(ids.map(() => state));
  const facts = await tileFacts(tiles);
  for (const tile of facts) {
    expect(tile.width).toBeGreaterThan(0);
    expect(tile.height).toBeGreaterThan(0);
  }
  return facts;
}

/** The same boxes, to a hair: a state change never moves or resizes a tile. */
function expectSameBoxes(actual: Tile[], expected: Tile[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((tile, index) => {
    for (const edge of ['width', 'height', 'x'] as const) expect(tile[edge], `tile ${index} ${edge}`).toBeCloseTo(expected[index][edge], 0);
  });
}

/** The first tile without a finish, so its viewer is one plain card. */
const plainTile = (main: Locator) => main.locator('.collection-grid button.collection-item:not(.has-finish)').first();

async function cardNameOf(tile: Locator) {
  return (await tile.getAttribute('aria-label'))!.replace(/, \d{3}\/\d{3},.*$/, '');
}

/** A real offline-to-online change, which the browser reports to the page as an `online` event. */
async function reconnect(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __online: number }).__online = 0;
    window.addEventListener('online', () => { (window as unknown as { __online: number }).__online += 1; });
  });
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __online: number }).__online)).toBeGreaterThan(0);
}

test('collection tiles whose art will not load say so, and Retry in the card viewer brings the grid back', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await openCollection(page, baseURL!);
  const art = await routeArt(page, 'drop');
  const { main, tiles } = await showCollection(page);

  // Every tile (the finish thumbnail's fallback included) ends in the failed slot, not a blank box.
  const failed = await expectTiles(tiles, 'failed');
  expect(art.failed()).toBeGreaterThan(0);
  // A tile sits inside a button, so it offers no Retry of its own: no stray buttons in the grid.
  await expect(main.locator('.collection-grid').getByRole('button', { name: /^Retry loading/ })).toHaveCount(0);

  // Opening a card offers Retry. Once the art is reachable one press retries every failed tile too.
  const tile = plainTile(main);
  const name = await cardNameOf(tile);
  await tile.click();
  const viewer = page.getByRole('dialog', { name, exact: true });
  const face = viewer.locator('img.card-image:not(.misprint-ghost)');
  await expect(face).toHaveAttribute('data-state', 'failed');
  const retry = viewer.getByRole('button', { name: `Retry loading ${name}`, exact: true });
  await expect(retry).toBeVisible();
  art.set('serve');
  await retry.click();
  await expectDecoded(face, 1);
  await expect(retry).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);

  const ready = await expectTiles(tiles, 'ready');
  // The failed slot kept the art's box: nothing jumped when the art came in.
  expectSameBoxes(ready, failed);
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

test('collection tiles whose art will not load come back when the device is online again', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await openCollection(page, baseURL!);
  const art = await routeArt(page, 'drop');
  const { tiles } = await showCollection(page);
  await expectTiles(tiles, 'failed');

  // Still failing when the device reconnects: the tiles try again and fail again, visibly, without looping.
  const droppedBefore = art.failed();
  await reconnect(page);
  await expect.poll(() => art.failed()).toBeGreaterThan(droppedBefore);
  await expectTiles(tiles, 'failed');

  // Then the art is reachable and the next reconnect brings every tile back.
  art.set('serve');
  await reconnect(page);
  await expectTiles(tiles, 'ready');
  await expectDecoded(tiles, ids.length);
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

test('slow collection art shows a placeholder the size of the art, then fills it without moving anything', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await openCollection(page, baseURL!);
  const art = await holdArt(page);
  const { main, tiles } = await showCollection(page);
  await expect.poll(() => art.requests()).toBeGreaterThan(0);

  // Every tile is loading and draws its shimmer in a box that is already the card's shape.
  const loading = await expectTiles(tiles, 'loading');
  const section = main.locator('.collection-set').first();
  const sectionBefore = await section.boundingBox();
  const [first] = loading;
  for (const tile of loading) expect(tile.height / tile.width).toBeCloseTo(first.height / first.width, 1);
  expect(first.height).toBeGreaterThan(first.width);

  art.set('serve');
  const ready = await expectTiles(tiles, 'ready');
  await expectDecoded(tiles, ids.length);
  expectSameBoxes(ready, loading);
  expect(await section.boundingBox()).toEqual(sectionBefore);
  expect(errors).toEqual([]);
});

test('art held while the viewport crosses the phone and desktop breakpoints still ends up drawn', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await openCollection(page, baseURL!);
  const art = await holdArt(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const { main, tiles } = await showCollection(page);
  await expect.poll(() => art.requests()).toBeGreaterThan(0);
  const columns = () => main.locator('.collection-grid').first().evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);

  // Open a card too, so the viewer's face is also waiting on held art while the page reflows.
  const tile = plainTile(main);
  const name = await cardNameOf(tile);
  await tile.click();
  const viewer = page.getByRole('dialog', { name, exact: true });
  const face = viewer.locator('img.card-image:not(.misprint-ghost)');
  await expect(face).toHaveAttribute('data-state', 'loading');

  // Wide to narrow and back, across both of the grid's breakpoints (820px and 560px).
  for (const [width, across] of [[1280, 6], [700, 4], [390, 3], [1000, 6], [390, 3]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(columns, { message: `${width}px wide` }).toBe(across);
    // Mid-resize the art is still held: each tile keeps its placeholder, never an empty box.
    await expect.poll(async () => (await tileFacts(tiles)).every((t) => t.state === 'loading' && t.shown && t.height > 0)).toBe(true);
    await expect(face).toHaveAttribute('data-state', 'loading');
  }

  art.set('serve');
  await expectDecoded(face, 1);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expectTiles(tiles, 'ready');
  await expectDecoded(tiles, ids.length);
  expect(errors).toEqual([]);
});

/**
 * Headless Chromium has no way to hide a page: `document.visibilityState` stays "visible" whatever the
 * focus, tab or lifecycle emulation says. So this sets what a hidden page reports and fires the
 * `visibilitychange` event that the app's own listeners (the pack cutter, the warm-up) hear.
 */
async function setPageHidden(page: Page, hidden: boolean) {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe(hidden ? 'hidden' : 'visible');
}

test('art held while the page is hidden and shown again still ends up drawn', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await openCollection(page, baseURL!);
  const art = await holdArt(page);
  const { tiles } = await showCollection(page);
  await expect.poll(() => art.requests()).toBeGreaterThan(0);
  await expectTiles(tiles, 'loading');

  // Away and back while the art is still held, then away again as the art arrives, then back.
  await setPageHidden(page, true);
  await setPageHidden(page, false);
  await expectTiles(tiles, 'loading');
  await setPageHidden(page, true);
  art.set('serve');
  await setPageHidden(page, false);

  await expectTiles(tiles, 'ready');
  await expectDecoded(tiles, ids.length);
  expect(errors).toEqual([]);
});

test('art dropped while the page is hidden shows as failed when it is shown again, and comes back online', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await openCollection(page, baseURL!);
  const art = await holdArt(page);
  const { tiles } = await showCollection(page);
  await expect.poll(() => art.requests()).toBeGreaterThan(0);
  await expectTiles(tiles, 'loading');

  // The phone drops its connections in the background: the held loads fail while nobody is looking.
  await setPageHidden(page, true);
  art.set('drop');
  await expect.poll(() => tileFacts(tiles).then((facts) => facts.every((tile) => tile.state === 'failed'))).toBe(true);
  await setPageHidden(page, false);
  // Back on screen: a visible failed slot in the tile's own box, not a blank one.
  await expectTiles(tiles, 'failed');

  art.set('serve');
  await reconnect(page);
  await expectTiles(tiles, 'ready');
  await expectDecoded(tiles, ids.length);
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

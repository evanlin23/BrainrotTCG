// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { fromHex, publicKeyFromSecret, toHex } from '../engine';
import type { CollectionItem, Stats } from '../types';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

// Two tabs share one localStorage. This tab is the mounted app; the other tab is simulated by writing
// to that storage directly and dispatching the storage event a browser sends the tabs that didn't write.
const PLAYER_KEY = 'brainrot-player-v1';
const record = (secretKey: string, name: string) => JSON.stringify({ secretKey, name, nextNonce: 0, createdAt: 1 });
const keyOf = (secretKey: string) => toHex(publicKeyFromSecret(fromHex(secretKey)));
const MINE = '01'.repeat(32);
const THEIRS = '02'.repeat(32);
const SEED = {
  [PLAYER_KEY]: record(MINE, 'This tab'),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
};
// The progress this tab holds in memory and stores from its persistence effect.
const PROGRESS: string[] = [STORAGE_KEYS.COLLECTION, STORAGE_KEYS.ACHIEVEMENTS, STORAGE_KEYS.STATS,
  STORAGE_KEYS.HALL_OF_FAME, STORAGE_KEYS.SETTINGS];
// What the other tab's import leaves in storage: another player, with progress of their own.
const THEIR_PROGRESS = {
  [STORAGE_KEYS.COLLECTION]: '{}',
  [STORAGE_KEYS.ACHIEVEMENTS]: JSON.stringify({ first_pack: { unlockedAt: 1234 } }),
  [STORAGE_KEYS.STATS]: JSON.stringify({ packsOpened: 3, holoCards: {}, highestPackValue: 0, highestPackCards: [] }),
  [STORAGE_KEYS.HALL_OF_FAME]: '{}',
};
const THEIR_SAVE = { [PLAYER_KEY]: record(THEIRS, 'Other tab'), ...THEIR_PROGRESS };

const STALE = 'This save changed in another tab';
const banner = () => document.querySelector('.app > p[role="alert"].save-warning');
const progress = () => Object.fromEntries(PROGRESS.map((key) => [key, localStorage.getItem(key)]));
const owned = () => Object.values(JSON.parse(localStorage.getItem(STORAGE_KEYS.COLLECTION) ?? '{}') as Record<string, CollectionItem>)
  .reduce((sum, item) => sum + item.normalCount + item.holoCount, 0);
const packsOpened = () => (JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS)!) as Stats).packsOpened;
const shelf = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.PENDING_PACKS) ?? '[]') as { n: number; k?: string }[];
const otherTabWrites = (entries: Record<string, string>) => {
  for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
};
const storageEvent = (key: string) => app!.interact(() => window.dispatchEvent(new StorageEvent('storage', { key })));
const packShell = () => document.querySelector<HTMLElement>('[aria-label^="Open a "]');
const button = (within: ParentNode, label: string) => [...within.querySelectorAll<HTMLElement>('button')]
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);

/** Enter on the pack, as the keyboard opens it. */
async function pressOpen() {
  await app!.until('the pack shell is ready', () => expect(packShell()).not.toBeNull());
  await app!.interact(() => {
    const shell = packShell()!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
}

/** A drag along the tear line from edge to edge, as a finger or mouse cuts the pack open. */
async function dragAcross() {
  await app!.until('the pack shell is ready', () => expect(packShell()).not.toBeNull());
  const shell = packShell()!;
  // jsdom lays nothing out, and the cutter measures the pack: give it a phone-sized one.
  const [width, height] = [320, 573];
  shell.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, width, height, toJSON: () => ({}) });
  Object.defineProperty(shell, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(shell, 'clientHeight', { configurable: true, value: height });
  const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  const at = (type: string, clientX: number) => new Pointer(type,
    { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerType: 'mouse', clientX, clientY: height * 0.19 });
  // One event per step, so the cutter sees each step's state before the next.
  await app!.interact(() => shell.dispatchEvent(at('pointerdown', 10)));
  for (const x of [160, 310]) await app!.interact(() => shell.dispatchEvent(at('pointermove', x)));
  await app!.interact(() => shell.dispatchEvent(at('pointerup', 310)));
}

async function openPack() {
  await pressOpen();
  await app!.until('the pack reveals', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app!.interact(() => document.querySelector<HTMLButtonElement>('.reveal-skip')!.click());
  await app!.until('the pack summary shows', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  await app!.settle(100);
}

it('stops this tab opening packs or storing progress once another tab loads a different player, and says to reload', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  expect(banner()).toBeNull();

  otherTabWrites(THEIR_SAVE);
  await storageEvent(PLAYER_KEY);
  // The event alone shows it, before this tab tries to write anything.
  expect(banner()?.textContent).toContain(STALE);
  expect(banner()?.textContent).toContain("can't open packs");
  const reload = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});

  // No pack opens: it would spend the other player's ticket from a tab that can't store what it adds.
  expect(packShell()?.getAttribute('aria-disabled')).toBe('true');
  await pressOpen();
  await app.settle(2000);
  expect(document.querySelector('.reveal-skip')).toBeNull();
  expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!)).toMatchObject({ nextNonce: 0 });
  expect(shelf()).toEqual([]);
  expect(progress()).toEqual({ ...THEIR_PROGRESS, [STORAGE_KEYS.SETTINGS]: SEED[STORAGE_KEYS.SETTINGS] });

  // Settings, where the banner steps aside, offers the same reload.
  await app.interact(() => button(document, 'Sound & display')!.click());
  await app.until('Sound & display loads', () => expect(document.querySelector('.settings')).not.toBeNull());
  expect(banner()).toBeNull();
  const warning = document.querySelector('.settings p[role="alert"].save-warning')!;
  expect(warning.textContent).toContain(STALE);
  await app.interact(() => button(warning, 'Reload')!.click());
  expect(reload).toHaveBeenCalledTimes(1);
  await app.interact(() => button(document, 'Close')!.click());
  await app.until('the banner is back', () => expect(banner()?.textContent).toContain(STALE));
  await app.interact(() => button(banner()!, 'Reload')!.click());
  expect(reload).toHaveBeenCalledTimes(2);
  reload.mockRestore();

  // After the reload the tab is the other player's, as stored, and opens packs into their save.
  await app.reload();
  expect(banner()).toBeNull();
  expect(packsOpened()).toBe(3);
  await openPack();
  expect(owned()).toBe(5);
  expect(packsOpened()).toBe(4);
  expect(shelf()).toEqual([]);
}, 60_000);

it('stops a pointer cut too, once another tab loads a different player', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  otherTabWrites(THEIR_SAVE);
  await storageEvent(PLAYER_KEY);
  expect(banner()?.textContent).toContain(STALE);

  await dragAcross();
  await app.settle(2000);
  expect(document.querySelector('.reveal-skip')).toBeNull();
  expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!)).toMatchObject({ nextNonce: 0 });
  expect(shelf()).toEqual([]);

  // The same drag opens the pack once the tab holds the stored player.
  await app.reload();
  expect(banner()).toBeNull();
  await dragAcross();
  await app.until('the pack reveals', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
}, 60_000);

it('blocks the write even when the storage event never arrived', async () => {
  app = await mountedApp(SEED);
  await app.mount();

  otherTabWrites(THEIR_SAVE);
  await openPack();

  expect(progress()).toEqual({ ...THEIR_PROGRESS, [STORAGE_KEYS.SETTINGS]: SEED[STORAGE_KEYS.SETTINGS] });
  expect(banner()?.textContent).toContain(STALE);
}, 60_000);

it('keeps saving when another tab stores the same player (a rename)', async () => {
  app = await mountedApp(SEED);
  await app.mount();

  otherTabWrites({ [PLAYER_KEY]: record(MINE, 'Renamed elsewhere') });
  await storageEvent(PLAYER_KEY);
  expect(banner()).toBeNull();

  await openPack();
  expect(owned()).toBe(5);
  expect(packsOpened()).toBe(1);
  expect(Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACHIEVEMENTS)!))).toContain('first_pack');
  expect(shelf()).toEqual([]);
  expect(banner()).toBeNull();
}, 60_000);

it('still recovers a pack the collection couldn’t store when the player is the same', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  otherTabWrites({ [PLAYER_KEY]: record(MINE, 'Renamed elsewhere') });
  await storageEvent(PLAYER_KEY);

  const setItem = Storage.prototype.setItem;
  const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.COLLECTION) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await openPack();

  // The ordinary storage warning, not the other-tab one; the pack waits on the shelf, counted.
  expect(app.takeErrors(/^Failed to save to localStorage key /).length).toBeGreaterThan(0);
  expect(banner()?.textContent).toContain("couldn't be saved in this browser");
  expect(banner()?.textContent).not.toContain(STALE);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBeNull();
  expect(packsOpened()).toBe(1);
  expect(shelf()).toMatchObject([{ n: 0, k: keyOf(MINE) }]);

  // Space freed: the next load adds the pack once, and the shelf empties.
  full.mockRestore();
  await app.reload();
  await app.until('the waiting pack reaches the stored collection', () => expect(owned()).toBe(5));
  expect(packsOpened()).toBe(1);
  expect(shelf()).toEqual([]);
  expect(banner()).toBeNull();
}, 60_000);

// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { shelvedPacks } from './pendingShelf';
import { STORAGE_KEYS } from '../constants/config';
import { fromHex, publicKeyFromSecret, toHex } from '../engine';
import { SAVE_STAMP_KEY } from '../game/player';
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
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
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
const shelf = shelvedPacks;
const otherTabWrites = (entries: Record<string, string>) => {
  for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
};
const storageEvent = (key: string | null) => app!.interact(() => window.dispatchEvent(new StorageEvent('storage', { key })));
const packShell = () => document.querySelector<HTMLElement>('.pack-shell');
const openButton = () => document.querySelector<HTMLButtonElement>('.pack-open-button');
const refusal = () => document.querySelector('.pack-refusal');
const button = (within: ParentNode, label: string) => [...within.querySelectorAll<HTMLElement>('button')]
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);

/** The Open pack button under the pack, as a tap, a click or the keyboard opens it. */
async function pressOpen() {
  await app!.until('the Open pack button is ready', () => expect(openButton()).not.toBeNull());
  await app!.interact(() => {
    openButton()!.focus();
    openButton()!.click();
  });
}

/** The pack stayed sealed and says why, with a reload in place of the Open pack button (#312). */
const expectKeptSealed = () => {
  expect(refusal()?.textContent).toContain('Your save changed in another tab, so this pack stayed sealed.');
  expect(button(refusal()!, 'Reload and try again')).toBeDefined();
  expect(openButton()).toBeNull();
};

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
  await pressOpen();
  await app.settle(2000);
  expect(document.querySelector('.reveal-skip')).toBeNull();
  expectKeptSealed();
  expect(document.activeElement).toBe(button(refusal()!, 'Reload and try again'));
  await app.interact(() => button(refusal()!, 'Reload and try again')!.click());
  expect(reload).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!)).toMatchObject({ nextNonce: 0 });
  expect(shelf()).toEqual([]);
  expect(progress()).toEqual({ ...THEIR_PROGRESS, [STORAGE_KEYS.SETTINGS]: SEED[STORAGE_KEYS.SETTINGS] });

  // Settings, where the banner steps aside, offers the same reload.
  await app.interact(() => button(document, 'Settings')!.click());
  await app.until('Settings loads', () => expect(document.querySelector('.settings')).not.toBeNull());
  expect(banner()).toBeNull();
  const warning = document.querySelector('.settings p[role="alert"].save-warning')!;
  expect(warning.textContent).toContain(STALE);
  await app.interact(() => button(warning, 'Reload')!.click());
  expect(reload).toHaveBeenCalledTimes(2);
  await app.interact(() => button(document, 'Close Settings')!.click());
  await app.until('the banner is back', () => expect(banner()?.textContent).toContain(STALE));
  await app.interact(() => button(banner()!, 'Reload')!.click());
  expect(reload).toHaveBeenCalledTimes(3);
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

it('puts a torn pack back sealed when another tab loads a different player before its ticket is spent', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  // The drag finishes the cut; the ticket is spent a moment later, once the tear has played.
  await dragAcross();
  otherTabWrites(THEIR_SAVE);
  await storageEvent(PLAYER_KEY);
  await app.settle(2000);

  expect(banner()?.textContent).toContain(STALE);
  expect(document.querySelector('.reveal-skip')).toBeNull();
  expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!)).toMatchObject({ nextNonce: 0 });
  expect(shelf()).toEqual([]);
  // The tear that didn't open says why, rather than leaving a sealed pack that ignores the next one.
  expectKeptSealed();
}, 60_000);

it('blocks the write even when the storage event never arrived', async () => {
  app = await mountedApp(SEED);
  await app.mount();

  otherTabWrites(THEIR_SAVE);
  await openPack();

  expect(progress()).toEqual({ ...THEIR_PROGRESS, [STORAGE_KEYS.SETTINGS]: SEED[STORAGE_KEYS.SETTINGS] });
  expect(banner()?.textContent).toContain(STALE);
}, 60_000);

it('leaves another player’s name alone when this tab leaves Profile with an edited name, and says why', async () => {
  app = await mountedApp(SEED);
  history.replaceState(null, '', '/BrainrotTCG/#/profile');
  await app.mount();
  const nameField = () => document.querySelector<HTMLInputElement>('input[autocomplete="nickname"]');
  await app.until('Profile loads', () => expect(button(document, 'Edit name')).toBeDefined());
  await app.interact(() => button(document, 'Edit name')!.click());
  await app.interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameField()!, 'Alice');
    nameField()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // No storage event: the other tab's import is caught when leaving the page tries to store the name.
  otherTabWrites(THEIR_SAVE);
  await app.interact(() => button(document, 'Close Profile')!.click());
  await app.until('Open shows again', () => expect(nameField()).toBeNull());
  expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!)).toEqual(JSON.parse(record(THEIRS, 'Other tab')));
  expect(banner()?.textContent).toContain(STALE);
});

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

it('stops storing progress once another tab imports a save, even the same player’s', async () => {
  app = await mountedApp(SEED);
  await app.mount();

  // The same player, so only the import's stamp shows the save changed.
  otherTabWrites({ [SAVE_STAMP_KEY]: 'imported', ...THEIR_PROGRESS });
  await storageEvent(SAVE_STAMP_KEY);
  expect(banner()?.textContent).toContain(STALE);
  await pressOpen();
  await app.settle(2000);
  expectKeptSealed();
  expect(document.querySelector('.reveal-skip')).toBeNull();
  expect(progress()).toEqual({ ...THEIR_PROGRESS, [STORAGE_KEYS.SETTINGS]: SEED[STORAGE_KEYS.SETTINGS] });
}, 60_000);

it('keeps the imported save when this tab opens a pack before hearing of a same-player import', async () => {
  app = await mountedApp(SEED);
  await app.mount();

  otherTabWrites({ [SAVE_STAMP_KEY]: 'imported', ...THEIR_PROGRESS });
  await openPack();
  expect(banner()?.textContent).toContain(STALE);
  expect(progress()).toEqual({ ...THEIR_PROGRESS, [STORAGE_KEYS.SETTINGS]: SEED[STORAGE_KEYS.SETTINGS] });
  // The pack waits on the shelf, and the next load adds it to the imported save.
  expect(shelf()).toHaveLength(1);
  await app.reload();
  expect(banner()).toBeNull();
  expect(owned()).toBe(5);
  expect(shelf()).toEqual([]);
}, 60_000);

it('stops writing once another tab clears this browser’s storage', async () => {
  app = await mountedApp(SEED);
  await app.mount();

  localStorage.clear();
  await storageEvent(null);
  expect(banner()?.textContent).toContain(STALE);
  // Opening a pack would store this tab's player again, under whatever the other tab saves next.
  await pressOpen();
  await app.settle(2000);
  expectKeptSealed();
  expect(localStorage.getItem(PLAYER_KEY)).toBeNull();
  expect(Object.values(progress())).toEqual(PROGRESS.map(() => null));
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

it('refuses stale replacement import when another tab imported a save, and allows a reconfirmed import', async () => {
  const initialSeed = {
    ...SEED,
    [STORAGE_KEYS.STATS]: JSON.stringify({ packsOpened: 5, holoCards: {}, highestPackValue: 0, highestPackCards: [] }),
  };
  app = await mountedApp(initialSeed);
  await app.mount();

  // Open Settings in Tab A
  await app.interact(() => button(document, 'Settings')!.click());
  await app.until('Settings loads', () => expect(document.querySelector('.settings')).not.toBeNull());

  const pickFile = async (save: object) => {
    const input = document.querySelector<HTMLInputElement>('.settings input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(save)], 'save.json')], configurable: true });
    await app!.interact(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  const incomingKey = '03'.repeat(32);
  const incomingSave = {
    version: 2, exportedAt: '2026-10-14T00:00:00.000Z', dataVersion: 3,
    player: record(incomingKey, 'Incoming Player'),
    stats: JSON.stringify({ packsOpened: 10, holoCards: {}, highestPackCards: [] }),
    collection: '{}', achievements: '{}', hallOfFame: '{}',
    settings: JSON.stringify({ effectsVolume: 0 }),
    history: '[]',
  };

  // 1. In Tab A: select incoming save and wait for Replace prompt
  await pickFile(incomingSave);
  await app.until('replacement prompt appears', () => expect(button(document, 'Replace')).not.toBeUndefined());
  expect(document.querySelector('.settings [role="status"]')?.textContent).toContain("Replace this browser's save");

  // 2. Tab B: actual successful import of Switched Player
  const switchedKey = '04'.repeat(32);
  const switchedSave = {
    version: 2, exportedAt: '2026-10-14T00:00:00.000Z', dataVersion: 3,
    player: record(switchedKey, 'Switched Player'),
    stats: JSON.stringify({ packsOpened: 20, holoCards: {}, highestPackCards: [] }),
    collection: '{}', achievements: '{}', hallOfFame: '{}',
    settings: JSON.stringify({ effectsVolume: 0 }),
    history: '[]',
  };
  const { importSaveFile } = await import('../game/saveFile');
  expect(importSaveFile(JSON.stringify(switchedSave))).toBeNull();

  // Tab A receives storage event from Tab B
  await storageEvent(PLAYER_KEY);

  // 3. Stale prompt/Replace in Tab A causes zero replacement writes against Switched
  const replaceBtn = button(document, 'Replace');
  if (replaceBtn) {
    await app.interact(() => replaceBtn.click());
  }
  // Switched save remains intact in storage
  expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!).name).toBe('Switched Player');
  expect((JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS)!) as Stats).packsOpened).toBe(20);
  expect(button(document, 'Replace')).toBeUndefined();

  // 4. Refreshed/reconfirmed import succeeds
  await app.reload();
  const reloadSpy = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});

  await app.interact(() => button(document, 'Settings')!.click());
  await app.until('Settings loads', () => expect(document.querySelector('.settings')).not.toBeNull());

  await pickFile(incomingSave);
  await app.until('fresh replacement prompt appears', () => expect(button(document, 'Replace')).not.toBeUndefined());
  expect(document.querySelector('.settings [role="status"]')?.textContent).toContain('Switched Player');

  await app.interact(() => button(document, 'Replace')!.click());
  expect(reloadSpy).toHaveBeenCalled();
  reloadSpy.mockRestore();

  // Incoming Player is now imported in storage
  expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!).name).toBe('Incoming Player');
  // And the backup in storage holds Switched Player
  const backup = JSON.parse(localStorage.getItem('brainrot-before-import-v1')!);
  expect(backup[PLAYER_KEY]).toContain('Switched Player');
}, 60_000);

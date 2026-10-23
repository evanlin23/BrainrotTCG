// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { shelfKeys, shelvedPacks } from './pendingShelf';
import { STORAGE_KEYS } from '../constants/config';
import type { CollectionItem, Stats } from '../types';
import { FILE_TOO_BIG_NOTE, NO_ROOM_FOR_COPY_NOTE, PARTIAL_IMPORT_NOTE } from '../game/saveFile';

// Interrupted, slow and failed openings, and a failed restore, through the real App and real tickets.
let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const PLAYER_KEY = 'brainrot-player-v1';
const SEED = {
  [PLAYER_KEY]: JSON.stringify({ secretKey: '01'.repeat(32), name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
};
/** The seed identity's first right-now v2 pack (as in packLifecycle), so a match proves whose key opened it. */
const GOLDEN_CARDS = ['bukangi', 'niu-laiG', 'bukangi', 'la-peace', 'verity'];
const SEED_KEY_PREFIX = '8a88e3dd7409f195';

const read = <T,>(key: string): T => JSON.parse(localStorage.getItem(key) ?? 'null');
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button, [role="button"]')]
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
const storedCards = () => Object.values(read<Record<string, CollectionItem>>(STORAGE_KEYS.COLLECTION) ?? {})
  .reduce((sum, item) => sum + item.normalCount + item.holoCount, 0);
const expectShelvesEmpty = () => {
  expect(shelfKeys()).toEqual([]);
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACKS)).toBeNull();
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACK)).toBeNull();
};
const history = async () => (await import('../game/history')).getHistory();
const historyCodes = async (index = 0) => {
  const { encodeCard } = await import('../game/cardCode');
  return (await history())[index].cards!.map(encodeCard);
};
const expectNothingRecorded = async () => {
  expect(await history()).toEqual([]);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBeNull();
  expect(read<Stats | null>(STORAGE_KEYS.STATS)?.packsOpened ?? 0).toBe(0);
  expectShelvesEmpty();
};

const pressPack = async () => {
  await app!.until('the pack shell is ready', () => expect(document.querySelector('[data-pack-open]')).not.toBeNull());
  await app!.interact(() => {
    // The pack itself: a tap is the same opening as a finished swipe (#312).
    const open = document.querySelector<HTMLElement>('[data-pack-open]')!;
    expect(open).not.toBeNull();
    open.focus();
    open.click();
  });
};
/** The pack's one polite live region (#312). */
const announced = () => document.querySelector('.pack-opener-container > [aria-live="polite"]')?.textContent;
const REFUSED = "This pack didn't open, and no cards were dealt.";
/** A refused pack says why, with Try again focused and announced; the sealed pack stays on screen. */
const expectRefused = (what: string) => app!.until(what, () => {
  expect(document.querySelector('.pack-refusal-text')?.textContent).toBe(REFUSED);
  expect(announced()).toBe(REFUSED);
  expect(document.querySelector('[data-pack-open]')?.getAttribute('aria-label')).toMatch(/^Open pack, /);
  const retry = document.querySelector<HTMLButtonElement>('.pack-retry-button');
  expect(retry?.textContent).toBe('Try again');
  expect(document.activeElement).toBe(retry);
});
const tryAgain = () => app!.interact(() => document.querySelector<HTMLButtonElement>('.pack-retry-button')!.click());
const finishReveal = async () => {
  await app!.until('the ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app!.interact(() => button('Skip opening animation')!.click());
  await app!.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
};

it('adds a pack left mid-reveal by a reload once, from the pending shelf', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  await pressPack();
  await app.until('the reveal starts', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  // Recorded at open; the collection and stats take it when the reveal ends, or on the next load.
  expect((await history()).map((pack) => pack.nonce)).toEqual([0]);
  expect(shelvedPacks().map((pack) => pack.n)).toEqual([0]);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBeNull();

  await app.reload();
  await app.until('the waiting pack reaches the collection', () => expect(storedCards()).toBe(5));
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(1);
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expectShelvesEmpty();
  // A first pack restored from the shelf counts as saved: the tabs and set picker show (#222).
  expect(document.querySelector('.app-nav')).not.toBeNull();
  expect(document.querySelector('nav.set-picker[aria-label="Choose a pack"]')).not.toBeNull();
  const settled = Object.entries(localStorage);
  await app.reload();
  expect(Object.entries(localStorage)).toEqual(settled);
});

const toastTexts = () => [...document.querySelectorAll('.toast')].map((el) => el.textContent ?? '');
/** Leave a pack mid-reveal, then reload; `shelfCopies` more packs are put on the shelf beside it first. */
const interruptAndReload = async (shelfCopies = 0) => {
  await pressPack();
  await app!.until('the reveal starts', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  for (let n = 1; n <= shelfCopies; n++) {
    const [key] = shelfKeys();
    localStorage.setItem(key.replace(/:0$/, `:${n}`), localStorage.getItem(key)!.replace('"n":0', `"n":${n}`));
  }
  expect(shelvedPacks()).toHaveLength(1 + shelfCopies);
};

it('says on return that an interrupted pack was kept, once, with a way to its cards', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  expect(toastTexts()).toEqual([]);
  await interruptAndReload();
  await app.reload();
  await app.until('the recovered pack reaches the collection', () => expect(storedCards()).toBe(5));
  await app.until('a notice says the pack was kept', () => expect(toastTexts()).toHaveLength(1));
  expect(toastTexts()[0]).toContain('Pack kept');
  expect(toastTexts()[0]).toContain('A pack from your last visit is in Cards');
  expect(document.querySelector('.toast-region')?.getAttribute('role')).toBe('status');
  // It does not cover or replace the pack to open, and a tap takes the player to the cards.
  expect(document.querySelector('[data-pack-open]')).not.toBeNull();
  await app.interact(() => document.querySelector<HTMLButtonElement>('.toast')!.click());
  await app.until('the toast opened Cards and left', () => {
    expect(location.hash).toContain('cards');
    expect(toastTexts()).toEqual([]);
  });
  // Recovery is done: the next load has nothing to explain. Back on the open route, where toasts show.
  window.history.replaceState(null, '', '/BrainrotTCG/');
  await app.reload();
  expect(document.querySelector('[data-pack-open]')).not.toBeNull();
  await app.settle(500);
  expect(toastTexts()).toEqual([]);
});

it('gives several recovered packs one notice, not one each', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  await interruptAndReload(2);
  await app.reload();
  await app.until('the recovered packs reach the collection', () => expect(storedCards()).toBe(15));
  await app.until('one notice says the packs were kept', () => expect(toastTexts()).toHaveLength(1));
  expect(toastTexts()[0]).toContain('3 packs from your last visit are in Cards');
  await app.settle(500);
  expect(toastTexts()).toHaveLength(1);
});

it('does not say a recovered pack was kept when the collection cannot be stored', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  await interruptAndReload();
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.COLLECTION) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await app.reload();
  await app.until('the save warning shows', () => expect(document.querySelector('p[role="alert"].save-warning')?.textContent).toMatch(/couldn't be saved/));
  await app.settle(1000);
  expect(toastTexts().join(' | '), 'a pack that could not be stored was said to be kept').not.toContain('Pack kept');
  // Still owed on the shelf, so a later load can keep it and say so then.
  expect(shelvedPacks().map((pack) => pack.n)).toEqual([0]);
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toEqual([expect.stringContaining(`"${STORAGE_KEYS.COLLECTION}"`)]);
});

it('waits for a slow ticket with the app held on the pack, then records the late pack once', async () => {
  app = await mountedApp(SEED, { tickets: () => ({ delayMs: 4000 }) });
  await app.mount();
  await pressPack();
  await app.until('a slow ticket says so', () => {
    expect(document.querySelector('.pack-hint.is-waiting')?.textContent).toBe('Taking a moment…');
    expect(document.querySelector('[data-pack-open]')?.getAttribute('aria-label')).toBe('Opening…');
    expect(announced()).toBe('Opening the pack…');
  });
  // Nothing may swap the set or open over the pack meanwhile. Its number is claimed once the ticket is
  // in hand, in the same step that records the pack, so a number is never spent without its mapping.
  expect(button('Settings')!.disabled).toBe(true);
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(0);
  await expectNothingRecorded();

  await finishReveal();
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(1);
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expect(await history()).toHaveLength(1);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expect(storedCards()).toBe(5);
  expectShelvesEmpty();
  expect(document.querySelector('.pack-hint.is-waiting')).toBeNull();
});

it('refuses a late pack opening when another tab imports player B during mining, leaving B untouched with no reveal', async () => {
  app = await mountedApp(SEED, { tickets: () => ({ delayMs: 4000 }) });
  await app.mount();
  await pressPack();
  await app.until('a slow ticket says so', () => {
    expect(document.querySelector('.pack-hint.is-waiting')?.textContent).toBe('Taking a moment…');
  });

  const saveB = JSON.stringify({
    version: 2,
    exportedAt: '2026-01-01T00:00:00Z',
    collection: '{}',
    stats: JSON.stringify({ packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] }),
    player: JSON.stringify({ secretKey: '02'.repeat(32), name: 'Player B', nextNonce: 0, createdAt: 2 }),
  });
  await app.interact(async () => {
    const { importSaveFile } = await import('../game/saveFile');
    expect(importSaveFile(saveB)).toBeNull();
    window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-player-v1' }));
  });

  await app.until('the stale save warning appears', () => {
    expect(document.querySelector('.save-warning')?.textContent).toContain('This save changed in another tab');
  });

  await app.until('the pack stays sealed and shows refusal', () => {
    expect(document.querySelector('.pack-refusal-text')?.textContent).toBe(
      'Your save changed in another tab, so this pack stayed sealed. Reload to keep opening packs here.',
    );
    expect(document.querySelector('.pack-retry-button')?.textContent).toBe('Reload and try again');
  });

  expect(app.takeErrors(/^Could not open pack/)).toEqual([expect.stringContaining('StaleSaveError')]);
  expect(document.querySelector('.reveal-container')).toBeNull();
  expect(document.querySelector('.reveal-skip')).toBeNull();
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(0);
  expect(read<{ secretKey: string }>(PLAYER_KEY).secretKey).toBe('02'.repeat(32));
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(0);
  expect(await history()).toEqual([]);
  expectShelvesEmpty();
  expect(storedCards()).toBe(0);
});

it('refuses a late pack opening when another tab imports a backup of the same player during mining', async () => {
  app = await mountedApp(SEED, { tickets: () => ({ delayMs: 4000 }) });
  await app.mount();
  await pressPack();
  await app.until('a slow ticket says so', () => {
    expect(document.querySelector('.pack-hint.is-waiting')?.textContent).toBe('Taking a moment…');
  });

  const saveA = JSON.stringify({
    version: 2,
    exportedAt: '2026-01-01T00:00:00Z',
    collection: '{}',
    stats: JSON.stringify({ packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] }),
    player: JSON.stringify({ secretKey: '01'.repeat(32), name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
  });
  await app.interact(async () => {
    const { importSaveFile } = await import('../game/saveFile');
    expect(importSaveFile(saveA)).toBeNull();
    window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-save-stamp-v1' }));
  });

  await app.until('the pack stays sealed and shows refusal', () => {
    expect(document.querySelector('.pack-refusal-text')?.textContent).toBe(
      'Your save changed in another tab, so this pack stayed sealed. Reload to keep opening packs here.',
    );
    expect(document.querySelector('.pack-retry-button')?.textContent).toBe('Reload and try again');
  });

  expect(app.takeErrors(/^Could not open pack/)).toEqual([expect.stringContaining('StaleSaveError')]);
  expect(document.querySelector('.reveal-container')).toBeNull();
  expect(document.querySelector('.reveal-skip')).toBeNull();
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(0);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(0);
  expect(await history()).toEqual([]);
  expectShelvesEmpty();
  expect(storedCards()).toBe(0);
});

it('refuses a tear after another tab imported player B, even before this tab hears of it, leaving B untouched', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  await app.until('the pack shell is ready', () => expect(document.querySelector('[data-pack-open]')).not.toBeNull());

  const saveB = JSON.stringify({
    version: 2,
    exportedAt: '2026-01-01T00:00:00Z',
    collection: '{}',
    stats: JSON.stringify({ packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] }),
    player: JSON.stringify({ secretKey: '02'.repeat(32), name: 'Player B', nextNonce: 0, createdAt: 2 }),
  });
  // No StorageEvent: storage already holds B, but this tab's (late) event hasn't arrived.
  await app.interact(async () => {
    const { importSaveFile } = await import('../game/saveFile');
    expect(importSaveFile(saveB)).toBeNull();
  });
  const bestCardsB = localStorage.getItem(STORAGE_KEYS.BEST_CARDS);
  await pressPack();

  await app.until('the pack stays sealed and says the save changed', () => {
    expect(document.querySelector('.pack-refusal-text')?.textContent).toBe(
      'Your save changed in another tab, so this pack stayed sealed. Reload to keep opening packs here.',
    );
  });
  expect(app.takeErrors(/^Could not open pack/)).toEqual([expect.stringContaining('StaleSaveError')]);
  expect(document.querySelector('.reveal-container')).toBeNull();
  expect(document.querySelector('.reveal-skip')).toBeNull();
  expect(read<{ secretKey: string; nextNonce: number }>(PLAYER_KEY)).toMatchObject({ secretKey: '02'.repeat(32), nextNonce: 0 });
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(0);
  expect(await history()).toEqual([]);
  expect(localStorage.getItem(STORAGE_KEYS.BEST_CARDS)).toBe(bestCardsB);
  expectShelvesEmpty();
  expect(storedCards()).toBe(0);
});

it('spends nothing for a pack whose ticket was still mining at a reload, and opens that nonce once later', async () => {
  let delayMs = 60_000;
  app = await mountedApp(SEED, { tickets: () => ({ delayMs }) });
  await app.mount();
  await pressPack();
  await app.until('a slow ticket says so', () => expect(document.querySelector('.pack-hint.is-waiting')).not.toBeNull());
  delayMs = 0;
  await app.reload();
  // The ticket never arrived, so its number was never claimed: nothing is half-recorded, and no number is
  // left without the set it opened in (which would keep the profile link from ever being made).
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(0);
  await expectNothingRecorded();

  await pressPack();
  await finishReveal();
  expect((await history()).map((pack) => pack.nonce)).toEqual([0]);
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(1);
  expect((await import('../game/profiles')).myProfileInfo()).toMatchObject({ packs: 1, filled: 0 });
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expect(storedCards()).toBe(5);
  expectShelvesEmpty();
});

it('shows a failed ticket with its reason and Try again, records nothing, and records exactly one pack on retry', async () => {
  let failing = true;
  app = await mountedApp(SEED, { tickets: () => (failing ? { error: 'Simulated ticket failure' } : undefined) });
  await app.mount();
  await pressPack();
  await expectRefused('the failure is shown and announced');
  expect(app.takeErrors(/^Could not open pack/)).toEqual([expect.stringContaining('Simulated ticket failure')]);
  await expectNothingRecorded();
  await app.until('the app is free again', () => expect(button('Settings')!.disabled).toBe(false));

  failing = false;
  await tryAgain();
  // Try again went with the refusal: the Open pack button that came back has focus for the wait.
  expect(document.querySelector('.pack-retry-button')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('[data-pack-open]'));
  expect(document.activeElement).not.toBe(document.body);
  await finishReveal();
  const packs = await history();
  expect(packs).toHaveLength(1);
  expect(packs[0].nonce).toBe(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce - 1);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expect(storedCards()).toBe(5);
  expectShelvesEmpty();
});

it('never retries a failed ticket by itself: each press asks once more, and a second failure is shown like the first', async () => {
  app = await mountedApp(SEED, { tickets: () => ({ error: 'Simulated ticket failure' }) });
  await app.mount();
  for (const press of [1, 2]) {
    const asked = app.ticketRequests.length;
    // The first press is Open pack; the second, the Try again that took its place.
    if (press === 1) await pressPack();
    else await tryAgain();
    await app.until(`press ${press} asks for a ticket`, () => expect(app!.ticketRequests.length).toBeGreaterThan(asked));
    await expectRefused(`failure ${press} is shown and announced`);
    await app.until('the app is free again', () => expect(button('Settings')!.disabled).toBe(false));
    expect(app.takeErrors(/^Could not open pack/)).toEqual([expect.stringContaining('Simulated ticket failure')]);
    expect(app.ticketRequests).toHaveLength(asked + 1);
    await app.settle(10_000);
    expect(app.ticketRequests).toHaveLength(asked + 1); // nothing asks again until the next press
  }
  // A failed ticket spends no number (it has no pack to map it to): both presses asked for ticket 0, and
  // neither recorded anything.
  expect(app.ticketRequests.slice(-2).map((request) => request.nonce)).toEqual([0, 0]);
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(0);
  await expectNothingRecorded();
});

it('finishes on the main thread when the ticket worker crashes, with the same pack', async () => {
  app = await mountedApp(SEED, { tickets: () => 'crash' });
  await app.mount();
  await pressPack();
  await finishReveal();
  expect(app.takeErrors(/^Ticket worker failed; mining on the main thread/)).toHaveLength(1);
  expect(app.ticketRequests).toHaveLength(1); // Later tickets, the next-pack prefetch included, skip the worker.
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expectShelvesEmpty();
});

it("restores this player's save when storage fills mid-import, then keeps opening packs as this player", async () => {
  const incomingStats = JSON.stringify({ packsOpened: 5, holoCards: {} });
  const save = JSON.stringify({
    version: 2, exportedAt: '2026-01-01T00:00:00Z', collection: '{}', achievements: '{"first_pack":1}', stats: incomingStats,
    player: JSON.stringify({ secretKey: '02'.repeat(32), name: 'Other player', nextNonce: 5, createdAt: 2 }),
  });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.STATS]: JSON.stringify({ packsOpened: 3, holoCards: {} }) });
  await app.mount();
  await app.interact(() => button('Settings')!.click());
  await app.until('Save & backup loads', () => expect(button('Import')).toBeDefined());
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File([save], 'save.json', { type: 'application/json' })] });
  await app.interact(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await app.until('a different player asks first', () => expect(button('Replace')).toBeDefined());

  const before = Object.fromEntries(Object.entries(localStorage));
  // The incoming stats don't fit; the original, smaller value can still be put back.
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.STATS && value === incomingStats) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await app.interact(() => button('Replace')!.click());
  await app.until('the player may go ahead without the copy', () => expect(button('Replace without a copy')).toBeDefined());
  expect(document.body.textContent).toContain(NO_ROOM_FOR_COPY_NOTE);
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual(before);
  await app.interact(() => button('Replace without a copy')!.click());
  await app.until('the failure is explained', () => expect(document.body.textContent)
    .toContain(FILE_TOO_BIG_NOTE));
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual(before);
  expect(button('Import')).toBeDefined();

  // The identity in memory never switched, so the next pack is this player's nonce-0 pack.
  await app.interact(() => button('Close Settings')!.click());
  await app.until('Open shows again', () => expect(document.querySelector<HTMLElement>('main.app-main')!.hidden).toBe(false));
  await pressPack();
  await finishReveal();
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expect((await history())[0].key).toBe(SEED_KEY_PREFIX);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(4);
  expect(read<{ secretKey: string }>(PLAYER_KEY).secretKey).toBe('01'.repeat(32));
});

it("says so and then reloads when a failed import can't be undone, so the app doesn't keep showing the old save", async () => {
  const save = JSON.stringify({
    version: 2, exportedAt: '2026-01-01T00:00:00Z', collection: '{}', achievements: '{"first_pack":1}',
    stats: JSON.stringify({ packsOpened: 5, holoCards: {} }),
    player: JSON.stringify({ secretKey: '02'.repeat(32), name: 'Other player', nextNonce: 5, createdAt: 2 }),
  });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.STATS]: JSON.stringify({ packsOpened: 3, holoCards: {} }) });
  await app.mount();
  const reload = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  await app.interact(() => button('Settings')!.click());
  await app.until('Save & backup loads', () => expect(button('Import')).toBeDefined());
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File([save], 'save.json', { type: 'application/json' })] });
  await app.interact(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await app.until('a different player asks first', () => expect(button('Replace')).toBeDefined());

  // The incoming stats don't fit, and then neither do the original achievements put back.
  const achievements = localStorage.getItem(STORAGE_KEYS.ACHIEVEMENTS);
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.STATS || (key === STORAGE_KEYS.ACHIEVEMENTS && value === achievements)) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await app.interact(() => button('Replace')!.click());
  await app.until('the player is told, then the page reloads', () => expect(reload).toHaveBeenCalledOnce());
  expect(alert).toHaveBeenCalledOnce();
  expect(alert.mock.calls[0][0]).toContain(PARTIAL_IMPORT_NOTE);
  expect(alert.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
});

it("offers the save from before as a download, then reloads, when an import without a copy can't be undone", async () => {
  const save = JSON.stringify({
    version: 2, exportedAt: '2026-01-01T00:00:00Z', collection: '{}', achievements: '{"first_pack":1}',
    stats: JSON.stringify({ packsOpened: 5, holoCards: {} }),
    player: JSON.stringify({ secretKey: '02'.repeat(32), name: 'Other player', nextNonce: 5, createdAt: 2 }),
  });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.STATS]: JSON.stringify({ packsOpened: 3, holoCards: {} }) });
  await app.mount();
  const reload = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});
  const download = vi.spyOn(await import('../game/saveFile'), 'downloadSaveFile').mockImplementation(() => '');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  await app.interact(() => button('Settings')!.click());
  await app.until('Save & backup loads', () => expect(button('Import')).toBeDefined());
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File([save], 'save.json', { type: 'application/json' })] });
  await app.interact(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await app.until('a different player asks first', () => expect(button('Replace')).toBeDefined());

  // No room for the copy; without it, the incoming stats don't fit and the original achievements can't go back.
  const before = Object.fromEntries(Object.entries(localStorage));
  const achievements = localStorage.getItem(STORAGE_KEYS.ACHIEVEMENTS);
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === 'brainrot-before-import-v1' || key === STORAGE_KEYS.STATS || (key === STORAGE_KEYS.ACHIEVEMENTS && value === achievements)) {
      throw new DOMException('Full', 'QuotaExceededError');
    }
    setItem.call(this, key, value);
  });
  await app.interact(() => button('Replace')!.click());
  await app.until('the player may go ahead without the copy', () => expect(button('Replace without a copy')).toBeDefined());
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual(before);
  await app.interact(() => button('Replace without a copy')!.click());
  await app.until('the save from before is offered, then the page reloads', () => expect(reload).toHaveBeenCalledOnce());
  expect(confirm).toHaveBeenCalledOnce();
  expect(confirm.mock.calls[0][0]).toContain(PARTIAL_IMPORT_NOTE);
  expect(download).toHaveBeenCalledOnce();
  expect(JSON.parse(JSON.parse(download.mock.calls[0][0]!).player)).toMatchObject({ secretKey: '01'.repeat(32), name: 'Mounted fixture' });
  expect(JSON.parse(download.mock.calls[0][0]!).stats).toBe(before[STORAGE_KEYS.STATS]);
  expect(download.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
  expect(alert).not.toHaveBeenCalled();
});

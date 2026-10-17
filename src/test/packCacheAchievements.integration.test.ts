// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { POKER_HANDS } from '../engine/scoring';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

// A pair of Commons: 2 of a Kind and Rock Bottom, from a set without modifiers.
const CARDS = 'locked-in-alien,locked-in-alien,chimpanzini-bananini,amogus,gigachad';
// The same pack as IndexedDB keeps it, with a holo gold card only its saved cards show.
const SAVED = 'locked-in-alien,locked-in-alien,chimpanzini-bananini,amogus,gigachad*G';
const SEED = {
  'brainrot-player-v1': JSON.stringify({ secretKey: '0a'.repeat(32), name: 'Mounted fixture', nextNonce: 2, createdAt: 1 }),
  // A card back the save's level hasn't reached, chosen when it was known (or by an older build).
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false, cardBack: 'midnight' }),
  [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
};

/** Opens the pack on the shell and skips its reveal, through to the summary. */
const openAPack = async () => {
  await app!.until('the pack shell is ready', () => expect(document.querySelector('.pack-open-button')).not.toBeNull());
  await app!.interact(() => {
    // The Open pack button under the pack: the same opening as a finished swipe (#312).
    const open = document.querySelector<HTMLButtonElement>('.pack-open-button')!;
    expect(open).not.toBeNull();
    open.focus();
    open.click();
  });
  await app!.until('the pack reveals', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app!.interact(() => document.querySelector<HTMLButtonElement>('.reveal-skip')!.click());
  await app!.until('the pack summary shows', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
};
const toasts = () => document.querySelector('.toast-region')?.textContent ?? '';

type Unlocked = { unlockedAt: number; pack?: unknown[]; ref?: { nonce: number } };
const achievements = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.ACHIEVEMENTS) ?? '{}') as Record<string, Unlocked>;

it("dates history achievements by the pack that earned them, even when its cards are read in after mount", async () => {
  app = await mountedApp(SEED);
  const { getPlayer } = await import('../game/player');
  const key = getPlayer().publicKeyHex;
  const entry = { s: 'genesis', v: 1, k: key.slice(0, 16), h: POKER_HANDS.PAIR.name, x: 0 };
  // The first pack's cards were dropped from the history and live only in IndexedDB; the second
  // pack, opened later, has the same cards in the history.
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([
    { ...entry, n: 0, t: 1000 },
    { ...entry, n: 1, c: CARDS, t: 2000 },
  ]));
  // jsdom has no IndexedDB: the saved-pack read waits until the test lets it land.
  const store = await import('../game/packStore');
  let release!: () => void;
  const landed = new Promise<void>((resolve) => { release = resolve; });
  const read = vi.spyOn(store, 'hydratePackStore').mockImplementation(async (_refs, signal) => {
    await landed;
    signal?.throwIfAborted();
    await store.putStoredPacks([{ setKey: 'genesis@1', publicKeyHex: key, nonce: 0, cards: SAVED }]);
    return true;
  });
  await app.mount();
  await app.settle(500);

  expect(read).toHaveBeenCalled();
  // Nothing is credited from the history while a pack in it can't be read yet.
  expect(achievements().two_of_kind).toBeUndefined();
  expect(achievements().all_commons_pack).toBeUndefined();
  expect(achievements().stacked).toBeUndefined();
  // The level isn't known yet: only the rewards that need none apply, and the choice is kept.
  expect(document.documentElement.dataset.cardBack).toBe('classic');
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS)!).cardBack).toBe('midnight');

  release();
  await app.until('history achievements credited to the first pack', () => {
    for (const id of ['two_of_kind', 'all_commons_pack']) {
      const unlocked = achievements()[id];
      expect(unlocked, id).toMatchObject({ unlockedAt: 1000, ref: { nonce: 0 } });
      expect(unlocked.pack, id).toHaveLength(5);
    }
    // Finishes from the history are checked once its packs are all readable, not before.
    expect(achievements().stacked).toBeDefined();
  });
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS)!).cardBack).toBe('midnight');
});

// Another player's pack from an earlier save on this device, whose cards only IndexedDB has.
const FOREIGN = { s: 'genesis', v: 1, k: 'ff'.repeat(8), h: POKER_HANDS.NO_MATCH.name, x: 0, n: 0, t: 500 };

it("never stores this tab's achievements over a save another tab imported or switched to", async () => {
  app = await mountedApp(SEED);
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([FOREIGN]));
  // Reading the other player's pack waits until it's aborted, so the history isn't ready yet.
  const store = await import('../game/packStore');
  vi.spyOn(store, 'hydratePackStore').mockImplementation(async (_refs, signal) => {
    signal?.throwIfAborted();
    return new Promise<boolean>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
  });
  await app.mount();
  await app.settle(500);

  // Another tab imports a save: a new player, with packs whose achievements its save already has.
  localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '0b'.repeat(32), name: 'Imported', nextNonce: 2, createdAt: 2 }));
  const { getPlayer } = await import('../game/player');
  const entry = { s: 'genesis', v: 1, k: getPlayer().publicKeyHex.slice(0, 16), h: POKER_HANDS.PAIR.name, x: 0 };
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([{ ...entry, n: 0, c: SAVED, t: 3000 }, { ...entry, n: 1, c: CARDS, t: 4000 }]));
  const imported = { first_pack: { unlockedAt: 1234 } };
  localStorage.setItem(STORAGE_KEYS.ACHIEVEMENTS, JSON.stringify(imported));
  await app.interact(() => window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-player-v1' })));
  await app.settle(500);

  // This tab's achievements belong to the player it loaded: nothing is unlocked from the new
  // player's history, so nothing is written over their save (or reported as unsaved).
  expect(achievements()).toEqual(imported);
  expect(document.body.textContent).not.toContain("Some changes couldn't be saved");
  // Its level stays the loaded player's too: the new player's packs are no level-up here.
  expect(document.body.textContent).not.toContain('Level up');
});

it("keeps achievements a pack unlocks in a tab another player's save replaced out of that save", async () => {
  app = await mountedApp(SEED, { hallOfFame: [] });
  await app.mount();
  // Another tab switches to a different player, whose save has an achievement this tab's doesn't.
  localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '0b'.repeat(32), name: 'Imported', nextNonce: 0, createdAt: 2 }));
  localStorage.setItem(STORAGE_KEYS.HISTORY, '[]');
  const imported = { all_commons_pack: { unlockedAt: 1234 } };
  localStorage.setItem(STORAGE_KEYS.ACHIEVEMENTS, JSON.stringify(imported));
  // No storage event reaches this tab first (once one does, it opens no packs: crossTabSave covers that).

  // This tab opens a pack: its first, so it unlocks achievements here, which aren't stored over the
  // other player's; the tab says its save changed elsewhere instead.
  await openAPack();
  await app.settle(100);
  expect(document.body.textContent).toMatch(/\d+ achievements unlocked/);
  expect(achievements()).toEqual(imported);
  expect(document.body.textContent).toContain('This save changed in another tab');
});

it("unlocks achievements from your own packs when another player's saved pack can't be read", async () => {
  app = await mountedApp(SEED);
  const { getPlayer } = await import('../game/player');
  const entry = { s: 'genesis', v: 1, k: getPlayer().publicKeyHex.slice(0, 16), h: POKER_HANDS.PAIR.name, x: 0 };
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([FOREIGN, { ...entry, n: 0, c: CARDS, t: 2000 }, { ...entry, n: 1, c: CARDS, t: 3000 }]));
  const store = await import('../game/packStore');
  vi.spyOn(store, 'hydratePackStore').mockRejectedValue(new Error('disk'));
  await app.mount();

  await app.until('your own packs credited despite the failed read', () => {
    const unlocked = achievements().two_of_kind;
    expect(unlocked).toMatchObject({ unlockedAt: 2000, ref: { nonce: 0 } });
    expect(unlocked.pack).toHaveLength(5);
  });
  expect(app.takeErrors(/Reading saved packs failed/).length).toBeGreaterThan(0);
});

it('toasts a level-up when the same player levels up after their saved packs are read in', async () => {
  // 19 packs of the same cards: 110 XP for the first (4 new cards), 10 for each after, so 290 XP
  // (level 2), and the next pack (at least 10 XP) reaches level 3.
  app = await mountedApp({ ...SEED, 'brainrot-player-v1': JSON.stringify({ secretKey: '0a'.repeat(32), name: 'Mounted fixture', nextNonce: 19, createdAt: 1 }) });
  const { getPlayer } = await import('../game/player');
  const key = getPlayer().publicKeyHex;
  const entry = { s: 'genesis', v: 1, k: key.slice(0, 16), h: POKER_HANDS.PAIR.name, x: 0 };
  // The first pack's cards live only in IndexedDB, so the level waits for the async read.
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([
    { ...entry, n: 0, t: 1000 },
    ...Array.from({ length: 18 }, (_, i) => ({ ...entry, n: i + 1, c: CARDS, t: 2000 + i })),
  ]));
  const store = await import('../game/packStore');
  let release!: () => void;
  const landed = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(store, 'hydratePackStore').mockImplementation(async (_refs, signal) => {
    await landed;
    signal?.throwIfAborted();
    await store.putStoredPacks([{ setKey: 'genesis@1', publicKeyHex: key, nonce: 0, cards: SAVED }]);
    return true;
  });
  await app.mount();
  await app.settle(500);

  // The read lands: the level becomes known (2), which isn't a level-up, so no toast says so.
  release();
  await app.until('the saved packs are read in', () => expect(achievements().two_of_kind).toBeDefined());
  for (let elapsed = 0; elapsed < 8000; elapsed += 250) {
    await app.settle(250);
    expect(toasts()).not.toContain('Level up');
  }

  // The same player opens a pack and reaches level 3: that is a level-up, toasted from level 2.
  await openAPack();
  await app.until('the level-up toast shows', () => {
    expect(toasts()).toContain('Level up');
    expect(toasts()).toContain('Level 3');
    expect(toasts()).toContain('Unlocked the title Pack Rat');
  });
});

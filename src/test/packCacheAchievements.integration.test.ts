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
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false, cardBack: 'midnight' }),
  [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
};

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

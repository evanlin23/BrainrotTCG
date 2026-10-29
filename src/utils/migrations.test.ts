import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import type { CollectionItem } from '../types';
import { ALL_CARDS, cardPoints, getCard, type Card } from '../data/cards';
import { collectionRecoveryFile, collectionRecoveryPrint, discardCollectionRecovery, persistCollection } from '../game/collectionRecovery';
import { recordPack } from '../game/packProgress';
import { isCardOwned, ownedCount } from '../game/versions';
import { getAccountValue } from './achievementChecks';
import { collectionNeedsRecovery, collectionNeedsRepair, DATA_VERSION_KEY, hydrateCollection, runMigrations } from './migrations';

const current = ALL_CARDS[0];
const unknown: Card = {
  key: 'retired/missing-card', setId: 'retired', id: 'missing-card',
  name: 'Historical card', rarity: 'RARE', image: '/historical.webp',
  caption: 'Stored caption', flavor: 'Stored flavor',
};

describe('collection hydration', () => {
  it.each([null, undefined, false, 42, 'collection', [], [{ card: current }]])('ignores a non-map container: %j', (value) => {
    expect(hydrateCollection(value)).toEqual({});
  });

  it('retains readable entries beside malformed records without changing map keys or counts', () => {
    const retained = {
      card: { id: current.id, key: current.key }, normalCount: 3, holoCount: 2,
      count: 8, finishes: { GOLD: 1 }, misprints: 1, modifierPoints: 7,
    };
    const malformed = [
      null, undefined, false, 0, '', [], {},
      { card: null }, { card: 1 }, { card: [] }, { card: 'card' },
      { card: {} }, { card: { id: null } }, { card: { id: 4 } },
      { card: { id: [] } }, { card: { id: {} } },
      { card: { id: current.id, key: 4 } },
    ];
    const collection = { retained, ...Object.fromEntries(malformed.map((value, index) => [`bad-${index}`, value])) };
    expect(hydrateCollection(collection)).toEqual({ retained: { ...retained, card: current } });
  });

  it('refreshes a known card from the registry and retains unrelated stored card metadata', () => {
    const card = { ...current, name: 'Stale name', image: '/stale.webp', note: 'Keep this metadata' };
    expect(hydrateCollection({ originalKey: { card, normalCount: 1, holoCount: 0 } })).toEqual({
      originalKey: { card: { ...current, note: 'Keep this metadata' }, normalCount: 1, holoCount: 0 },
    });
  });

  it('resolves a legacy image-file ID without replacing its original collection key', () => {
    const legacyCard = getCard('genesis/chimpanzini-bananini');
    expect(legacyCard).toBeDefined();
    expect(hydrateCollection({ image: { card: { id: 'image' }, count: 2 } })).toEqual({
      image: { card: legacyCard, count: 2 },
    });
  });

  it('retains a complete unknown historical card, including the fallback for a missing key', () => {
    const { key: _key, ...withoutKey } = unknown;
    expect(hydrateCollection({
      explicit: { card: unknown, normalCount: 1, holoCount: 1 },
      fallback: { card: withoutKey, normalCount: 2, holoCount: 0 },
    })).toEqual({
      explicit: { card: unknown, normalCount: 1, holoCount: 1 },
      fallback: { card: { ...withoutKey, key: 'genesis/missing-card' }, normalCount: 2, holoCount: 0 },
    });
  });

  it('skips unknown records whose display fields cannot be read safely', () => {
    const invalid = [
      { id: 'missing' }, { ...unknown, name: {} }, { ...unknown, image: null },
      { ...unknown, setId: false }, { ...unknown, rarity: 'NONEXISTENT' },
      { ...unknown, rarity: 'toString' }, { ...unknown, caption: {} }, { ...unknown, flavor: [] },
    ];
    expect(hydrateCollection(Object.fromEntries(invalid.map((card, index) => [String(index), { card }])))).toEqual({});
  });

  it('does not mutate the parsed input or remove corrupt records from the original saved payload', () => {
    const raw = JSON.stringify({
      keep: { card: { id: current.id, key: current.key }, normalCount: 1, holoCount: 0 },
      corrupt: null,
    });
    const parsed = JSON.parse(raw);
    Object.freeze(parsed.keep.card);
    Object.freeze(parsed.keep);
    Object.freeze(parsed);
    const hydrated = hydrateCollection(parsed);
    expect(hydrated.keep.card).toEqual(current);
    expect(hydrated).not.toHaveProperty('corrupt');
    expect(JSON.stringify(parsed)).toBe(raw);
    expect(parsed.corrupt).toBeNull();
    expect(hydrated.keep).not.toBe(parsed.keep);
  });
});

describe('v2 collection migration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps records that are not cards so they stay recoverable instead of dropping them', () => {
    const store = new Map<string, string>([[STORAGE_KEYS.COLLECTION, JSON.stringify({
      image: { card: { id: 'image' }, count: 2 },
      'genesis/chimpanzini-bananini': 'lost',
      broken: 7,
      gone: null,
      list: [1],
    })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });
    runMigrations();
    const migrated = JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!) as Record<string, unknown>;
    expect(migrated).toMatchObject({
      'genesis/chimpanzini-bananini': { normalCount: 2, holoCount: 0 },
      'genesis/chimpanzini-bananini#unreadable': 'lost',
      broken: 7,
      gone: null,
      list: [1],
    });
    expect(Object.keys(hydrateCollection(migrated))).toEqual(['genesis/chimpanzini-bananini']);
    expect(collectionNeedsRecovery(migrated)).toBe(true);
    expect(store.get('brainrot-data-version')).toBe('3');
  });
});

describe('repairing bad copy counts when the save loads (#1109)', () => {
  const stub = (store: Map<string, string>, fail?: (key: string) => boolean) => vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail?.(key)) throw new DOMException('full', 'QuotaExceededError');
      store.set(key, value);
    },
    removeItem: (key: string) => { store.delete(key); },
  });
  const ARCHIVE = STORAGE_KEYS.COLLECTION_RECOVERY;
  const ref = { id: current.id, key: current.key };
  afterEach(() => {
    // collectionRecovery keeps payloads storage refused in memory for the visit: forget them between tests.
    stub(new Map());
    expect(discardCollectionRecovery(collectionRecoveryPrint())).toBe('discarded');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('repairs a mixed-sign and a fully negative entry, and every reader sees the same copies', () => {
    const raw = JSON.stringify({
      mixed: { card: ref, normalCount: -3, holoCount: 2 },
      negative: { card: ref, normalCount: -3, holoCount: -1, count: -4 },
      fractional: { card: ref, normalCount: 2.5, holoCount: '1' },
    });
    const parsed = JSON.parse(raw);
    const loaded = hydrateCollection(parsed) as Record<string, CollectionItem>;
    expect(loaded.mixed).toMatchObject({ normalCount: 0, holoCount: 2 });
    expect(loaded.negative).toMatchObject({ normalCount: 0, holoCount: 0, count: 0 });
    expect(loaded.fractional).toMatchObject({ normalCount: 2, holoCount: 0 });
    expect(JSON.stringify(parsed)).toBe(raw);
    // The next write keeps the stored bytes aside first; a save file with such a count is still refused.
    expect(collectionNeedsRepair(parsed)).toBe(true);
    expect(collectionNeedsRecovery(parsed)).toBe(false);

    expect([ownedCount(loaded.mixed), isCardOwned(loaded.mixed)]).toEqual([2, true]);
    expect([ownedCount(loaded.negative), isCardOwned(loaded.negative)]).toEqual([0, false]);
    expect(getAccountValue({ mixed: loaded.mixed, negative: loaded.negative }))
      .toBe(2 * cardPoints(current.rarity, true));
  });

  it('adds a pull to the repaired count, not to the stored negative one', () => {
    const loaded = hydrateCollection({ [current.key]: { card: ref, normalCount: -3, holoCount: 2 } }) as Record<string, CollectionItem>;
    const pulled = { ...current, uniqueId: 1, isRevealed: true, isHolo: false };
    const pack = { cards: [pulled], setId: current.setId, setVersion: 1, nonce: 1, publicKeyHex: 'ab'.repeat(32) };
    const { progress } = recordPack({ stats: { packsOpened: 0, holoCards: {} }, collection: loaded, hallOfFame: {} }, pack, {});
    expect(progress.collection[current.key]).toMatchObject({ normalCount: 1, holoCount: 2 });
  });

  it('keeps the stored bytes aside on the next write, so the raw counts can be recovered', () => {
    const raw = JSON.stringify({ [current.key]: { card: ref, normalCount: -3, holoCount: 2 } });
    const store = new Map<string, string>([[STORAGE_KEYS.COLLECTION, raw], ['brainrot-player-v1', '{"id":"me"}']]);
    stub(store);
    const loaded = hydrateCollection(JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!));
    expect(persistCollection(loaded)).toBe('recovered');
    expect(JSON.parse(store.get(ARCHIVE)!)).toEqual({ raw, player: '{"id":"me"}' });
    expect(JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!)[current.key]).toMatchObject({ normalCount: 0, holoCount: 2 });
    // The repaired save is valid, so later writes keep nothing more.
    expect(persistCollection(loaded)).toBe('saved');
  });

  it('reads a valid save unchanged, byte for byte, and keeps nothing aside', () => {
    const raw = JSON.stringify({
      [current.key]: { card: current, normalCount: 3, holoCount: 0, count: 3, finishes: { GOLD: 1 } },
      migrated: { card: current, normalCount: null, holoCount: 1 },
    });
    const parsed = JSON.parse(raw);
    expect(JSON.stringify(hydrateCollection(parsed))).toBe(raw);
    expect(collectionNeedsRepair(parsed)).toBe(false);
    const store = new Map<string, string>([[STORAGE_KEYS.COLLECTION, raw]]);
    stub(store);
    expect(persistCollection(hydrateCollection(parsed))).toBe('saved');
    expect(store.has(ARCHIVE)).toBe(false);
  });

  it('repairs v1 counts in migration after keeping the original collection aside', () => {
    const raw = JSON.stringify({
      image: { card: { id: 'image' }, normalCount: -3, holoCount: 2 },
      [current.key]: { card: ref, count: -5, holoCount: -1 },
    });
    const store = new Map<string, string>([[STORAGE_KEYS.COLLECTION, raw]]);
    stub(store);
    expect(runMigrations()).toBe(true);
    const migrated = JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!);
    expect(migrated['genesis/chimpanzini-bananini']).toMatchObject({ normalCount: 0, holoCount: 2 });
    expect(migrated[current.key]).toMatchObject({ normalCount: 0, holoCount: 0 });
    expect(collectionNeedsRepair(migrated)).toBe(false);
    expect(JSON.parse(store.get(ARCHIVE)!)).toEqual({ raw, player: null });
    expect(store.get(DATA_VERSION_KEY)).toBe('3');
  });

  it('migrates valid v1 counts as before, keeping nothing aside', () => {
    const store = new Map<string, string>([[STORAGE_KEYS.COLLECTION, JSON.stringify({ image: { card: { id: 'image' }, count: 2, holoCount: 1 } })]]);
    stub(store);
    expect(runMigrations()).toBe(true);
    expect(JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!)['genesis/chimpanzini-bananini']).toMatchObject({ normalCount: 2, holoCount: 1 });
    expect(store.has(ARCHIVE)).toBe(false);
  });

  it('keeps the original for this visit when storage is full, and loses nothing when the repair write fails', () => {
    const raw = JSON.stringify({ image: { card: { id: 'image' }, normalCount: -3, holoCount: 2 } });
    const store = new Map<string, string>([[STORAGE_KEYS.COLLECTION, raw]]);
    stub(store, () => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runMigrations()).toBe(false);
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(raw);
    expect(store.has(DATA_VERSION_KEY)).toBe(false);
    expect(JSON.parse(collectionRecoveryFile()!.text)).toEqual({ raw, player: null });

    // Room again: the retry repairs, and the original it kept this visit is still there to download, once.
    stub(store);
    expect(runMigrations()).toBe(true);
    expect(JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!)['genesis/chimpanzini-bananini']).toMatchObject({ normalCount: 0, holoCount: 2 });
    expect(JSON.parse(collectionRecoveryFile()!.text)).toEqual({ raw, player: null });
  });
});

describe('legacy record shape validation (#660)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('recovers null or malformed elements in legacy v1 stats highestPackCards without throwing or fabricating verified progress', () => {
    const store = new Map<string, string>([
      [STORAGE_KEYS.STATS, JSON.stringify({
        packsOpened: 5,
        holoCards: { image: true },
        highestPackValue: 50,
        highestPackCards: [null],
      })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });

    expect(() => runMigrations()).not.toThrow();

    const stats = JSON.parse(store.get(STORAGE_KEYS.STATS)!) as Record<string, unknown>;
    expect(stats.highestPackCards).toEqual([]);
    expect(stats.highestPackCardsUnreadable).toEqual([null]);
    expect(stats.highestPackLegacy).toBeUndefined();
    expect(stats.highestPackFlexValue).toBeUndefined();
    expect(stats.highestPackValue).toBe(50);
    expect(stats.holoCards).toEqual({ 'genesis/chimpanzini-bananini': true });
    expect(store.get(DATA_VERSION_KEY)).toBe('3');
  });

  it('recovers null elements in v2 stats when exercising v3 migration directly', () => {
    const store = new Map<string, string>([
      [DATA_VERSION_KEY, '2'],
      [STORAGE_KEYS.STATS, JSON.stringify({
        packsOpened: 2,
        holoCards: { 'genesis/chimpanzini-bananini': true },
        highestPackValue: 40,
        highestPackCards: [null, undefined, 42],
      })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });

    expect(() => runMigrations()).not.toThrow();

    const stats = JSON.parse(store.get(STORAGE_KEYS.STATS)!) as Record<string, unknown>;
    expect(stats.highestPackCards).toEqual([]);
    expect(stats.highestPackCardsUnreadable).toEqual([null, null, 42]); // JSON.stringify serializes undefined as null in arrays
    expect(stats.highestPackValue).toBe(40);
    expect(stats.highestPackFlexValue).toBeUndefined();
    expect(store.get(DATA_VERSION_KEY)).toBe('3');
  });

  it('retains readable cards and preserves unreadable items in mixed highestPackCards arrays', () => {
    const store = new Map<string, string>([
      [STORAGE_KEYS.STATS, JSON.stringify({
        packsOpened: 1,
        holoCards: {},
        highestPackValue: 30,
        highestPackCards: [
          { id: 'image', isHolo: true },
          null,
          { id: 'image2' },
          'not-a-card',
          { id: null },
        ],
      })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });

    expect(() => runMigrations()).not.toThrow();

    const stats = JSON.parse(store.get(STORAGE_KEYS.STATS)!) as Record<string, unknown>;
    expect(stats.highestPackCards).toHaveLength(2);
    expect((stats.highestPackCards as Array<{ key: string }>).map((c) => c.key)).toEqual([
      'genesis/chimpanzini-bananini',
      'genesis/amogus',
    ]);
    expect(stats.highestPackCardsUnreadable).toEqual([
      null,
      'not-a-card',
      { id: null },
    ]);
    expect(stats.highestPackLegacy).toBe(true);
    // Not scored as if the readable subset were the whole pack: the legacy value stays.
    expect(stats.highestPackFlexValue).toBeUndefined();
    expect(stats.highestPackValue).toBe(30);
    expect(store.get(DATA_VERSION_KEY)).toBe('3');
  });

  it('retains unreadable achievement pack elements under unreadablePack without throwing', () => {
    const store = new Map<string, string>([
      [STORAGE_KEYS.ACHIEVEMENTS, JSON.stringify({
        firstPack: {
          unlockedAt: 1234567,
          pack: [null, { id: 'image' }, false],
        },
      })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });

    expect(() => runMigrations()).not.toThrow();

    const achievements = JSON.parse(store.get(STORAGE_KEYS.ACHIEVEMENTS)!) as Record<string, Record<string, unknown>>;
    expect(achievements.firstPack.unlockedAt).toBe(1234567);
    expect(achievements.firstPack.pack).toHaveLength(1);
    expect((achievements.firstPack.pack as Array<{ key: string }>)[0].key).toBe('genesis/chimpanzini-bananini');
    expect(achievements.firstPack.unreadablePack).toEqual([null, false]);
  });
});

describe('migration retry and storage failure safety (#659)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not advance version marker when collection write fails under quota pressure, and succeeds on retry', () => {
    const initialCollection = JSON.stringify({
      image: { card: { id: 'image' }, count: 2 },
    });
    const store = new Map<string, string>([
      [STORAGE_KEYS.COLLECTION, initialCollection],
    ]);

    let failCollection = true;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failCollection && key === STORAGE_KEYS.COLLECTION) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        store.set(key, value);
      },
    });

    // Run migrations while storage quota refuses collection write but would allow version marker
    const firstRun = runMigrations();
    expect(firstRun).toBe(false);
    expect(store.get(DATA_VERSION_KEY)).toBeUndefined();
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(initialCollection);

    // Relieve quota pressure and retry
    failCollection = false;
    const retryRun = runMigrations();
    expect(retryRun).toBe(true);
    expect(store.get(DATA_VERSION_KEY)).toBe('3');

    const migrated = JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!) as Record<string, unknown>;
    expect(migrated).toMatchObject({
      'genesis/chimpanzini-bananini': { normalCount: 2, holoCount: 0 },
    });
  });

  it('advances to version 2 when v2 succeeds but v3 fails, keeping v3 retryable', () => {
    const store = new Map<string, string>([
      [STORAGE_KEYS.COLLECTION, JSON.stringify({ image: { card: { id: 'image' }, count: 2 } })],
      [STORAGE_KEYS.STATS, JSON.stringify({
        packsOpened: 1,
        highestPackValue: 10,
        highestPackCards: [{ id: 'image' }],
      })],
    ]);

    // In v2, let collection and stats write succeed.
    // In v3, fail stats write.
    let writes = 0;
    const originalSetItem = (key: string, value: string) => {
      writes++;
      // Collection write = 1, Stats write = 2, Version 2 write = 3, then V3 stats write = 4
      if (writes === 4 && key === STORAGE_KEYS.STATS) {
        throw new DOMException('Storage full', 'QuotaExceededError');
      }
      store.set(key, value);
    };
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: originalSetItem,
    });

    const firstRun = runMigrations();
    expect(firstRun).toBe(false);
    expect(store.get(DATA_VERSION_KEY)).toBe('2');

    // Remove storage fault and retry: v2 is skipped, v3 succeeds and advances to 3
    const setCollectionSpy = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === STORAGE_KEYS.COLLECTION) setCollectionSpy();
        store.set(key, value);
      },
    });

    const retryRun = runMigrations();
    expect(retryRun).toBe(true);
    expect(store.get(DATA_VERSION_KEY)).toBe('3');
    // Collection was not rewritten because v2 was already complete
    expect(setCollectionSpy).not.toHaveBeenCalled();

    const stats = JSON.parse(store.get(STORAGE_KEYS.STATS)!) as Record<string, unknown>;
    expect(stats.highestPackValue).toBeUndefined();
    expect(typeof stats.highestPackFlexValue).toBe('number');
  });

  it('makes retry after a partially completed stage idempotent without duplicating counts or score conversion', () => {
    const store = new Map<string, string>([
      [STORAGE_KEYS.COLLECTION, JSON.stringify({
        image: { card: { id: 'image' }, count: 2 },
        broken: 'unreadable-val',
      })],
      [STORAGE_KEYS.STATS, JSON.stringify({
        packsOpened: 1,
        highestPackValue: 15,
        highestPackCards: [{ id: 'image' }],
      })],
    ]);

    // Let collection write succeed, but fail stats write in v2
    let statsFailed = true;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (statsFailed && key === STORAGE_KEYS.STATS) {
          throw new DOMException('Stats write failed', 'QuotaExceededError');
        }
        store.set(key, value);
      },
    });

    const firstAttempt = runMigrations();
    expect(firstAttempt).toBe(false);
    // Version is still absent because v2 did not complete all writes
    expect(store.get(DATA_VERSION_KEY)).toBeUndefined();

    // Now permit all writes and retry
    statsFailed = false;
    const retryAttempt = runMigrations();
    expect(retryAttempt).toBe(true);
    expect(store.get(DATA_VERSION_KEY)).toBe('3');

    const collection = JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!) as Record<string, unknown>;
    // Counts must not be duplicated (normalCount should be 2, not 4)
    expect(collection['genesis/chimpanzini-bananini']).toEqual(expect.objectContaining({
      normalCount: 2,
      holoCount: 0,
    }));
    // Unreadable key must not be multiplied into #unreadable#unreadable
    expect(collection['broken']).toBe('unreadable-val');
    expect(collection['broken#unreadable']).toBeUndefined();

    const stats = JSON.parse(store.get(STORAGE_KEYS.STATS)!) as Record<string, unknown>;
    expect(stats.highestPackFlexValue).toBe(10); // 10 (common card points) * 1 (multiplier) = 10
    expect(stats.highestPackValue).toBeUndefined();
  });
});

describe('nothing to migrate, or nothing readable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lets the game start when storage cannot be read at all', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
    });
    expect(runMigrations()).toBe(true);
  });

  it('lets a new player start even when the version marker cannot be written', () => {
    const setItem = vi.fn(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem });
    expect(runMigrations()).toBe(true);
    expect(setItem).toHaveBeenCalledWith(DATA_VERSION_KEY, '3');
  });
});

describe('v3 when scoring fails', () => {
  afterEach(() => {
    vi.doUnmock('../data/cards');
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('writes nothing and keeps the stage retryable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('../data/cards', async (original) => ({
      ...await original<typeof import('../data/cards')>(),
      scoreCards: () => { throw new Error('scoring broke'); },
    }));
    const migrations = await import('./migrations');
    const legacyStats = JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 12, highestPackCards: [{ id: 'image' }] });
    const store = new Map<string, string>([[DATA_VERSION_KEY, '2'], [STORAGE_KEYS.STATS, legacyStats]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });

    expect(migrations.runMigrations()).toBe(false);
    expect(store.get(DATA_VERSION_KEY)).toBe('2');
    expect(store.get(STORAGE_KEYS.STATS)).toBe(legacyStats);
  });
});

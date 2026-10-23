import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import type { CollectionItem, Stats } from '../types';
import { getSet } from '../content/sets';
import { collectionRecoveryFile, collectionRecoveryNote, collectionRecoveryPrint, COLLECTION_RECOVERY_NOTES, discardCollectionRecovery, persistCollection, STATS_REBUILT_NOTE } from './collectionRecovery';
import { recordPack } from './history';
import { exportSaveFile, isStats, isValidSaveValue } from './saveFile';
import { emptyStats, loadStats, persistStats } from './statsRecovery';
import { CURRENT_DATA_VERSION } from '../utils/migrations';
import type { OpenedPack } from './pulls';

const KEY = 'ab'.repeat(32);
vi.mock('./player', async (importOriginal) => ({ ...await importOriginal<typeof import('./player')>(), getPlayer: () => ({ publicKeyHex: 'ab'.repeat(32) }) }));

const PLAYER = JSON.stringify({ secretKey: 'cd'.repeat(32), name: 'Kept', nextNonce: 3, createdAt: 1 });
let data: Map<string, string>;
let refuseReads: boolean;
let refuseWrites: Set<string>;
beforeEach(() => {
  data = new Map([['brainrot-player-v1', PLAYER]]);
  refuseReads = false;
  refuseWrites = new Set();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (refuseReads) throw new DOMException('denied', 'SecurityError');
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (refuseWrites.has(k)) throw new DOMException('full', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => data.delete(k),
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Clears what an earlier test kept aside, for this visit too.
  discardCollectionRecovery(collectionRecoveryPrint());
});

// Five cards of a released set, the second one holo: the pack the history records.
const SET = getSet('right-now', 2)!;
const IDS = SET.cards.slice(0, 5).map((card) => card.id);
const pack = (nonce: number, holo = 1) => ({
  setId: SET.id, setVersion: SET.version, nonce, publicKeyHex: KEY,
  cards: IDS.map((id, i) => ({ id, isHolo: i === holo })),
  score: { hand: { name: 'Pair' }, score: 100 + nonce },
  openedAt: 1_000 + nonce,
}) as unknown as OpenedPack;
const opened = (...nonces: number[]) => { for (const nonce of nonces) expect(recordPack(pack(nonce))).toBe(true); };

const holoItem = (key: string): CollectionItem => ({ card: { key } as CollectionItem['card'], normalCount: 0, holoCount: 1 });
const kept = () => JSON.parse(collectionRecoveryFile()!.text) as { raw: string; player: string | null; key?: string; later?: { raw: string; key?: string }[] };

describe('loadStats', () => {
  it("gives a new player's stats when none are stored, and keeps nothing aside", () => {
    expect(loadStats({})).toEqual({ stats: emptyStats(), counted: new Set(), rebuilt: false });
    expect(collectionRecoveryFile()).toBeNull();
  });

  it('loads readable stats as stored, kept nothing aside and counting nothing again', () => {
    opened(0, 1);
    const stats: Stats = { packsOpened: 7, holoCards: { 'right-now/x': true }, highestPackFlexValue: 9 };
    data.set(STORAGE_KEYS.STATS, JSON.stringify(stats));
    expect(loadStats({})).toEqual({ stats, counted: new Set(), rebuilt: false });
    expect(collectionRecoveryFile()).toBeNull();
  });

  it.each([
    ['unparseable bytes', '\u0000ÿ{not json'],
    ['a list', '[1,2,3]'],
    ['a number', '42'],
    ['null', 'null'],
  ])('keeps stats stored as %s aside and rebuilds them from the history and collection', (_, raw) => {
    opened(0, 1, 2);
    data.set(STORAGE_KEYS.STATS, raw);
    const { stats, counted } = loadStats({ [`right-now/${IDS[4]}`]: holoItem(`right-now/${IDS[4]}`) });
    expect(stats.packsOpened).toBe(3);
    expect([...counted].sort()).toEqual([0, 1, 2]);
    expect(stats.holoCards).toEqual({ [`right-now/${IDS[1]}`]: true, [`right-now/${IDS[4]}`]: true });
    expect(stats.highestPackRef).toEqual({ setId: 'right-now', setVersion: SET.version, nonce: expect.any(Number), publicKeyHex: KEY });
    expect(stats.highestPackCards).toHaveLength(5);
    expect(stats.highestPackFlexValue).toBeGreaterThan(0);
    expect(stats.highestPackLegacy).toBe(false);
    // Stored, they read back as they are: the next load keeps nothing more aside.
    expect(isStats(JSON.parse(JSON.stringify(stats)))).toBe(true);
    // The damaged bytes stay where they were, and a copy is kept aside with the identity they belonged to.
    expect(data.get(STORAGE_KEYS.STATS)).toBe(raw);
    expect(kept()).toEqual({ raw, player: PLAYER, key: STORAGE_KEYS.STATS });
  });

  it('rejects a negative pack count (#1053) and keeps every field still readable', () => {
    opened(0, 1);
    const raw = JSON.stringify({
      packsOpened: -1, holoCards: { 'right-now/x': true }, highestPackFlexValue: 500, highestPackHandName: 'Flush',
      highestPackRef: { setId: 'right-now', setVersion: 1, nonce: 0 }, highestPackCardsUnreadable: ['kept'],
    });
    data.set(STORAGE_KEYS.STATS, raw);
    const { stats, counted } = loadStats({});
    expect(stats).toEqual({
      packsOpened: 2, holoCards: { 'right-now/x': true, [`right-now/${IDS[1]}`]: true }, highestPackFlexValue: 500,
      highestPackHandName: 'Flush', highestPackRef: { setId: 'right-now', setVersion: 1, nonce: 0 }, highestPackCardsUnreadable: ['kept'],
    });
    expect([...counted]).toEqual(expect.arrayContaining([0, 1]));
    expect(kept().raw).toBe(raw);
  });

  it('keeps a readable pack count above the history, counting no shelved pack as counted', () => {
    opened(0);
    data.set(STORAGE_KEYS.STATS, JSON.stringify({ packsOpened: 40, holoCards: 'lost' }));
    const { stats, counted } = loadStats({});
    expect([stats.packsOpened, stats.holoCards, counted.size]).toEqual([40, { [`right-now/${IDS[1]}`]: true }, 0]);
  });

  it('rebuilds the whole best pack when any of its fields is unreadable, so it never mixes two packs', () => {
    opened(4);
    data.set(STORAGE_KEYS.STATS, JSON.stringify({ packsOpened: 1, highestPackFlexValue: 900, highestPackCards: 'lost' }));
    const { stats } = loadStats({});
    expect(stats.highestPackFlexValue).not.toBe(900);
    expect(stats.highestPackRef?.nonce).toBe(4);
    expect(stats.highestPackCards?.map((card) => card.id)).toEqual(pack(4).cards.map((card) => card.id));
  });

  it('re-scores the best pack from the history when a pack in it beats the readable one kept (#1053)', () => {
    opened(4);
    const keptBest = { highestPackValue: 1, highestPackFlexValue: 1, highestPackCards: [] };
    data.set(STORAGE_KEYS.STATS, JSON.stringify({ packsOpened: 1, holoCards: 'lost', ...keptBest }));
    expect(loadStats({}).stats.highestPackRef?.nonce).toBe(4);

    data.set(STORAGE_KEYS.STATS, JSON.stringify({ packsOpened: 1, holoCards: 'lost', ...keptBest, highestPackFlexValue: 1e9 }));
    const { stats } = loadStats({});
    expect([stats.highestPackFlexValue, stats.highestPackRef]).toEqual([1e9, undefined]);
  });

  it("counts only this player's packs from the history", () => {
    opened(0);
    recordPack({ ...pack(5), publicKeyHex: 'ef'.repeat(32) } as OpenedPack);
    data.set(STORAGE_KEYS.STATS, 'garbage');
    expect(loadStats({}).stats.packsOpened).toBe(1);
  });

  it('keeps the same damaged bytes aside once however often they load', () => {
    data.set(STORAGE_KEYS.STATS, 'garbage');
    loadStats({});
    loadStats({});
    expect(kept()).toEqual({ raw: 'garbage', player: PLAYER, key: STORAGE_KEYS.STATS });
  });

  it('counts each ticket once, even one the history holds twice', () => {
    opened(0, 1);
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!) as unknown[];
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify([...history, history[0]]));
    data.set(STORAGE_KEYS.STATS, 'garbage');
    const loaded = loadStats({});
    expect([loaded.stats.packsOpened, [...loaded.counted], loaded.rebuilt]).toEqual([2, [0, 1], true]);
  });

  it("starts empty when storage can't be read, as before", () => {
    refuseReads = true;
    expect(loadStats({}).stats).toEqual(emptyStats());
  });
});

describe('persistStats', () => {
  it('stores readable stats over readable ones', () => {
    data.set(STORAGE_KEYS.STATS, JSON.stringify({ packsOpened: 1 }));
    expect(persistStats({ packsOpened: 2, holoCards: {} })).toBe('saved');
    expect(data.get(STORAGE_KEYS.STATS)).toBe(JSON.stringify({ packsOpened: 2, holoCards: {} }));
    expect(collectionRecoveryFile()).toBeNull();
  });

  it('keeps unreadable stored stats aside before replacing them, even ones no load saw (another tab)', () => {
    data.set(STORAGE_KEYS.STATS, '{"packsOpened":"three"}');
    expect(persistStats({ packsOpened: 4, holoCards: {} })).toBe('recovered');
    expect(kept()).toEqual({ raw: '{"packsOpened":"three"}', player: PLAYER, key: STORAGE_KEYS.STATS });
    expect(JSON.parse(data.get(STORAGE_KEYS.STATS)!)).toEqual({ packsOpened: 4, holoCards: {} });
  });

  it("writes nothing over stats it couldn't read", () => {
    data.set(STORAGE_KEYS.STATS, 'garbage');
    refuseReads = true;
    expect(persistStats({ packsOpened: 4, holoCards: {} })).toBe('blocked');
    refuseReads = false;
    expect(data.get(STORAGE_KEYS.STATS)).toBe('garbage');
  });

  it('keeps them for this visit when storage is full, and says the write failed', () => {
    data.set(STORAGE_KEYS.STATS, 'garbage');
    refuseWrites = new Set([STORAGE_KEYS.COLLECTION_RECOVERY, STORAGE_KEYS.STATS]);
    expect(persistStats({ packsOpened: 4, holoCards: {} })).toBe('blocked');
    expect(data.get(STORAGE_KEYS.STATS)).toBe('garbage');
    expect(kept()).toEqual({ raw: 'garbage', player: PLAYER, key: STORAGE_KEYS.STATS });
    expect(collectionRecoveryNote()).toMatch(/^Unreadable stats data was kept aside, but this browser had no room to store it/);
  });

  it('leaves them stored while their copy is held only for this visit, though the stats would fit', () => {
    data.set(STORAGE_KEYS.STATS, 'garbage');
    refuseWrites = new Set([STORAGE_KEYS.COLLECTION_RECOVERY]);
    expect(persistStats({ packsOpened: 4, holoCards: {} })).toBe('blocked');
    expect(persistStats({ packsOpened: 5, holoCards: {} })).toBe('blocked');
    expect(data.get(STORAGE_KEYS.STATS)).toBe('garbage');
    expect(kept()).toEqual({ raw: 'garbage', player: PLAYER, key: STORAGE_KEYS.STATS });
  });

  it('replaces discarded stats without keeping them aside again, even ones held only for this visit', () => {
    opened(0);
    data.set(STORAGE_KEYS.STATS, 'garbage');
    refuseWrites = new Set([STORAGE_KEYS.COLLECTION_RECOVERY]);
    const { stats } = loadStats({});
    expect(persistStats(stats)).toBe('blocked');
    expect(discardCollectionRecovery(collectionRecoveryPrint())).toBe('discarded');
    expect(persistStats(stats)).toBe('saved');
    expect(collectionRecoveryFile()).toBeNull();
    // The next load finds them readable: nothing is kept aside again.
    refuseWrites = new Set();
    expect(loadStats({})).toEqual({ stats, counted: new Set(), rebuilt: false });
    expect(collectionRecoveryFile()).toBeNull();
  });

  it('keeps stored bytes aside again once they differ from the discarded ones', () => {
    data.set(STORAGE_KEYS.STATS, 'garbage');
    loadStats({});
    discardCollectionRecovery(collectionRecoveryPrint());
    data.set(STORAGE_KEYS.STATS, 'other garbage');
    expect(persistStats({ packsOpened: 1, holoCards: {} })).toBe('recovered');
    expect(kept()).toEqual({ raw: 'other garbage', player: PLAYER, key: STORAGE_KEYS.STATS });
  });
});

describe('exported stats', () => {
  it.each([['unparseable', 'garbage'], ['the wrong shape', '{"packsOpened":-1,"holoCards":{"right-now/x":true}}']])(
    'rebuilds %s stored stats in a backup, so the file imports again', (_, damaged) => {
      opened(0, 1);
      data.set(STORAGE_KEYS.STATS, damaged);
      refuseWrites = new Set([STORAGE_KEYS.COLLECTION_RECOVERY]);
      const loaded = loadStats({});
      const file = JSON.parse(exportSaveFile()) as { stats: string };
      expect(JSON.parse(file.stats)).toEqual(loaded.stats);
      expect(isValidSaveValue(STORAGE_KEYS.STATS, file.stats, CURRENT_DATA_VERSION)).toBe(true);
      expect(data.get(STORAGE_KEYS.STATS)).toBe(damaged);
    });

  it('carries the damaged stats kept aside for this visit only, while storage has no room for them (#1053)', () => {
    data.set(STORAGE_KEYS.STATS, 'garbage');
    refuseWrites = new Set([STORAGE_KEYS.COLLECTION_RECOVERY]);
    loadStats({});
    const file = JSON.parse(exportSaveFile()) as { collectionRecovery: string };
    expect(JSON.parse(file.collectionRecovery)).toEqual({ raw: 'garbage', player: PLAYER, key: STORAGE_KEYS.STATS });
    expect(isValidSaveValue(STORAGE_KEYS.COLLECTION_RECOVERY, file.collectionRecovery, CURRENT_DATA_VERSION)).toBe(true);
  });

  it("leaves out another player's data kept aside for this visit, once a different save is stored (#1053)", () => {
    data.set(STORAGE_KEYS.STATS, 'garbage');
    refuseWrites = new Set([STORAGE_KEYS.COLLECTION_RECOVERY]);
    loadStats({});
    const other = JSON.stringify({ secretKey: 'ef'.repeat(32), name: 'Other', nextNonce: 3, createdAt: 2 });
    data.set('brainrot-player-v1', other);
    expect((JSON.parse(exportSaveFile()) as { collectionRecovery: string | null }).collectionRecovery).toBeNull();
    data.set('brainrot-player-v1', JSON.stringify({ ...(JSON.parse(PLAYER) as object), nextNonce: 9 }));
    const file = JSON.parse(exportSaveFile()) as { collectionRecovery: string };
    expect(JSON.parse(file.collectionRecovery)).toEqual({ raw: 'garbage', player: PLAYER, key: STORAGE_KEYS.STATS });
  });

  it('exports stored kept-aside data byte for byte when this visit added none', () => {
    const raw = JSON.stringify({ raw: 'garbage', player: PLAYER, key: STORAGE_KEYS.STATS }, null, 2);
    data.set(STORAGE_KEYS.COLLECTION_RECOVERY, raw);
    expect((JSON.parse(exportSaveFile()) as { collectionRecovery: string }).collectionRecovery).toBe(raw);
  });

  it('exports readable stats byte for byte', () => {
    const raw = JSON.stringify({ packsOpened: 3, holoCards: {} });
    data.set(STORAGE_KEYS.STATS, raw);
    expect((JSON.parse(exportSaveFile()) as { stats: string }).stats).toBe(raw);
  });
});

describe('the kept-aside note', () => {
  it('says which data was kept aside, and that the stats were rebuilt', () => {
    data.set(STORAGE_KEYS.STATS, 'garbage');
    loadStats({});
    expect(collectionRecoveryNote()).toBe(`Unreadable stats data was kept aside in this browser. Download a copy, or discard it if you don't need it. Backups include it too. ${STATS_REBUILT_NOTE} It may include your secret player key. Keep the file private and never attach it to a public bug report.`);

    data.set(STORAGE_KEYS.COLLECTION, '{not json');
    expect(persistCollection({})).toBe('recovered');
    expect(collectionRecoveryNote()).toMatch(/^Unreadable collection and stats data was kept aside in this browser\./);
    expect(collectionRecoveryNote()).toContain(STATS_REBUILT_NOTE);
    expect(kept().later).toEqual([{ raw: '{not json', player: PLAYER }]);
  });

  it('reads as before for collection data alone', () => {
    data.set(STORAGE_KEYS.COLLECTION, '{not json');
    persistCollection({});
    expect(collectionRecoveryNote()).toBe(COLLECTION_RECOVERY_NOTES.stored);
  });

  it('keeps the same bytes apart when one is a collection and the other stats', () => {
    data.set(STORAGE_KEYS.COLLECTION, 'garbage');
    persistCollection({});
    data.set(STORAGE_KEYS.STATS, 'garbage');
    loadStats({});
    expect(kept()).toEqual({ raw: 'garbage', player: PLAYER, later: [{ raw: 'garbage', player: PLAYER, key: STORAGE_KEYS.STATS }] });
  });
});

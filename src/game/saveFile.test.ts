import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { ALL_CARDS } from '../data/cards';
import type { CollectionItem } from '../types';
import { CURRENT_DATA_VERSION, hydrateCollection, runMigrations } from '../utils/migrations';
import { importSaveFile } from './saveFile';
import { exportPlayer, importPlayer, peekNonce } from './player';

const player = (secretKey = 'aa'.repeat(32), nextNonce = 7) => JSON.stringify({ secretKey, name: 'Combo Miner', nextNonce, createdAt: 1 });
const fixture = () => ({
  version: 2, exportedAt: '2026-10-14T00:00:00.000Z', dataVersion: CURRENT_DATA_VERSION,
  player: player(),
  collection: JSON.stringify({ [ALL_CARDS[0].key]: { card: ALL_CARDS[0], normalCount: 1, holoCount: 0 } }),
  stats: JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackCards: [] }),
  achievements: '{}', hallOfFame: '{}', settings: '{"particlesEnabled":true,"musicVolume":0.5,"effectsVolume":1}',
  history: JSON.stringify([{ s: ALL_CARDS[0].setId, v: 1, n: 0, k: 'abc', c: ALL_CARDS[0].id, h: 'No Match', x: 10, t: 1 }]),
});

const store = new Map<string, string>();
const write = vi.fn((key: string, value: string) => { store.set(key, value); });

beforeEach(() => {
  store.clear();
  write.mockClear();
  vi.stubGlobal('localStorage', {
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: write,
    removeItem: (key: string) => { store.delete(key); },
  });
  store.set('brainrot-player-v1', player('bb'.repeat(32), 12));
  store.set(STORAGE_KEYS.COLLECTION, '{}');
  store.set(STORAGE_KEYS.STATS, '{"packsOpened":12,"holoCards":{}}');
  store.set(STORAGE_KEYS.SETTINGS, '{"particlesEnabled":false}');
});
afterEach(() => vi.unstubAllGlobals());

const expectRejectedWithoutWrites = (raw: string) => {
  const before = new Map(store);
  expect(importSaveFile(raw)).not.toBeNull();
  expect(write).not.toHaveBeenCalled();
  expect(store).toEqual(before);
};

describe('Settings backup preflight', () => {
  it.each(['{', 'null', '[]', '"save"'])('rejects malformed/top-level JSON %s without writes', expectRejectedWithoutWrites);

  it.each([
    ['future file version', { version: 3 }],
    ['string file version', { version: '2' }],
    ['missing timestamp', { exportedAt: undefined }],
    ['invalid timestamp', { exportedAt: 'yesterday' }],
    ['future data version', { dataVersion: CURRENT_DATA_VERSION + 1 }],
    ['fractional data version', { dataVersion: 1.5 }],
    ['string data version', { dataVersion: '1' }],
    ['zero data version', { dataVersion: 0 }],
    ['null data version', { dataVersion: null }],
    ['invalid private key', { player: player('bad') }],
    ['negative counter', { player: player('aa'.repeat(32), -1) }],
    ['fractional counter', { player: player('aa'.repeat(32), 0.5) }],
    ['unsafe counter', { player: player('aa'.repeat(32), Number.MAX_SAFE_INTEGER + 1) }],
    ['non-string name', { player: JSON.stringify({ secretKey: 'aa'.repeat(32), name: 1, nextNonce: 0, createdAt: 1 }) }],
    ['missing creation date', { player: JSON.stringify({ secretKey: 'aa'.repeat(32), name: 'A', nextNonce: 0 }) }],
    ['player JSON array', { player: '[]' }],
    ['non-string encoded player', { player: {} }],
    ['malformed field JSON', { settings: '{' }],
    ['non-string encoded field', { stats: {} }],
    ['collection array', { collection: '[]' }],
    ['null collection item', { collection: '{"x":null}' }],
    ['unknown historical card without set ID', { collection: JSON.stringify({ x: { card: { id: 'nonexistent', name: 'Old Card', image: '/old.webp', rarity: 'COMMON' }, normalCount: 1 } }) }],
    ['unresolvable partial card', { collection: '{"x":{"card":{"id":"nonexistent"}}}' }],
    ['prototype finish name', { collection: JSON.stringify({ x: { card: { ...ALL_CARDS[0], finish: '__proto__' } } }) }],
    ['collection missing card', { collection: '{"x":{"normalCount":1}}' }],
    ['negative collection count', { collection: JSON.stringify({ x: { card: ALL_CARDS[0], normalCount: -1 } }) }],
    ['invalid rarity', { collection: JSON.stringify({ x: { card: { ...ALL_CARDS[0], rarity: 'UNKNOWN' } } }) }],
    ['invalid finish count', { collection: JSON.stringify({ x: { card: ALL_CARDS[0], finishes: { GOLD: '2' } } }) }],
    ['achievements array', { achievements: '[]' }],
    ['invalid achievement timestamp', { achievements: '{"a":{"unlockedAt":"now"}}' }],
    ['invalid achievement cards', { achievements: '{"a":{"unlockedAt":1,"pack":[null]}}' }],
    ['stats null JSON', { stats: 'null' }],
    ['negative pack count', { stats: '{"packsOpened":-1}' }],
    ['invalid holo map', { stats: '{"holoCards":[]}' }],
    ['invalid best cards', { stats: '{"highestPackCards":[null]}' }],
    ['history object', { history: '{}' }],
    ['invalid history entry', { history: '[null]' }],
    ['invalid history cache', { history: '[{"s":"genesis","v":1,"n":0,"k":"a","c":[],"h":"No Match","x":1,"t":1}]' }],
    ['pull log object', { pulls: '{}' }],
    ['invalid pull log reference', { pulls: '[{"setId":"genesis","nonce":-1}]' }],
    ['settings array', { settings: '[]' }],
    ['invalid settings flag', { settings: '{"particlesEnabled":"yes"}' }],
    ['invalid volume', { settings: '{"musicVolume":2}' }],
    ['Hall of Fame array', { hallOfFame: '[]' }],
    ['invalid Hall of Fame date', { hallOfFame: '{"first4OfAKind":{"achieved":true,"date":"now"}}' }],
  ])('rejects %s before writing any field or backup', (_name, change) => {
    expectRejectedWithoutWrites(JSON.stringify({ ...fixture(), ...change }));
  });

  it('imports a current real-card fixture and preserves the previous save as a backup', () => {
    const save = fixture();
    expect(importSaveFile(JSON.stringify(save))).toBeNull();
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(save.collection);
    expect(store.get(STORAGE_KEYS.HISTORY)).toBe(save.history);
    expect(JSON.parse(exportPlayer())).toEqual(JSON.parse(save.player));
    expect(store.get('brainrot-data-version')).toBe(String(CURRENT_DATA_VERSION));
    const backup = JSON.parse(store.get('brainrot-before-import-v1')!);
    expect(backup['brainrot-player-v1']).toBe(player('bb'.repeat(32), 12));
    expect(backup[STORAGE_KEYS.STATS]).toBe('{"packsOpened":12,"holoCards":{}}');
  });

  it('accepts populated current best pulls, modifier counts, achievement refs and the legacy pull log', () => {
    const base = ALL_CARDS[0];
    const card = { ...base, isHolo: true, finish: 'GOLD', misprint: true, uniqueId: 0.25, isRevealed: false };
    const ref = { setId: base.setId, setVersion: 1, nonce: 0, publicKeyHex: 'cc'.repeat(32) };
    const save = {
      ...fixture(),
      collection: JSON.stringify({ [base.key]: { card: base, normalCount: 0, holoCount: 0, finishes: { GOLD: 1 }, misprints: 1, modifierPoints: 100 } }),
      stats: JSON.stringify({ packsOpened: 1, holoCards: { [base.key]: true }, highestPackCards: [card], highestPackRef: ref, highestPackFlexValue: 100 }),
      achievements: JSON.stringify({ a: { unlockedAt: 1, pack: [card], ref }, old: 1 }),
      hallOfFame: JSON.stringify({ first4OfAKind: { achieved: true, date: 1, cardId: base.id }, firstFullHouse: { achieved: true, date: 2, cards: { [base.id]: 3 } } }),
      pulls: JSON.stringify([{ ...ref, score: 100, hand: 'No Match', openedAt: 1 }]),
    };
    expect(importSaveFile(JSON.stringify(save))).toBeNull();
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(save.collection);
    expect(store.get(STORAGE_KEYS.ACHIEVEMENTS)).toBe(save.achievements);
    expect(store.get(STORAGE_KEYS.PULLS)).toBe(save.pulls);
  });

  it('retains complete unknown historical cards through import and subsequent hydration', () => {
    const card = { id: 'nonexistent', key: 'archived/nonexistent', setId: 'archived', name: 'Old Card', image: '/old.webp', rarity: 'COMMON' };
    const collection = { [card.key]: { card, normalCount: 1, holoCount: 0 } };
    expect(importSaveFile(JSON.stringify({ ...fixture(), collection: JSON.stringify(collection) }))).toBeNull();
    const hydrated = hydrateCollection(JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!) as Record<string, CollectionItem>);
    expect(hydrated).toEqual(collection);
  });

  it('accepts pre-identity v1 exports and lets existing migrations upgrade legacy card IDs', () => {
    const card = ALL_CARDS.find((c) => c.key === 'genesis/amogus')!;
    const legacyId = 'image2';
    expect(importSaveFile(JSON.stringify({
      version: 1, exportedAt: '2025-01-01T00:00:00Z',
      collection: JSON.stringify({ [legacyId]: { card: { id: legacyId }, count: 2 } }),
      stats: '{"packsOpened":2,"holoCards":{}}', settings: '{"soundEnabled":false}',
      achievements: '{"first_pack":1}',
    }))).toBeNull();
    expect(store.get('brainrot-data-version')).toBe('1');
    expect(store.get('brainrot-player-v1')).toBe(player('bb'.repeat(32), 12));
    runMigrations();
    const hydrated = hydrateCollection(JSON.parse(store.get(STORAGE_KEYS.COLLECTION)!) as Record<string, CollectionItem>);
    expect(hydrated[card.key].card.id).toBe(card.id);
    expect(hydrated[card.key].normalCount).toBe(2);
  });

  it('preserves omitted/null fields rather than clearing them', () => {
    expect(importSaveFile(JSON.stringify({ version: 2, exportedAt: '2026-01-01', collection: null, stats: null, player: null }))).toBeNull();
    expect(store.get(STORAGE_KEYS.STATS)).toBe('{"packsOpened":12,"holoCards":{}}');
    expect(store.get(STORAGE_KEYS.SETTINGS)).toBe('{"particlesEnabled":false}');
    expect(store.get('brainrot-player-v1')).toBe(player('bb'.repeat(32), 12));
  });

  it('accepts empty optional stats maps and preserves harmless own __proto__ JSON data', () => {
    const save = { ...fixture(), stats: '{}', achievements: '{"__proto__":1}' };
    expect(importSaveFile(JSON.stringify(save))).toBeNull();
    expect(store.get(STORAGE_KEYS.STATS)).toBe('{}');
    const achievements = JSON.parse(store.get(STORAGE_KEYS.ACHIEVEMENTS)!);
    expect(Object.prototype.hasOwnProperty.call(achievements, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(achievements)).toBe(Object.prototype);
  });

  it('keeps the newer counter when importing an older save with the same key', () => {
    expect(importSaveFile(JSON.stringify({ ...fixture(), player: player('bb'.repeat(32), 3) }))).toBeNull();
    expect(peekNonce()).toBe(12);
  });

  it('reports a denied write instead of reporting successful import', () => {
    write.mockImplementationOnce(() => { throw new Error('storage denied'); });
    // No current progress, so the first attempted write is an imported field rather than a backup.
    store.clear();
    expect(importSaveFile(JSON.stringify(fixture()))).not.toBeNull();
    expect(store.size).toBe(0);
  });
});

describe('direct identity import uses the same preflight', () => {
  it.each([player('bad'), player('aa'.repeat(32), -1), 'null', '[]'])('rejects %s without changing storage', (raw) => {
    const before = new Map(store);
    expect(importPlayer(raw)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(store).toEqual(before);
  });
});

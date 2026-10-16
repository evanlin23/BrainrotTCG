import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { ALL_CARDS } from '../data/cards';
import type { CollectionItem } from '../types';
import { CURRENT_DATA_VERSION, hydrateCollection, runMigrations } from '../utils/migrations';
import { exportSaveFile, importSaveFile } from './saveFile';
import { readSettings } from '../utils/settings';
import { exportPlayer, importPlayer, peekNonce, SAVE_STAMP_KEY } from './player';
import { recordPack } from './history';
import type { OpenedPack } from './pulls';

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

describe('Save & restore backup preflight', () => {
  it.each(['{', 'null', '[]', '"save"'])('rejects malformed/top-level JSON %s without writes', expectRejectedWithoutWrites);

  it('points an unreadable file back to where saves are exported', () => {
    expect(importSaveFile('{')).toBe("Couldn't read or store that file. Is it a save exported from Save & restore?");
  });

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
    ['invalid recovery envelope', { collectionRecovery: '{"raw":null,"player":null}' }],
    ['missing recovery identity snapshot', { collectionRecovery: '{"raw":"opaque"}' }],
    ['non-list later recovery payloads', { collectionRecovery: '{"raw":"opaque","player":null,"later":{}}' }],
    ['invalid later recovery payload', { collectionRecovery: '{"raw":"opaque","player":null,"later":[{"raw":1,"player":null}]}' }],
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
    // recordPack refuses these too, so importing one would block every later pack write.
    ['history set version 0', { history: '[{"s":"genesis","v":0,"n":0,"k":"a","h":"No Match","x":1,"t":1}]' }],
    ['history without a set id', { history: '[{"s":"","v":1,"n":0,"k":"a","h":"No Match","x":1,"t":1}]' }],
    // No build stores these.
    ['negative history score', { history: '[{"s":"genesis","v":1,"n":0,"k":"a","h":"No Match","x":-1,"t":1}]' }],
    ['negative history opening time', { history: '[{"s":"genesis","v":1,"n":0,"k":"a","h":"No Match","x":1,"t":-1}]' }],
    ['pull log object', { pulls: '{}' }],
    ['invalid pull log reference', { pulls: '[{"setId":"genesis","nonce":-1}]' }],
    // migratePullLog can't carry these over either.
    ['pull log set version 0', { pulls: '[{"setId":"genesis","setVersion":0,"nonce":0,"score":1,"hand":"No Match","openedAt":1}]' }],
    ['pull log without a set id', { pulls: '[{"setId":"","setVersion":1,"nonce":0,"score":1,"hand":"No Match","openedAt":1}]' }],
    ['pull log without a hand', { pulls: '[{"setId":"genesis","setVersion":1,"nonce":0,"score":1,"openedAt":1}]' }],
    ['negative pull log score', { pulls: '[{"setId":"genesis","setVersion":1,"nonce":0,"score":-1,"hand":"No Match","openedAt":1}]' }],
    ['settings array', { settings: '[]' }],
    ['invalid settings flag', { settings: '{"particlesEnabled":"yes"}' }],
    ['non-numeric volume', { settings: '{"musicVolume":"loud"}' }],
    ['non-finite volume', { settings: '{"effectsVolume":1e999}' }],
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

  it('keeps recording packs after importing a valid history', () => {
    expect(importSaveFile(JSON.stringify(fixture()))).toBeNull();
    const next = { setId: ALL_CARDS[0].setId, setVersion: 1, nonce: 1, publicKeyHex: 'abc', openedAt: 2,
      cards: [{ id: ALL_CARDS[0].id, isHolo: false }], score: { hand: { name: 'No Match' }, score: 5 } } as unknown as OpenedPack;
    expect(recordPack(next)).toBe(true);
    expect(JSON.parse(store.get(STORAGE_KEYS.HISTORY)!)).toHaveLength(2);
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

  it('accepts out-of-range volumes that readSettings clamps', () => {
    const settings = '{"musicVolume":1.5,"effectsVolume":-0.25}';
    expect(importSaveFile(JSON.stringify({ ...fixture(), settings }))).toBeNull();
    expect(store.get(STORAGE_KEYS.SETTINGS)).toBe(settings);
    expect(readSettings(JSON.parse(store.get(STORAGE_KEYS.SETTINGS)!))).toMatchObject({ musicVolume: 1, effectsVolume: 0 });
  });

  it("moves the previous player's omitted data and recovery archive to the backup when the save brings another player", () => {
    const archive = JSON.stringify({ raw: '{damaged', player: store.get('brainrot-player-v1') });
    store.set(STORAGE_KEYS.COLLECTION_RECOVERY, archive);
    store.set(STORAGE_KEYS.PULLS, '[]');
    store.set(STORAGE_KEYS.HALL_OF_FAME, '{}');
    const before = new Map(store);
    const save = { ...fixture(), stats: null, hallOfFame: undefined, settings: null };
    expect(importSaveFile(JSON.stringify(save))).toBeNull();
    expect(exportPlayer()).toBe(save.player);
    for (const key of [STORAGE_KEYS.STATS, STORAGE_KEYS.COLLECTION_RECOVERY, STORAGE_KEYS.PULLS, STORAGE_KEYS.HALL_OF_FAME]) {
      expect(store.has(key)).toBe(false);
    }
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(save.collection);
    expect(store.get(STORAGE_KEYS.SETTINGS)).toBe(before.get(STORAGE_KEYS.SETTINGS)); // a device preference
    const backup = JSON.parse(store.get('brainrot-before-import-v1')!);
    expect(backup).toEqual(Object.fromEntries(before));
  });

  it("keeps omitted data when the save is this browser's own player", () => {
    store.set(STORAGE_KEYS.PULLS, '[]');
    expect(importSaveFile(JSON.stringify({ ...fixture(), player: player('bb'.repeat(32), 12), stats: null }))).toBeNull();
    expect(store.get(STORAGE_KEYS.STATS)).toBe('{"packsOpened":12,"holoCards":{}}');
    expect(store.get(STORAGE_KEYS.PULLS)).toBe('[]');
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
    // No current progress, so the first attempted write is the import's own (its stamp) rather than a backup.
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


describe('private collection recovery archive portability', () => {
  it('imports the exact damaged bytes and original identity separately from the active collection', () => {
    const damaged = '{ damaged raw bytes (not valid JSON)';
    const originalPlayer = player('cc'.repeat(32), 91);
    const archive = JSON.stringify({ raw: damaged, player: originalPlayer });
    const incoming = { ...fixture(), collectionRecovery: archive };
    expect(importSaveFile(JSON.stringify(incoming))).toBeNull();
    expect(store.get(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(archive);
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(incoming.collection);
    expect(exportPlayer()).toBe(incoming.player);
    expect(JSON.parse(archive).player).not.toBe(incoming.player);
  });

  it('imports an archive that holds later damaged payloads', () => {
    const archive = JSON.stringify({ raw: '{"first":null}', player: null, later: [{ raw: '{broken', player: player('cc'.repeat(32), 3) }] });
    expect(importSaveFile(JSON.stringify({ ...fixture(), collectionRecovery: archive }))).toBeNull();
    expect(store.get(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(archive);
  });

  it('backs up an existing archive before importing a different one', () => {
    const previous = JSON.stringify({ raw: '{old}', player: player('bb'.repeat(32), 12) });
    store.set(STORAGE_KEYS.COLLECTION_RECOVERY, previous);
    const incoming = JSON.stringify({ raw: '{new}', player: null });
    expect(importSaveFile(JSON.stringify({ ...fixture(), collectionRecovery: incoming }))).toBeNull();
    expect(JSON.parse(store.get('brainrot-before-import-v1')!)[STORAGE_KEYS.COLLECTION_RECOVERY]).toBe(previous);
    expect(store.get(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(incoming);
  });
});


it('round-trips an opaque recovery archive through the serializer Save & restore actually downloads', () => {
  const raw = '{ definitely not collection JSON\n';
  const archive = JSON.stringify({ raw, player: player('cc'.repeat(32), 91) });
  store.set(STORAGE_KEYS.COLLECTION_RECOVERY, archive);
  const exported = exportSaveFile();
  expect(JSON.parse(exported).collectionRecovery).toBe(archive);
  const originalPlayer = JSON.parse(exported).player;
  store.clear();
  expect(importSaveFile(exported)).toBeNull();
  expect(store.get(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(archive);
  expect(JSON.parse(store.get(STORAGE_KEYS.COLLECTION_RECOVERY)!).raw).toBe(raw);
  expect(exportPlayer()).toBe(originalPlayer);
});


it('restores the exact previous recovery archive if a later imported field fails', () => {
  const previous = JSON.stringify({ raw: '{old raw bytes}', player: player('bb'.repeat(32), 12) });
  store.set(STORAGE_KEYS.COLLECTION_RECOVERY, previous);
  const incoming = JSON.stringify({ raw: '{new raw bytes}', player: null });
  let failed = false;
  write.mockImplementation((key, value) => {
    if (key === STORAGE_KEYS.STATS && !failed) { failed = true; throw new Error('quota'); }
    store.set(key, value);
  });
  expect(importSaveFile(JSON.stringify({ ...fixture(), collectionRecovery: incoming })))
    .toBe('Import failed. Your previous save data was restored.');
  expect(store.get(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(previous);
  expect(JSON.parse(store.get('brainrot-before-import-v1')!)[STORAGE_KEYS.COLLECTION_RECOVERY]).toBe(previous);
});

it('stamps the save before writing any imported field, even for the same player', () => {
  store.set(SAVE_STAMP_KEY, 'earlier');
  expect(importSaveFile(JSON.stringify({ ...fixture(), player: player('bb'.repeat(32), 12) }))).toBeNull();
  expect(write.mock.calls.slice(0, 2).map(([key]) => key)).toEqual(['brainrot-before-import-v1', SAVE_STAMP_KEY]);
  expect(store.get(SAVE_STAMP_KEY)).toMatch(/\S/);
  expect(store.get(SAVE_STAMP_KEY)).not.toBe('earlier');
});

it.each([['an earlier stamp', 'earlier'], ['no stamp', undefined]])('puts back %s when the import fails', (_name, earlier) => {
  if (earlier) store.set(SAVE_STAMP_KEY, earlier);
  write.mockImplementation((key, value) => {
    if (key === STORAGE_KEYS.STATS) throw new Error('quota');
    store.set(key, value);
  });
  expect(importSaveFile(JSON.stringify(fixture()))).toBe('Import failed. Your previous save data was restored.');
  expect(store.get(SAVE_STAMP_KEY)).toBe(earlier);
});

it("clears a different player's fields before the stamp, so an import that only fits after the clears succeeds", () => {
  store.set(STORAGE_KEYS.PULLS, JSON.stringify(Array.from({ length: 2_000 }, () => 'old')));
  const bytes = () => [...store].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  let limit = Infinity;
  write.mockImplementation((key, value) => {
    const before = store.get(key);
    store.set(key, value);
    if (bytes() > limit) {
      if (before === undefined) store.delete(key);
      else store.set(key, before);
      throw new DOMException('full', 'QuotaExceededError');
    }
    if (key === 'brainrot-before-import-v1') limit = bytes(); // full once the backup is in
  });
  const save = fixture(); // another player, without the pulls this browser holds
  expect(importSaveFile(JSON.stringify(save))).toBeNull();
  expect(exportPlayer()).toBe(save.player);
  expect(store.has(STORAGE_KEYS.PULLS)).toBe(false);
  expect(store.get(SAVE_STAMP_KEY)).toMatch(/\S/);
});

it('clears again a field that a tab still on the old save wrote back before the stamp', () => {
  store.set(STORAGE_KEYS.PULLS, '[]');
  write.mockImplementation((key, value) => {
    if (key === SAVE_STAMP_KEY) store.set(STORAGE_KEYS.PULLS, '["old tab"]');
    store.set(key, value);
  });
  expect(importSaveFile(JSON.stringify(fixture()))).toBeNull();
  expect(write.mock.calls.slice(0, 2).map(([key]) => key)).toEqual(['brainrot-before-import-v1', SAVE_STAMP_KEY]);
  expect(store.has(STORAGE_KEYS.PULLS)).toBe(false);
});

it.each([
  ['succeeds', null, undefined],
  ['fails', 'Import failed. Your previous save data was restored.', STORAGE_KEYS.STATS],
])('clears again a field that was absent until a tab still on the old save wrote it mid-import, when the import %s', (_name, result, failing) => {
  store.set(SAVE_STAMP_KEY, 'earlier');
  let oldTab = true;
  write.mockImplementation((key, value) => {
    if (key === SAVE_STAMP_KEY && oldTab) { oldTab = false; store.set(STORAGE_KEYS.PULLS, '["old tab"]'); }
    if (key === failing) throw new Error('quota');
    store.set(key, value);
  });
  expect(store.has(STORAGE_KEYS.PULLS)).toBe(false);
  expect(importSaveFile(JSON.stringify(fixture()))).toBe(result);
  expect(store.has(STORAGE_KEYS.PULLS)).toBe(false);
  if (failing) expect(store.get(SAVE_STAMP_KEY)).toBe('earlier');
  else expect(exportPlayer()).toBe(fixture().player);
});

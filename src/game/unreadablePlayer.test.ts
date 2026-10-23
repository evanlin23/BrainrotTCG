import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { fromHex, publicKeyFromSecret, toHex } from '../engine';
import { getSet } from '../content/sets';
import { ALL_CARDS } from '../data/cards';

// #1052: a stored player record that can't be read as is. A readable key is kept and only the broken
// fields are repaired; with no key that can be read, packs stay sealed and no key is written over it
// until the player restores a backup or starts a new player.
const PLAYER_KEY = 'brainrot-player-v1';
const NEW_PLAYER_BACKUP_KEY = 'brainrot-before-new-player-v1';
const SECRET = 'cc'.repeat(32);
const PUBLIC = toHex(publicKeyFromSecret(fromHex(SECRET)));
const DAMAGED = '{"secretKey":"not a key","name":"Old Player","nextNonce":4';
const COLLECTION = JSON.stringify({ [ALL_CARDS[0].key]: { card: ALL_CARDS[0], normalCount: 3, holoCount: 0 } });

const store = new Map<string, string>();
const setItem = vi.fn((key: string, value: string) => { store.set(key, value); });
const removeItem = vi.fn((key: string) => { store.delete(key); });
let player: typeof import('./player');
let saveFile: typeof import('./saveFile');
let recovery: typeof import('./collectionRecovery');

beforeEach(async () => {
  vi.resetModules();
  store.clear();
  setItem.mockReset().mockImplementation((key: string, value: string) => { store.set(key, value); });
  removeItem.mockReset().mockImplementation((key: string) => { store.delete(key); });
  vi.stubGlobal('localStorage', {
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem, removeItem,
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  player = await import('./player');
  saveFile = await import('./saveFile');
  recovery = await import('./collectionRecovery');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const archived = (): { raw: string; key?: string }[] => {
  const archive = JSON.parse(store.get(STORAGE_KEYS.COLLECTION_RECOVERY) ?? 'null') as { raw: string; key?: string; later?: { raw: string; key?: string }[] } | null;
  return archive ? [archive, ...(archive.later ?? [])] : [];
};

describe('a damaged record whose key can be read', () => {
  it('keeps the key and repairs the ticket count past every pack stored or owed under it', () => {
    const raw = JSON.stringify({ secretKey: SECRET, name: 'Kept Name', nextNonce: 1.5, createdAt: 5 });
    store.set(PLAYER_KEY, raw);
    store.set(STORAGE_KEYS.STORED_PACKS, JSON.stringify({ k: PUBLIC, n: [[0, 20]] }));
    store.set(`${STORAGE_KEYS.PENDING_PACK_PREFIX}${PUBLIC}:30`, '{}');
    // Another key's owed pack doesn't count.
    store.set(`${STORAGE_KEYS.PENDING_PACK_PREFIX}${'ab'.repeat(32)}:90`, '{}');

    expect(player.getPlayer().publicKeyHex).toBe(PUBLIC);
    expect(JSON.parse(store.get(PLAYER_KEY)!)).toEqual({ secretKey: SECRET, name: 'Kept Name', nextNonce: 31, createdAt: 5 });
    expect(player.playerUnreadable()).toBe(false);
    expect(player.allocateNonce().nonce).toBe(31);
    // The original bytes are kept aside, and the note says the key was kept.
    expect(archived()).toEqual([expect.objectContaining({ raw, key: PLAYER_KEY })]);
    expect(recovery.collectionRecoveryNote()).toContain(recovery.PLAYER_REPAIRED_NOTE);
  });
});

describe('a record with no key that can be read', () => {
  beforeEach(() => {
    store.set(PLAYER_KEY, DAMAGED);
    store.set(STORAGE_KEYS.COLLECTION, COLLECTION);
  });

  it('refuses tickets and packs, writes no key over it, and keeps its bytes for Download', async () => {
    const standIn = player.getPlayer().publicKeyHex;
    expect(player.playerUnreadable()).toBe(true);
    expect(() => player.allocateNonce()).toThrow(player.PlayerUnreadableError);
    await expect(player.claimNonce()).rejects.toBeInstanceOf(player.PlayerUnreadableError);
    const { openPack } = await import('./pulls');
    await expect(openPack(getSet('right-now', 2)!)).rejects.toBeInstanceOf(player.PlayerUnreadableError);
    expect(player.renamePlayer('New Name', standIn).status).toBe('failed');

    expect(store.get(PLAYER_KEY)).toBe(DAMAGED);
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(COLLECTION);
    expect(archived()).toEqual([expect.objectContaining({ raw: DAMAGED, key: PLAYER_KEY })]);
    expect(recovery.collectionRecoveryNote()).toContain(recovery.PLAYER_PAUSED_NOTE);
    // A backup holds the damaged bytes as they are, never the stand-in key, so importing it is refused.
    const file = saveFile.exportSaveFile();
    expect(JSON.parse(file).player).toBe(DAMAGED);
    // Import says what such a file is, and nothing changes.
    expect(saveFile.importSaveFile(file)).toBe(saveFile.DAMAGED_IMPORT_NOTE);
    expect(store.get(PLAYER_KEY)).toBe(DAMAGED);
  });

  it('keeps unreadable stats aside beside it while storage is full, and backs both up with the damaged bytes (#1053)', async () => {
    store.set(STORAGE_KEYS.STATS, 'garbage');
    setItem.mockImplementation((key: string, value: string) => {
      if (key === STORAGE_KEYS.COLLECTION_RECOVERY) throw new DOMException('full', 'QuotaExceededError');
      store.set(key, value);
    });
    const { loadStats } = await import('./statsRecovery');
    const loaded = loadStats({});
    expect(loaded.rebuilt).toBe(true);
    // Rebuilt from the stand-in key's empty history: no pack of it is credited as the best.
    expect(loaded.stats.packsOpened).toBe(0);
    expect(loaded.stats.highestPackRef).toBeUndefined();
    expect(recovery.collectionRecoveryNote()).toBe('Unreadable player and stats data was kept aside, but this browser had no room to store it, so it lasts only until this tab closes or reloads. Download it now to keep it. '
      + `${recovery.PLAYER_PAUSED_NOTE} ${recovery.STATS_REBUILT_NOTE} It may include your secret player key. Keep the file private and never attach it to a public bug report.`);
    // With no key, the export matches kept entries by the record's exact bytes.
    const file = JSON.parse(saveFile.exportSaveFile()) as { player: string; collectionRecovery: string };
    expect(file.player).toBe(DAMAGED);
    const archive = JSON.parse(file.collectionRecovery) as { raw: string; player: string | null; key?: string; later?: { raw: string; player: string | null; key?: string }[] };
    expect([archive, ...(archive.later ?? [])].map(({ raw, player: of, key }) => ({ raw, player: of, key }))).toEqual([
      { raw: 'garbage', player: DAMAGED, key: STORAGE_KEYS.STATS },
      { raw: DAMAGED, player: DAMAGED, key: PLAYER_KEY },
    ]);
    expect(store.get(STORAGE_KEYS.STATS)).toBe('garbage');
  });

  it('downloads the damaged bytes under a file name and note of their own, promising no key', () => {
    const click = vi.fn();
    const anchor = { href: '', download: '', click };
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: () => undefined, removeChild: () => undefined } });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    expect(saveFile.downloadSaveFile()).toBe(saveFile.DAMAGED_EXPORT_DONE_NOTE);
    expect(anchor.download).toMatch(/^brainrot-tcg-damaged-player-.*\.txt$/);
    expect(saveFile.DAMAGED_EXPORT_DONE_NOTE).not.toContain(saveFile.EXPORT_DONE_NOTE);
    expect(saveFile.DAMAGED_EXPORT_DONE_NOTE).toContain('no player key that works');
    expect(click).toHaveBeenCalledOnce();

    // A readable save keeps the backup name and note.
    store.set(PLAYER_KEY, JSON.stringify({ secretKey: SECRET, name: 'Fine', nextNonce: 0, createdAt: 1 }));
    expect(saveFile.downloadSaveFile()).toBe(saveFile.EXPORT_DONE_NOTE);
    expect(anchor.download).toMatch(/^brainrot-tcg-save-.*\.txt$/);
  });

  it('starts a new player who never inherits the old progress, keeping the damaged bytes', () => {
    const mark = player.saveMark();
    // Every key the old player's packs made, each with a value of its own.
    const moved = {
      [STORAGE_KEYS.STATS]: '{"packsOpened":3,"holoCards":{}}',
      [STORAGE_KEYS.HISTORY]: '[{"n":1}]',
      [STORAGE_KEYS.BEST_CARDS]: '[{"key":"best"}]',
      [STORAGE_KEYS.ACHIEVEMENTS]: '{"first":1}',
      [STORAGE_KEYS.HALL_OF_FAME]: '[{"proof":"hof"}]',
      [STORAGE_KEYS.PULLS]: '[{"proof":"pull"}]',
      [STORAGE_KEYS.STORED_PACKS]: '{"n":[[0,3]]}',
    };
    for (const [key, value] of Object.entries(moved)) store.set(key, value);
    store.set(STORAGE_KEYS.SETTINGS, '{"particlesEnabled":false}');

    expect(saveFile.startNewPlayer({ expectedSave: mark })).toBeNull();

    const fresh = JSON.parse(store.get(PLAYER_KEY)!) as { secretKey: string; nextNonce: number };
    expect(fresh.secretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.nextNonce).toBe(0);
    // The old progress went to a copy, the damaged bytes with it, and they stay kept aside for Download.
    const copy = JSON.parse(store.get(NEW_PLAYER_BACKUP_KEY)!) as Record<string, string>;
    for (const [key, value] of Object.entries({ ...moved, [STORAGE_KEYS.COLLECTION]: COLLECTION, [PLAYER_KEY]: DAMAGED })) {
      expect(copy[key], key).toBe(value);
      if (key !== PLAYER_KEY) expect(store.has(key), key).toBe(false);
    }
    expect(store.get(STORAGE_KEYS.SETTINGS)).toBe('{"particlesEnabled":false}');
    expect(archived()).toEqual([expect.objectContaining({ raw: DAMAGED, key: PLAYER_KEY })]);

    // The next visit reads the new key, with an empty collection under it.
    vi.resetModules();
    return import('./player').then((next) => {
      expect(next.playerUnreadable()).toBe(false);
      expect(next.getPlayer().publicKeyHex).toBe(toHex(publicKeyFromSecret(fromHex(fresh.secretKey))));
      expect(store.has(STORAGE_KEYS.COLLECTION)).toBe(false);
    });
  });

  it('moves owed packs that name no key aside, so the new player never takes them as its own', async () => {
    const other = 'ab'.repeat(32);
    const pack = (n: number, k?: string) => ({ s: 'right-now', v: 2, n, ...(k ? { k } : {}), c: 'x', t: 1 });
    const shelf = JSON.stringify([pack(2), pack(3, other)]);
    const legacy = JSON.stringify(pack(4));
    store.set(STORAGE_KEYS.PENDING_PACKS, shelf);
    store.set(STORAGE_KEYS.PENDING_PACK, legacy);

    expect(saveFile.startNewPlayer({ expectedSave: player.saveMark() })).toBeNull();

    // Another key's pack stays for that key; the ones with no key are only in the copy.
    expect(JSON.parse(store.get(STORAGE_KEYS.PENDING_PACKS)!)).toEqual([pack(3, other)]);
    expect(store.has(STORAGE_KEYS.PENDING_PACK)).toBe(false);
    const copy = JSON.parse(store.get(NEW_PLAYER_BACKUP_KEY)!) as Record<string, string>;
    expect(copy[STORAGE_KEYS.PENDING_PACKS]).toBe(shelf);
    expect(copy[STORAGE_KEYS.PENDING_PACK]).toBe(legacy);

    vi.resetModules();
    const pulls = await import('./pulls');
    expect(pulls.onShelf(2)).toBe(false);
    expect(pulls.onShelf(3)).toBe(false);
  });

  it('keeps a copy from an earlier start as it was, in a slot of its own', () => {
    store.set(NEW_PLAYER_BACKUP_KEY, '{"earlier":"copy"}');
    store.set(`${NEW_PLAYER_BACKUP_KEY}:2`, '{"second":"copy"}');
    expect(saveFile.startNewPlayer({ expectedSave: player.saveMark() })).toBeNull();
    expect(store.get(NEW_PLAYER_BACKUP_KEY)).toBe('{"earlier":"copy"}');
    expect(store.get(`${NEW_PLAYER_BACKUP_KEY}:2`)).toBe('{"second":"copy"}');
    const copy = JSON.parse(store.get(`${NEW_PLAYER_BACKUP_KEY}:3`)!) as Record<string, string>;
    expect(copy[STORAGE_KEYS.COLLECTION]).toBe(COLLECTION);
    // The copy holds no older copies.
    expect(Object.keys(copy).some((key) => key.startsWith('brainrot-before-'))).toBe(false);
  });

  it('says an earlier copy is kept when there is no room for another', () => {
    store.set(NEW_PLAYER_BACKUP_KEY, '{"earlier":"copy"}');
    const mark = player.saveMark();
    const before = new Map(store);
    setItem.mockImplementation((key: string, value: string) => {
      if (key.startsWith(NEW_PLAYER_BACKUP_KEY)) throw new DOMException('full', 'QuotaExceededError');
      store.set(key, value);
    });
    expect(saveFile.startNewPlayer({ expectedSave: mark })).toBe(saveFile.NEW_PLAYER_NO_ROOM_NOTE + saveFile.NEW_PLAYER_EARLIER_COPY_NOTE);
    expect(store).toEqual(before);
  });

  it('names the copies of earlier saves when storage fills after this copy was written (#1052)', () => {
    store.set('brainrot-before-import-v1', '{"import":"copy"}');
    const mark = player.saveMark();
    const before = new Map(store);
    setItem.mockImplementation((key: string, value: string) => {
      if (key === PLAYER_KEY) throw new DOMException('full', 'QuotaExceededError');
      store.set(key, value);
    });
    expect(saveFile.startNewPlayer({ expectedSave: mark })).toBe(saveFile.NEW_PLAYER_NO_ROOM_NOTE + saveFile.NEW_PLAYER_EARLIER_COPY_NOTE);
    expect(store).toEqual(before);
  });

  it('names an import copy when there is no room for this copy', () => {
    store.set('brainrot-before-import-v1', '{"import":"copy"}');
    const mark = player.saveMark();
    setItem.mockImplementation((key: string, value: string) => {
      if (key.startsWith(NEW_PLAYER_BACKUP_KEY)) throw new DOMException('full', 'QuotaExceededError');
      store.set(key, value);
    });
    expect(saveFile.startNewPlayer({ expectedSave: mark })).toBe(saveFile.NEW_PLAYER_NO_ROOM_NOTE + saveFile.NEW_PLAYER_EARLIER_COPY_NOTE);
  });

  it.each([
    ['writing the new record', (key: string) => key === PLAYER_KEY, 'set'],
    ['moving the stats aside', (key: string) => key === STORAGE_KEYS.STATS, 'remove'],
  ] as const)('changes nothing when storage fills while %s', (_label, failing, op) => {
    store.set(STORAGE_KEYS.STATS, '{"packsOpened":3,"holoCards":{}}');
    store.set(STORAGE_KEYS.HISTORY, '[]');
    const mark = player.saveMark();
    const before = new Map(store);
    const full = () => { throw new DOMException('full', 'QuotaExceededError'); };
    if (op === 'set') {
      setItem.mockImplementation((key: string, value: string) => {
        if (failing(key)) full();
        store.set(key, value);
      });
    } else {
      removeItem.mockImplementation((key: string) => {
        if (failing(key)) full();
        store.delete(key);
      });
    }

    expect(saveFile.startNewPlayer({ expectedSave: mark })).toBe(saveFile.NEW_PLAYER_NO_ROOM_NOTE);
    expect(saveFile.NEW_PLAYER_NO_ROOM_NOTE).toContain('Download the save with the damaged record, or restore a backup');
    expect(store).toEqual(before);
    expect(player.playerUnreadable()).toBe(true);
  });

  it('refuses to start a new player once the save changed in another tab', () => {
    const mark = player.saveMark();
    store.set(player.SAVE_STAMP_KEY, 'other tab');
    expect(saveFile.startNewPlayer({ expectedSave: mark })).toBe(saveFile.STALE_SAVE_WARNING);
    expect(store.get(PLAYER_KEY)).toBe(DAMAGED);
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(COLLECTION);
  });
});

describe('a readable record', () => {
  it('is never replaced by starting a new player', () => {
    const raw = JSON.stringify({ secretKey: SECRET, name: 'Fine', nextNonce: 2, createdAt: 1 });
    store.set(PLAYER_KEY, raw);
    store.set(STORAGE_KEYS.COLLECTION, COLLECTION);
    expect(saveFile.startNewPlayer()).toBe(saveFile.STALE_SAVE_WARNING);
    expect(store.get(PLAYER_KEY)).toBe(raw);
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(COLLECTION);
  });
});

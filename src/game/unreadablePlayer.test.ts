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
    expect(saveFile.importSaveFile(file)).toBe('The player identity in this save is invalid. Nothing was imported.');
  });

  it('starts a new player who never inherits the old collection, keeping the damaged bytes', () => {
    const mark = player.saveMark();
    store.set(STORAGE_KEYS.STATS, '{"packsOpened":3,"holoCards":{}}');
    store.set(STORAGE_KEYS.SETTINGS, '{"particlesEnabled":false}');

    expect(saveFile.startNewPlayer({ expectedSave: mark })).toBeNull();

    const fresh = JSON.parse(store.get(PLAYER_KEY)!) as { secretKey: string; nextNonce: number };
    expect(fresh.secretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.nextNonce).toBe(0);
    expect(store.has(STORAGE_KEYS.COLLECTION)).toBe(false);
    expect(store.has(STORAGE_KEYS.STATS)).toBe(false);
    expect(store.get(STORAGE_KEYS.SETTINGS)).toBe('{"particlesEnabled":false}');
    // The old progress went to a copy, the damaged bytes with it, and they stay kept aside for Download.
    const copy = JSON.parse(store.get(NEW_PLAYER_BACKUP_KEY)!) as Record<string, string>;
    expect(Object.values(copy)).toEqual(expect.arrayContaining([COLLECTION, DAMAGED]));
    expect(archived()).toEqual([expect.objectContaining({ raw: DAMAGED, key: PLAYER_KEY })]);

    // The next visit reads the new key, with an empty collection under it.
    vi.resetModules();
    return import('./player').then((next) => {
      expect(next.playerUnreadable()).toBe(false);
      expect(next.getPlayer().publicKeyHex).toBe(toHex(publicKeyFromSecret(fromHex(fresh.secretKey))));
      expect(store.has(STORAGE_KEYS.COLLECTION)).toBe(false);
    });
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
    expect(saveFile.NEW_PLAYER_NO_ROOM_NOTE).toContain('Download the damaged record, or restore a backup');
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

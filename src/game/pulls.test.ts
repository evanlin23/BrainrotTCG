import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { encodeCard } from './cardCode';
import { getPlayer } from './player';
import { clearPendingPack, savePendingPack, takePendingPacks, type OpenedPack } from './pulls';

// A storage whose writes can be refused, as a browser that blocks storage (SecurityError) does.
const data = new Map<string, string>();
let refuseRemove = false;
let refuseShelfWrite = false;
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (refuseShelfWrite && k === STORAGE_KEYS.PENDING_PACK) throw new DOMException('Full', 'QuotaExceededError');
    data.set(k, v);
  },
  removeItem: (k: string) => {
    if (refuseRemove) throw new DOMException('Denied', 'SecurityError');
    data.delete(k);
  },
});

const SET = getSet('right-now', 2)!;
const PENDING = JSON.stringify({
  s: SET.id, v: SET.version, n: 4, c: SET.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(','), t: 1,
});

describe('pending pack when storage refuses to remove it', () => {
  beforeEach(() => {
    data.clear();
    refuseRemove = false;
  });

  it('leaves the pack for a later load instead of adding it now and again then', () => {
    data.set(STORAGE_KEYS.PENDING_PACK, PENDING);
    refuseRemove = true;
    expect(takePendingPacks()).toEqual([]);
    expect(data.get(STORAGE_KEYS.PENDING_PACK)).toBe(PENDING);

    refuseRemove = false;
    expect(takePendingPacks()).toMatchObject([{ setId: SET.id, nonce: 4, cards: expect.any(Array) }]);
    expect(data.has(STORAGE_KEYS.PENDING_PACK)).toBe(false);
  });

  it('clearing it does not throw, whether the entry is readable or not', () => {
    refuseRemove = true;
    data.set(STORAGE_KEYS.PENDING_PACK, PENDING);
    expect(() => clearPendingPack(4)).not.toThrow();
    data.set(STORAGE_KEYS.PENDING_PACK, '{not json');
    expect(() => clearPendingPack(4)).not.toThrow();
  });
});

describe('a pack put back on the shelf', () => {
  beforeEach(() => {
    data.clear();
    refuseRemove = false;
  });

  it('counts an entry saved before the flag existed, once', () => {
    data.set(STORAGE_KEYS.PENDING_PACK, PENDING);
    expect(takePendingPacks()[0].counted).toBeUndefined();
  });

  it('remembers that it has counted, and only a well-formed flag says so', () => {
    data.set(STORAGE_KEYS.PENDING_PACK, PENDING);
    const [pack] = takePendingPacks();
    savePendingPack(pack);
    expect(JSON.parse(data.get(STORAGE_KEYS.PENDING_PACK)!)).not.toHaveProperty('d');
    savePendingPack({ ...pack, counted: true });
    expect(JSON.parse(data.get(STORAGE_KEYS.PENDING_PACK)!).d).toBe(1);
    expect(takePendingPacks()).toMatchObject([{ nonce: 4, counted: true, cards: pack.cards.map(({ key }) => expect.objectContaining({ key })) }]);

    for (const d of [0, true, '1', null]) {
      data.set(STORAGE_KEYS.PENDING_PACK, JSON.stringify({ ...JSON.parse(PENDING), d }));
      expect(takePendingPacks()[0].counted).toBeUndefined();
    }
  });
});

describe('several packs owed at once', () => {
  const entry = (n: number, extra: object = {}) => ({ ...JSON.parse(PENDING), n, ...extra });
  const shelved = () => JSON.parse(data.get(STORAGE_KEYS.PENDING_PACK) ?? 'null');
  const pack = (n: number): OpenedPack => {
    data.set(STORAGE_KEYS.PENDING_PACK, JSON.stringify(entry(n)));
    return takePendingPacks()[0];
  };
  beforeEach(() => {
    data.clear();
    refuseRemove = false;
    refuseShelfWrite = false;
  });

  it('never replaces an owed pack with a new one, and adds each once', () => {
    const next = pack(5);
    // An owed pack stored the way a single pack always was.
    data.set(STORAGE_KEYS.PENDING_PACK, JSON.stringify(entry(4, { d: 1 })));
    expect(savePendingPack(next)).toBe(true);
    expect(shelved()).toEqual([entry(4, { d: 1 }), expect.objectContaining({ n: 5 })]);
    // Putting a pack back replaces its own entry.
    savePendingPack({ ...next, counted: true });
    expect(shelved()).toEqual([entry(4, { d: 1 }), expect.objectContaining({ n: 5, d: 1 })]);

    expect(takePendingPacks()).toMatchObject([{ nonce: 4, counted: true }, { nonce: 5, counted: true }]);
    expect(data.has(STORAGE_KEYS.PENDING_PACK)).toBe(false);
    expect(takePendingPacks()).toEqual([]);
  });

  it('clears only the stored packs, back to one entry as before, then none', () => {
    data.set(STORAGE_KEYS.PENDING_PACK, JSON.stringify([entry(4), entry(5), entry(6)]));
    clearPendingPack(5, 6);
    expect(shelved()).toEqual(entry(4));
    clearPendingPack(5);
    expect(shelved()).toEqual(entry(4));
    clearPendingPack(4);
    expect(data.has(STORAGE_KEYS.PENDING_PACK)).toBe(false);
  });

  it("takes every pack off rather than leave a stored one to be added again", () => {
    data.set(STORAGE_KEYS.PENDING_PACK, JSON.stringify([entry(4), entry(5), entry(6)]));
    refuseShelfWrite = true;
    clearPendingPack(5);
    expect(data.has(STORAGE_KEYS.PENDING_PACK)).toBe(false);
  });

  it('adds each nonce once, even if the shelf lists it twice', () => {
    data.set(STORAGE_KEYS.PENDING_PACK, JSON.stringify([entry(4), entry(4, { d: 1 }), 'junk', null, entry(5)]));
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([4, 5]);
  });

  it('keeps every owed pack when the shelf is full: a new one waits in the history', () => {
    const five = pack(5);
    const full = Array.from({ length: 50 }, (_, i) => entry(i + 10));
    data.set(STORAGE_KEYS.PENDING_PACK, JSON.stringify(full));
    expect(savePendingPack(five)).toBe(true);
    expect(shelved()).toEqual(full);
  });

  it("holds this player's packs only", () => {
    const me = getPlayer().publicKeyHex;
    const six = pack(6);
    data.set(STORAGE_KEYS.PENDING_PACK, JSON.stringify([entry(4, { k: 'ab'.repeat(32) }), entry(5, { k: me })]));
    savePendingPack(six);
    expect(shelved()).toEqual([entry(5, { k: me }), expect.objectContaining({ n: 6 })]);
    data.set(STORAGE_KEYS.PENDING_PACK, JSON.stringify([entry(4, { k: 'ab'.repeat(32) }), entry(5, { k: me })]));
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([5]);
  });

  it('reports a shelf it could not write', () => {
    const next = pack(5);
    refuseShelfWrite = true;
    expect(savePendingPack(next)).toBe(false);
  });
});

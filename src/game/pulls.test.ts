import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { encodeCard } from './cardCode';
import { getPlayer } from './player';
import { clearPendingPack, savePendingPack, takePendingPacks, type OpenedPack } from './pulls';

// A storage whose writes can be refused, as a browser that blocks storage (SecurityError) does.
const data = new Map<string, string>();
let refuseRemove: (key: string) => boolean = () => false;
let refuseShelfWrite = false;
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (refuseShelfWrite && k === STORAGE_KEYS.PENDING_PACKS) throw new DOMException('Full', 'QuotaExceededError');
    data.set(k, v);
  },
  removeItem: (k: string) => {
    if (refuseRemove(k)) throw new DOMException('Denied', 'SecurityError');
    data.delete(k);
  },
});

const SET = getSet('right-now', 2)!;
const PENDING = JSON.stringify({
  s: SET.id, v: SET.version, n: 4, c: SET.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(','), t: 1,
});
/** The packs this build keeps (a list), and the one-pack entry older builds keep. */
const LIST = STORAGE_KEYS.PENDING_PACKS;
const LEGACY = STORAGE_KEYS.PENDING_PACK;
const shelved = () => JSON.parse(data.get(LIST) ?? 'null');
const reset = () => {
  data.clear();
  refuseRemove = () => false;
  refuseShelfWrite = false;
};

describe('pending pack when storage refuses to remove it', () => {
  beforeEach(reset);

  it('leaves the pack for a later load instead of adding it now and again then', () => {
    data.set(LEGACY, PENDING);
    refuseRemove = () => true;
    expect(takePendingPacks()).toEqual([]);
    expect(data.get(LEGACY)).toBe(PENDING);

    refuseRemove = () => false;
    expect(takePendingPacks()).toMatchObject([{ setId: SET.id, nonce: 4, cards: expect.any(Array) }]);
    expect(data.has(LEGACY)).toBe(false);
  });

  it("leaves an older build's pack it can't take off (and a listed copy) for a later load", () => {
    const entry = (n: number) => ({ ...JSON.parse(PENDING), n });
    data.set(LEGACY, PENDING);
    data.set(LIST, JSON.stringify([entry(4), entry(5)]));
    refuseRemove = (k) => k === LEGACY;
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([5]);
    expect(data.get(LEGACY)).toBe(PENDING);
    expect(data.has(LIST)).toBe(false);
  });

  it('clearing it does not throw, whether the entry is readable or not', () => {
    refuseRemove = () => true;
    data.set(LEGACY, PENDING);
    expect(() => clearPendingPack(4)).not.toThrow();
    data.set(LEGACY, '{not json');
    expect(() => clearPendingPack(4)).not.toThrow();
    data.set(LIST, '{not json');
    expect(() => clearPendingPack(4)).not.toThrow();
  });
});

describe('a pack put back on the shelf', () => {
  beforeEach(reset);

  it('counts an entry saved before the flag existed, once', () => {
    data.set(LEGACY, PENDING);
    expect(takePendingPacks()[0].counted).toBeUndefined();
  });

  it('remembers that it has counted, and only a well-formed flag says so', () => {
    data.set(LEGACY, PENDING);
    const [pack] = takePendingPacks();
    savePendingPack(pack);
    expect(shelved()[0]).not.toHaveProperty('d');
    savePendingPack({ ...pack, counted: true });
    expect(shelved()[0].d).toBe(1);
    expect(takePendingPacks()).toMatchObject([{ nonce: 4, counted: true, cards: pack.cards.map(({ key }) => expect.objectContaining({ key })) }]);

    for (const d of [0, true, '1', null]) {
      data.set(LIST, JSON.stringify([{ ...JSON.parse(PENDING), d }]));
      expect(takePendingPacks()[0].counted).toBeUndefined();
    }
  });
});

describe('several packs owed at once', () => {
  const entry = (n: number, extra: object = {}) => ({ ...JSON.parse(PENDING), n, ...extra });
  const pack = (n: number): OpenedPack => {
    data.set(LEGACY, JSON.stringify(entry(n)));
    return takePendingPacks()[0];
  };
  beforeEach(reset);

  it("never replaces an owed pack with a new one, and adds each once, an older build's entry too", () => {
    const next = pack(5);
    // An owed pack an older build stored in its one-pack entry.
    data.set(LEGACY, JSON.stringify(entry(4, { d: 1 })));
    expect(savePendingPack(next)).toBe(true);
    expect(shelved()).toEqual([expect.objectContaining({ n: 5 })]);
    // Putting a pack back replaces its own entry.
    savePendingPack({ ...next, counted: true });
    expect(shelved()).toEqual([expect.objectContaining({ n: 5, d: 1 })]);
    expect(JSON.parse(data.get(LEGACY)!)).toEqual(entry(4, { d: 1 }));

    expect(takePendingPacks()).toMatchObject([{ nonce: 4, counted: true }, { nonce: 5, counted: true }]);
    expect(data.has(LIST)).toBe(false);
    expect(data.has(LEGACY)).toBe(false);
    expect(takePendingPacks()).toEqual([]);
  });

  it('never writes where an older build looks, so it can neither drop nor re-add a listed pack', () => {
    const [five, six] = [pack(5), pack(6)];
    savePendingPack(five, six);
    clearPendingPack(5);
    savePendingPack(five);
    expect(data.has(LEGACY)).toBe(false);
    expect(shelved()).toEqual([expect.objectContaining({ n: 6 }), expect.objectContaining({ n: 5 })]);

    // An older tab's pack: this build leaves its entry as that tab wrote it, and copies it nowhere,
    // so once that tab clears it (it reached that tab's collection) no one adds it again.
    data.set(LEGACY, PENDING);
    savePendingPack({ ...five, counted: true });
    clearPendingPack(6);
    expect(data.get(LEGACY)).toBe(PENDING);
    data.delete(LEGACY);
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([5]);
  });

  it("clears an older build's pack once the collection holds it", () => {
    data.set(LEGACY, PENDING);
    clearPendingPack(5);
    expect(data.get(LEGACY)).toBe(PENDING);
    clearPendingPack(4);
    expect(data.has(LEGACY)).toBe(false);
  });

  it('clears only the stored packs, then none, and writes nothing when none match', () => {
    const other = entry(7, { k: 'ab'.repeat(32) });
    data.set(LIST, JSON.stringify([entry(4), entry(5), entry(6), other]));
    clearPendingPack(5, 6);
    expect(shelved()).toEqual([entry(4)]);
    data.set(LIST, JSON.stringify([entry(4), other]));
    clearPendingPack();
    clearPendingPack(5);
    expect(shelved()).toEqual([entry(4), other]);
    clearPendingPack(4);
    expect(data.has(LIST)).toBe(false);
  });

  it("takes every pack off rather than leave a stored one to be added again", () => {
    data.set(LIST, JSON.stringify([entry(4), entry(5), entry(6)]));
    refuseShelfWrite = true;
    clearPendingPack(5);
    expect(data.has(LIST)).toBe(false);
  });

  it('adds each nonce once, even if the shelf lists it twice', () => {
    data.set(LIST, JSON.stringify([entry(4), entry(4, { d: 1 }), 'junk', null, entry(5)]));
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([4, 5]);
  });

  it('keeps every owed pack when the shelf is full, and reports the new one as not saved', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [five, ten] = [pack(5), pack(10)];
    const full = Array.from({ length: 50 }, (_, i) => entry(i + 10));
    data.set(LIST, JSON.stringify(full));
    expect(savePendingPack(five)).toBe(false);
    expect(shelved()).toEqual(full);
    expect(error).toHaveBeenCalledOnce();
    // Owed packs are still updated beside it.
    expect(savePendingPack({ ...ten, counted: true }, five)).toBe(false);
    expect(shelved()).toEqual([entry(10, { d: 1 }), ...full.slice(1)]);
    expect(savePendingPack(ten)).toBe(true);
    error.mockRestore();
  });

  it("holds this player's packs only", () => {
    const me = getPlayer().publicKeyHex;
    const six = pack(6);
    data.set(LIST, JSON.stringify([entry(4, { k: 'ab'.repeat(32) }), entry(5, { k: me })]));
    savePendingPack(six);
    expect(shelved()).toEqual([entry(5, { k: me }), expect.objectContaining({ n: 6 })]);
    data.set(LIST, JSON.stringify([entry(4, { k: 'ab'.repeat(32) }), entry(5, { k: me })]));
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([5]);
  });

  it('reports a shelf it could not write', () => {
    const next = pack(5);
    refuseShelfWrite = true;
    expect(savePendingPack(next)).toBe(false);
  });
});

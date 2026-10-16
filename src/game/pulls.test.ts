import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { encodeCard } from './cardCode';
import { getPlayer } from './player';
import { clearPendingPack, openPack, savePendingPack, takePendingPacks, type OpenedPack } from './pulls';

// Any ticket will do: these tests are about where an opened pack is kept.
vi.mock('./ticketMiner', () => ({ getTicket: async () => new Uint8Array(32), prefetchTicket: () => undefined }));

// A storage whose writes can be refused, as a browser that blocks storage (SecurityError) does.
const data = new Map<string, string>();
let refuseRemove: (key: string) => boolean = () => false;
let refuseWrite: (key: string, value: string) => boolean = () => false;
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (refuseWrite(k, v)) throw new DOMException('Full', 'QuotaExceededError');
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
const entry = (n: number, extra: object = {}) => ({ ...JSON.parse(PENDING), n, ...extra });
const reset = () => {
  data.clear();
  refuseRemove = () => false;
  refuseWrite = () => false;
};

describe('pending pack when storage refuses to remove it', () => {
  beforeEach(reset);

  it('leaves the packs for a later load instead of adding them now and again then', () => {
    data.set(LIST, `[${PENDING}]`);
    data.set(LEGACY, PENDING);
    refuseRemove = () => true;
    expect(takePendingPacks()).toEqual([]);
    expect(shelved()).toEqual([entry(4)]);

    refuseRemove = () => false;
    expect(takePendingPacks()).toMatchObject([{ setId: SET.id, nonce: 4, cards: expect.any(Array) }]);
    expect(data.has(LIST)).toBe(false);
  });

  it("drops an older build's entry it can't add on load, as older builds do", () => {
    for (const stored of ['{not json', JSON.stringify(entry(4, { k: 'ab'.repeat(32) })), JSON.stringify(entry(4, { s: 'no-such-set' }))]) {
      data.set(LEGACY, stored);
      expect(takePendingPacks()).toEqual([]);
      expect(data.has(LEGACY)).toBe(false);
    }
  });

  it("blanks an older build's entry it can't remove once the collection holds its pack, so no load adds it again", () => {
    data.set(LEGACY, PENDING);
    refuseRemove = (k) => k === LEGACY;
    clearPendingPack(4);
    // What both this and older builds read as no pack.
    expect(data.get(LEGACY)).toBe('null');
    expect(takePendingPacks()).toEqual([]);
  });

  it('says so when the entry can be neither removed nor blanked', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    data.set(LEGACY, PENDING);
    refuseRemove = () => true;
    refuseWrite = (k) => k === LEGACY;
    clearPendingPack(4);
    expect(data.get(LEGACY)).toBe(PENDING);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the next load may add it again, though the collection has it'));
    error.mockRestore();
  });

  it("stays quiet about an entry with nothing to add that it can't remove: no load adds anything from it", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    data.set(LEGACY, JSON.stringify(entry(4, { k: 'ab'.repeat(32) })));
    refuseRemove = (k) => k === LEGACY;
    refuseWrite = (k) => k === LEGACY;
    expect(takePendingPacks()).toEqual([]);
    expect(takePendingPacks()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
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
    data.set(LIST, `[${PENDING}]`);
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

  it('leaves the shelf as it was when the counted flag tips storage over its quota, and the uncounted copies still fit', () => {
    const owed = [entry(4), entry(5), entry(6)];
    data.set(LIST, JSON.stringify(owed));
    const [four, five] = takePendingPacks();
    // Room for the shelf as it was, not for the few bytes the flag adds.
    const room = JSON.stringify(owed).length;
    data.set(LIST, JSON.stringify([entry(6)]));
    refuseWrite = (k, v) => k === LIST && v.length > room;
    expect(savePendingPack({ ...four, counted: true }, { ...five, counted: true })).toBe(false);
    expect(shelved()).toEqual([entry(6)]);
    expect(savePendingPack(four, five)).toBe(true);
    expect(shelved()).toEqual([entry(6), entry(4), entry(5)]);
    expect(takePendingPacks().map((p) => p.counted)).toEqual([undefined, undefined, undefined]);
  });
});

/** A pack this build opened, which it lists. */
const pack = (n: number): OpenedPack => {
  data.set(LIST, JSON.stringify([entry(n)]));
  return takePendingPacks()[0];
};

describe('several packs owed at once', () => {
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

    expect(takePendingPacks()).toMatchObject([{ nonce: 4, counted: true, legacy: true }, { nonce: 5, counted: true }]);
    expect(data.has(LIST)).toBe(false);
    // The older build's entry stays until a stored collection holds its pack.
    expect(JSON.parse(data.get(LEGACY)!)).toEqual(entry(4, { d: 1 }));
    clearPendingPack(4, 5);
    expect(data.has(LEGACY)).toBe(false);
    expect(takePendingPacks()).toEqual([]);
  });

  it('never puts a listed pack where an older build looks, so it can neither drop nor re-add one', () => {
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

  it("clears only the stored packs, then none, and writes nothing when none match (another player's stay)", () => {
    const other = entry(7, { k: 'ab'.repeat(32) });
    data.set(LIST, JSON.stringify([entry(4), entry(5), entry(6), other]));
    clearPendingPack(5, 6);
    expect(shelved()).toEqual([other, entry(4)]);
    data.set(LIST, JSON.stringify([entry(4), other]));
    clearPendingPack();
    clearPendingPack(5);
    expect(shelved()).toEqual([entry(4), other]);
    clearPendingPack(4);
    expect(shelved()).toEqual([other]);
    clearPendingPack(7);
    expect(shelved()).toEqual([other]);
  });

  it('keeps the other owed packs when the shorter shelf fits only once the old one is gone', () => {
    data.set(LIST, JSON.stringify([entry(4), entry(5), entry(6)]));
    refuseWrite = (k) => k === LIST && data.has(LIST);
    clearPendingPack(5);
    expect(shelved()).toEqual([entry(4), entry(6)]);
  });

  it("takes this player's packs off a shelf that fits only once the old one is gone, and keeps another player's", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const other = entry(7, { k: 'ab'.repeat(32) });
    data.set(LIST, JSON.stringify([other, entry(4), entry(5), entry(6)]));
    refuseWrite = (k) => k === LIST && data.has(LIST);
    clearPendingPack(5);
    expect(shelved()).toEqual([other, entry(4), entry(6)]);
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([4, 6]);
    expect(shelved()).toEqual([other]);
    // Nothing of this player's is listed, so the shelf stays as it is.
    expect(takePendingPacks()).toEqual([]);
    expect(shelved()).toEqual([other]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("never leaves a pack handed out on the shelf, and says so when another player's can't stay on it", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const other = entry(7, { k: 'ab'.repeat(32) });
    data.set(LIST, JSON.stringify([other, entry(4), entry(5), entry(6)]));
    refuseWrite = (k) => k === LIST;
    clearPendingPack(5);
    expect(data.has(LIST)).toBe(false);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining("2 owed pack(s) dropped (the history still has them); another player's owed packs are kept in this tab"));

    data.set(LIST, JSON.stringify([other, entry(4)]));
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([4]);
    expect(data.has(LIST)).toBe(false);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining("another player's owed packs are kept in this tab"));

    // With none of this player's listed, there is nothing to take off and another player's stay.
    error.mockClear();
    data.set(LIST, JSON.stringify([other]));
    expect(takePendingPacks()).toEqual([]);
    expect(shelved()).toEqual([other]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("keeps another player's packs the shelf couldn't keep, and writes them back once with the next shelf write", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [four, six] = [pack(4), pack(6)];
    const other = entry(7, { k: 'ab'.repeat(32) });
    data.set(LIST, JSON.stringify([other, entry(4), entry(5)]));
    refuseWrite = (k) => k === LIST;
    clearPendingPack(5);
    expect(data.has(LIST)).toBe(false);
    // Nothing of this player's is left to take off, but the held packs get another try.
    clearPendingPack(4);
    expect(data.has(LIST)).toBe(false);
    refuseWrite = () => false;
    clearPendingPack(4);
    expect(shelved()).toEqual([other]);
    // Once stored, this tab no longer holds them, so later writes don't add them again.
    expect(savePendingPack(six)).toBe(true);
    expect(shelved()).toEqual([other, expect.objectContaining({ n: 6 })]);

    // The same when a save puts this player's packs back: the held packs go on the shelf with them.
    data.set(LIST, JSON.stringify([other, entry(4)]));
    refuseWrite = (k) => k === LIST;
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([4]);
    expect(data.has(LIST)).toBe(false);
    refuseWrite = () => false;
    expect(savePendingPack({ ...four, counted: true })).toBe(true);
    expect(shelved()).toEqual([other, expect.objectContaining({ n: 4, d: 1 })]);
    error.mockRestore();
  });

  it("puts the shelf back as it was rather than drop another player's packs, when storage takes only that", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const other = entry(7, { k: 'ab'.repeat(32) });
    const before = JSON.stringify([other, entry(4), entry(5), entry(6)]);
    data.set(LIST, before);
    refuseWrite = (k, v) => k === LIST && v !== before;
    clearPendingPack(5);
    expect(data.get(LIST)).toBe(before);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the next load may add 1 stored pack(s) again'));
    // Taking them off is refused the same way, so none are handed out to be added twice.
    expect(takePendingPacks()).toEqual([]);
    expect(data.get(LIST)).toBe(before);
    error.mockRestore();
  });

  it('takes every pack off rather than leave a stored one to be added again, and says what it dropped', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    data.set(LIST, JSON.stringify([entry(4), entry(5), entry(6)]));
    refuseWrite = (k) => k === LIST;
    clearPendingPack(5);
    expect(data.has(LIST)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('2 owed pack(s) dropped'));
    error.mockRestore();
  });

  it('adds each nonce once, even if the shelf lists it twice, and counts it once if any copy has', () => {
    data.set(LIST, JSON.stringify([entry(4), entry(4, { d: 1 }), 'junk', null, entry(5)]));
    expect(takePendingPacks()).toMatchObject([{ nonce: 4, counted: true }, { nonce: 5 }]);
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

  it("counts another player's packs toward the limit, and never drops one for this player's", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [five, ten] = [pack(5), pack(10)];
    const theirs = Array.from({ length: 45 }, (_, i) => entry(i + 100, { k: 'ab'.repeat(32) }));
    const full = [...theirs, ...Array.from({ length: 5 }, (_, i) => entry(i + 10))];
    data.set(LIST, JSON.stringify(full));
    expect(savePendingPack(five)).toBe(false);
    expect(shelved()).toEqual(full);
    expect(error).toHaveBeenCalledOnce();
    // An owed pack is still updated in place.
    expect(savePendingPack({ ...ten, counted: true })).toBe(true);
    expect(shelved()).toEqual([...theirs, entry(10, { d: 1 }), ...full.slice(46)]);
    // Once one is cleared, there is room again.
    clearPendingPack(10);
    expect(savePendingPack(five)).toBe(true);
    expect(shelved()).toHaveLength(50);
    expect(shelved().slice(0, 45)).toEqual(theirs);
    error.mockRestore();
  });

  it("holds this player's packs only, and leaves another player's there for that player's next load", () => {
    const me = getPlayer().publicKeyHex;
    const six = pack(6);
    const five = { ...pack(5), publicKeyHex: me };
    // Another player's pack, with a nonce of this player's too (each player counts their own).
    const theirs = entry(5, { k: 'ab'.repeat(32) });
    data.set(LIST, JSON.stringify([theirs, entry(5, { k: me })]));
    savePendingPack(six, { ...five, counted: true });
    expect(shelved()).toEqual([theirs, expect.objectContaining({ n: 5, k: me, d: 1 }), expect.objectContaining({ n: 6 })]);
    data.set(LIST, JSON.stringify([theirs, entry(5, { k: me }), 'junk']));
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([5]);
    expect(shelved()).toEqual([theirs]);
  });

  it('reports a shelf it could not write', () => {
    const next = pack(5);
    refuseWrite = (k) => k === LIST;
    expect(savePendingPack(next)).toBe(false);
  });
});

describe("an older tab's pack", () => {
  /** What an older build does once a collection it stored holds the pack. */
  const olderClear = (nonce: number) => {
    if (JSON.parse(data.get(LEGACY) ?? 'null')?.n === nonce) data.delete(LEGACY);
  };
  beforeEach(reset);

  it("stays where that tab's clear reaches it when this tab can't store it, so no load adds it again", () => {
    // An older tab opened pack 4. This tab loads and adds it, but its collection can't be stored.
    data.set(LEGACY, PENDING);
    const [four] = takePendingPacks();
    expect(four).toMatchObject({ nonce: 4, legacy: true });
    expect(data.get(LEGACY)).toBe(PENDING);
    expect(savePendingPack({ ...four, counted: true })).toBe(true);
    expect(JSON.parse(data.get(LEGACY)!)).toEqual(entry(4, { d: 1 }));
    expect(data.has(LIST)).toBe(false);
    // The older tab stores a collection holding it and clears its entry: nothing is left to add again.
    olderClear(4);
    expect(takePendingPacks()).toEqual([]);
  });

  it('is left to the tab that has it once the entry no longer holds it', () => {
    data.set(LEGACY, PENDING);
    const [four] = takePendingPacks();
    olderClear(4);
    expect(savePendingPack({ ...four, counted: true })).toBe(true);
    expect(savePendingPack(four)).toBe(true);
    expect(data.has(LEGACY)).toBe(false);
    expect(data.has(LIST)).toBe(false);
    // Nor does it replace that tab's next pack.
    data.set(LEGACY, JSON.stringify(entry(5)));
    expect(savePendingPack({ ...four, counted: true })).toBe(true);
    expect(JSON.parse(data.get(LEGACY)!)).toEqual(entry(5));
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([5]);
  });

  it('is added once with a listed copy, counted once if either copy has, and cleared from both', () => {
    data.set(LEGACY, PENDING);
    data.set(LIST, JSON.stringify([entry(4, { d: 1 }), entry(5)]));
    const packs = takePendingPacks();
    expect(packs).toMatchObject([{ nonce: 4, counted: true, legacy: true }, { nonce: 5 }]);
    expect(packs[1].legacy).toBeUndefined();
    expect(data.has(LIST)).toBe(false);
    // Put back, it goes to the older build's entry only.
    expect(savePendingPack(...packs)).toBe(true);
    expect(JSON.parse(data.get(LEGACY)!)).toEqual(entry(4, { d: 1 }));
    expect(shelved()).toEqual([expect.objectContaining({ n: 5 })]);
    clearPendingPack(4, 5);
    expect(data.has(LEGACY)).toBe(false);
    expect(data.has(LIST)).toBe(false);
  });

  it('reports an entry it could not put back, which stays as it was', () => {
    data.set(LEGACY, PENDING);
    const [four] = takePendingPacks();
    refuseWrite = (k) => k === LEGACY;
    expect(savePendingPack({ ...four, counted: true })).toBe(false);
    expect(data.get(LEGACY)).toBe(PENDING);
  });
});

describe('opening a pack', () => {
  beforeEach(reset);

  it('warns that saving failed when the pack could not be kept for the next load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await openPack(SET);
    expect(first.unrecorded).toBeUndefined();
    expect(shelved()).toEqual([expect.objectContaining({ n: first.nonce })]);
    // A full shelf keeps its owed packs, so the new one isn't kept.
    const full = Array.from({ length: 50 }, (_, i) => entry(i + 1000));
    data.set(LIST, JSON.stringify(full));
    expect((await openPack(SET)).unrecorded).toBe(true);
    expect(shelved()).toEqual(full);
    // Nor when storage refuses the shelf.
    data.delete(LIST);
    refuseWrite = (k) => k === LIST;
    expect((await openPack(SET)).unrecorded).toBe(true);
    error.mockRestore();
  });
});

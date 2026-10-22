import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { encodeCard } from './cardCode';
import { generatePack, packSeedFromTicket } from '../engine';
import { getBestCards, resetBestCards } from './bestCards';
import { recordTicket } from './history';
import { clearPendingPack, openPack, savePendingPack, takePendingPacks, type OpenedPack } from './pulls';
import { getPlayer, StaleSaveError } from './player';

// Any ticket will do: these tests are about where an opened pack is kept, and when its number is spent.
const ticketFor = (nonce: number) => new Uint8Array(32).fill(nonce & 255);
const miner = vi.hoisted(() => ({
  mine: (_set: string, _key: Uint8Array, nonce: number): Promise<Uint8Array> => Promise.resolve(new Uint8Array(32).fill(nonce & 255)),
}));
vi.mock('./ticketMiner', () => ({
  getTicket: (set: string, key: Uint8Array, nonce: number) => miner.mine(set, key, nonce),
  prefetchTicket: () => undefined,
}));
const mineAtOnce = miner.mine;

// Best-cards bookkeeping that throws, as a store its checks missed would make it.
const bestCards = vi.hoisted(() => ({ throws: false }));
vi.mock('./bestCards', async (importOriginal) => {
  const real = await importOriginal<typeof import('./bestCards')>();
  return {
    ...real,
    recordBestCards: (pack: Parameters<typeof real.recordBestCards>[0]) => {
      if (bestCards.throws) throw new TypeError('Poisoned best cards');
      return real.recordBestCards(pack);
    },
  };
});

// A storage whose writes can be refused, as a browser that blocks storage (SecurityError) does.
const data = new Map<string, string>();
let refuseRemove: (key: string) => boolean = () => false;
let refuseWrite: (key: string, value: string) => boolean = () => false;
/** Every write in order, while a test records them (see inStaleTab). */
let writes: [string, string | null][] | null = null;
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (refuseWrite(k, v)) throw new DOMException('Full', 'QuotaExceededError');
    data.set(k, v);
    writes?.push([k, v]);
  },
  removeItem: (k: string) => {
    if (refuseRemove(k)) throw new DOMException('Denied', 'SecurityError');
    data.delete(k);
    writes?.push([k, null]);
  },
  get length() {
    return data.size;
  },
  key: (i: number) => [...data.keys()][i] ?? null,
});

const SET = getSet('right-now', 2)!;
const PENDING = JSON.stringify({
  s: SET.id, v: SET.version, n: 4, c: SET.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(','), t: 1,
});
/** The list of packs earlier builds of this one kept, and the one-pack entry older builds keep. */
const LIST = STORAGE_KEYS.PENDING_PACKS;
const LEGACY = STORAGE_KEYS.PENDING_PACK;
const shelved = () => JSON.parse(data.get(LIST) ?? 'null');
const entry = (n: number, extra: object = {}) => ({ ...JSON.parse(PENDING), n, ...extra });
/** Each pack this build keeps has an entry of its own. */
const PREFIX = STORAGE_KEYS.PENDING_PACK_PREFIX;
const ME = () => getPlayer().publicKeyHex;
const keyOf = (p: { k: string; n: number }) => `${PREFIX}${p.k}:${p.n}`;
/** This player's pack as this build keeps it. */
const mine = (n: number, extra: object = {}) => entry(n, { k: ME(), ...extra });
const put = (...packs: { k: string; n: number }[]) => packs.forEach((p) => data.set(keyOf(p), JSON.stringify(p)));
/** The packs in entries of their own, by number. */
const own = () => [...data.keys()].filter((k) => k.startsWith(PREFIX)).map((k) => JSON.parse(data.get(k)!)).sort((a, b) => a.n - b.n);
const reset = () => {
  data.clear();
  refuseRemove = () => false;
  refuseWrite = () => false;
  writes = null;
  miner.mine = mineAtOnce;
  bestCards.throws = false;
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

    // The same for a pack in an entry of its own.
    data.delete(LEGACY);
    put(mine(5));
    refuseRemove = (k) => k.startsWith(PREFIX);
    expect(takePendingPacks()).toEqual([]);
    expect(own()).toEqual([mine(5)]);
    refuseRemove = () => false;
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([5]);
    expect(own()).toEqual([]);
  });

  it("says so when a stored pack's entry can't be removed", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    put(mine(4));
    refuseRemove = (k) => k.startsWith(PREFIX);
    clearPendingPack(4, 5);
    expect(own()).toEqual([mine(4)]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the next load may add 1 stored pack(s) again'));
    error.mockRestore();
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
    expect(own()).toEqual([mine(4)]);
    savePendingPack({ ...pack, counted: true });
    expect(own()).toEqual([mine(4, { d: 1 })]);
    expect(takePendingPacks()).toMatchObject([{ nonce: 4, counted: true, cards: pack.cards.map(({ key }) => expect.objectContaining({ key })) }]);

    for (const d of [0, true, '1', null]) {
      data.set(LIST, JSON.stringify([{ ...JSON.parse(PENDING), d }]));
      expect(takePendingPacks()[0].counted).toBeUndefined();
      put(mine(4, { d }));
      expect(takePendingPacks()[0].counted).toBeUndefined();
    }
  });

  it('leaves the shelf as it was when the counted flag tips storage over its quota, and the uncounted copies still fit', () => {
    data.set(LIST, JSON.stringify([entry(4), entry(5), entry(6)]));
    const [four, five, six] = takePendingPacks();
    savePendingPack(four, six);
    // Room for five as it was, not for the few bytes the flag adds; four's flag was already written.
    refuseWrite = (k, v) => k === keyOf(mine(5)) && v.includes('"d":1');
    expect(savePendingPack({ ...four, counted: true }, { ...five, counted: true })).toBe(false);
    expect(own()).toEqual([mine(4), mine(6)]);
    expect(savePendingPack(four, five)).toBe(true);
    expect(own()).toEqual([mine(4), mine(5), mine(6)]);
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
    expect(own()).toEqual([mine(5)]);
    // Putting a pack back replaces its own entry.
    savePendingPack({ ...next, counted: true });
    expect(own()).toEqual([mine(5, { d: 1 })]);
    expect(JSON.parse(data.get(LEGACY)!)).toEqual(entry(4, { d: 1 }));

    expect(takePendingPacks()).toMatchObject([{ nonce: 4, counted: true, legacy: true }, { nonce: 5, counted: true }]);
    expect(own()).toEqual([]);
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
    expect(own()).toEqual([mine(5), mine(6)]);

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

  it("clears only the stored packs' own entries, never another player's", () => {
    const other = entry(5, { k: 'ab'.repeat(32) });
    put(mine(4), mine(5), mine(6), other);
    clearPendingPack(5, 6);
    expect(own()).toEqual([mine(4), other]);
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

  it("keeps another player's packs the list couldn't keep, and writes each to an entry of its own with the next shelf write", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [four, six] = [pack(4), pack(6)];
    const other = entry(7, { k: 'ab'.repeat(32) });
    data.set(LIST, JSON.stringify([other, entry(4), entry(5)]));
    refuseWrite = (k) => k === LIST || k.startsWith(PREFIX);
    clearPendingPack(5);
    expect(data.has(LIST)).toBe(false);
    // Nothing of this player's is left to take off, but the held packs get another try.
    clearPendingPack(4);
    expect(own()).toEqual([]);
    refuseWrite = () => false;
    clearPendingPack(4);
    expect(own()).toEqual([other]);
    expect(data.has(LIST)).toBe(false);
    // That player's next load takes it. This tab no longer holds it, so later writes don't put it back.
    data.delete(keyOf(other));
    expect(savePendingPack(six)).toBe(true);
    expect(own()).toEqual([mine(6)]);

    // The same when a save puts this player's packs back: the held packs are written with them.
    data.set(LIST, JSON.stringify([other, entry(4)]));
    refuseWrite = (k) => k === LIST;
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([4, 6]);
    expect(data.has(LIST)).toBe(false);
    refuseWrite = () => false;
    expect(savePendingPack({ ...four, counted: true })).toBe(true);
    expect(own()).toEqual([mine(4, { d: 1 }), other]);
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
    const full = Array.from({ length: 50 }, (_, i) => mine(i + 10));
    put(...full);
    expect(savePendingPack(five)).toBe(false);
    expect(own()).toEqual(full);
    expect(error).toHaveBeenCalledOnce();
    // Owed packs are still updated beside it.
    expect(savePendingPack({ ...ten, counted: true }, five)).toBe(false);
    expect(own()).toEqual([mine(10, { d: 1 }), ...full.slice(1)]);
    expect(savePendingPack(ten)).toBe(true);
    // Packs still on the list earlier builds kept count too.
    data.clear();
    data.set(LIST, JSON.stringify(full));
    expect(savePendingPack(five)).toBe(false);
    expect(own()).toEqual([]);
    expect(shelved()).toEqual(full);
    error.mockRestore();
  });

  it("counts another player's packs toward the limit, and never drops one for this player's", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [five, ten] = [pack(5), pack(10)];
    const theirs = Array.from({ length: 45 }, (_, i) => entry(i + 100, { k: 'ab'.repeat(32) }));
    const ours = Array.from({ length: 5 }, (_, i) => mine(i + 10));
    // Some of theirs in entries of their own, the rest still on the list earlier builds kept.
    put(...ours, ...theirs.slice(20));
    data.set(LIST, JSON.stringify(theirs.slice(0, 20)));
    expect(savePendingPack(five)).toBe(false);
    expect(own()).toEqual([...ours, ...theirs.slice(20)]);
    expect(error).toHaveBeenCalledOnce();
    // An owed pack is still updated in place.
    expect(savePendingPack({ ...ten, counted: true })).toBe(true);
    expect(own()).toEqual([mine(10, { d: 1 }), ...ours.slice(1), ...theirs.slice(20)]);
    // Once one is cleared, there is room again.
    clearPendingPack(10);
    expect(savePendingPack(five)).toBe(true);
    expect(own()).toEqual([mine(5), ...ours.slice(1), ...theirs.slice(20)]);
    expect(shelved()).toEqual(theirs.slice(0, 20));
    error.mockRestore();
  });

  it("holds this player's packs only, and leaves another player's there for that player's next load", () => {
    const me = getPlayer().publicKeyHex;
    const six = pack(6);
    const five = { ...pack(5), publicKeyHex: me };
    // Another player's pack, with a nonce of this player's too (each player counts their own).
    const theirs = entry(5, { k: 'ab'.repeat(32) });
    put(theirs);
    savePendingPack(six, { ...five, counted: true });
    expect(own().filter((p) => p.k === me)).toEqual([mine(5, { d: 1 }), mine(6)]);
    expect(JSON.parse(data.get(keyOf(theirs))!)).toEqual(theirs);
    data.set(LIST, JSON.stringify([theirs, entry(5, { k: me }), 'junk']));
    expect(takePendingPacks()).toMatchObject([{ nonce: 5, counted: true }, { nonce: 6 }]);
    expect(shelved()).toEqual([theirs]);
    expect(own()).toEqual([theirs]);
  });

  it('reports a shelf it could not write', () => {
    const next = pack(5);
    refuseWrite = (k) => k.startsWith(PREFIX);
    expect(savePendingPack(next)).toBe(false);
    expect(own()).toEqual([]);
  });
});

describe('two tabs of one player at once (#87)', () => {
  beforeEach(reset);

  /**
   * Runs `act` as another tab whose storage still reads as `seen` (Chromium hands one tab's writes
   * to the others a little later), then applies its writes to storage in order, as the browser does.
   */
  const inStaleTab = (seen: Map<string, string>, act: () => void) => {
    const current = new Map(data);
    data.clear();
    seen.forEach((v, k) => data.set(k, v));
    writes = [];
    act();
    const made = writes;
    writes = null;
    data.clear();
    current.forEach((v, k) => data.set(k, v));
    for (const [k, v] of made) {
      if (v === null) data.delete(k);
      else data.set(k, v);
    }
  };

  it("keeps this tab's pack when the other, not having seen it yet, shelves and stores its own", () => {
    const [zero, one] = [pack(0), pack(1)];
    const before = new Map(data);
    expect(savePendingPack(one)).toBe(true);
    inStaleTab(before, () => {
      expect(savePendingPack(zero)).toBe(true);
      clearPendingPack(0);
    });
    expect(own()).toEqual([mine(1)]);
    expect(takePendingPacks().map((p) => p.nonce)).toEqual([1]);
  });

  it('never puts back a pack this tab stored when the other, not having seen that, puts its own back', () => {
    const [zero, one] = [pack(0), pack(1)];
    expect(savePendingPack(zero, one)).toBe(true);
    const both = new Map(data);
    clearPendingPack(1);
    inStaleTab(both, () => {
      expect(savePendingPack({ ...zero, counted: true })).toBe(true);
    });
    expect(own()).toEqual([mine(0, { d: 1 })]);
    expect(takePendingPacks()).toMatchObject([{ nonce: 0, counted: true }]);
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
    expect(own()).toEqual([]);
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
    expect(own()).toEqual([]);
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
    expect(own()).toEqual([mine(5)]);
    clearPendingPack(4, 5);
    expect(data.has(LEGACY)).toBe(false);
    expect(own()).toEqual([]);
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
    expect(own()).toEqual([expect.objectContaining({ n: first.nonce, k: ME() })]);
    // A full shelf keeps its owed packs, so the new one isn't kept.
    const full = Array.from({ length: 50 }, (_, i) => entry(i + 1000));
    data.set(LIST, JSON.stringify(full));
    expect((await openPack(SET)).unrecorded).toBe(true);
    expect(own()).toHaveLength(1);
    expect(shelved()).toEqual(full);
    // Nor when storage refuses the shelf.
    data.delete(LIST);
    refuseWrite = (k) => k.startsWith(PREFIX);
    expect((await openPack(SET)).unrecorded).toBe(true);
    error.mockRestore();
  });

  it("ranks the pack among its player's best cards, and a refused best-cards write doesn't mark it unsaved", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const best = () => JSON.parse(data.get(STORAGE_KEYS.BEST_CARDS) ?? '{}');
    const me = getPlayer().publicKeyHex;
    const first = await openPack(SET);
    expect(best()[me].b.map((e: { n: number }) => e.n)).toEqual(Array(SET.packSize).fill(first.nonce));
    refuseWrite = (k) => k === STORAGE_KEYS.BEST_CARDS;
    const second = await openPack(SET);
    expect(second.unrecorded).toBeUndefined();
    const held = getBestCards(me, second.nonce + 1);
    expect(held.unsaved).toBe(true);
    expect(held.cards.filter((c) => c.nonce === second.nonce).length).toBeGreaterThan(0);
    expect(best()[me].b.every((e: { n: number }) => e.n === first.nonce)).toBe(true);
    resetBestCards();
    error.mockRestore();
  });

  it('shelves the pack whatever is wrong with the best cards: the ticket is already spent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const me = getPlayer().publicKeyHex;
    // A cached card holding a line break, which decodeCard can't read: the list is left alone.
    const poisoned = JSON.stringify({ [me]: { w: 0, b: [{ s: SET.id, v: SET.version, n: 0, i: 0, c: 'sigma\n', t: 0 }] } });
    data.set(STORAGE_KEYS.BEST_CARDS, poisoned);
    const first = await openPack(SET);
    expect(first.unrecorded).toBeUndefined();
    expect(data.get(STORAGE_KEYS.BEST_CARDS)).toBe(poisoned);
    // And bookkeeping that throws anyway fails neither the opening nor the shelf write.
    bestCards.throws = true;
    const second = await openPack(SET);
    expect(second.unrecorded).toBeUndefined();
    expect(own().map((p: { n: number }) => p.n)).toEqual([first.nonce, second.nonce]);
    resetBestCards();
    error.mockRestore();
  });

  it('never reuses a ticket number when storage refuses the ticket counter, and warns', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = await openPack(SET);
    expect(before.unrecorded).toBeUndefined();
    refuseWrite = (k) => k === 'brainrot-player-v1';
    const opened = [await openPack(SET), await openPack(SET)];
    expect(opened.map((p) => p.nonce)).toEqual([before.nonce + 1, before.nonce + 2]);
    expect(opened.map((p) => p.unrecorded)).toEqual([true, true]);
    // Both are still kept for the next load and recorded: only the counter was refused.
    expect(own().map((e: { n: number }) => e.n)).toEqual([before.nonce, before.nonce + 1, before.nonce + 2]);
    expect(JSON.parse(data.get('brainrot-player-v1')!).nextNonce).toBe(before.nonce + 1);
    error.mockRestore();
  });

  const PLAYER = 'brainrot-player-v1';
  const counter = () => JSON.parse(data.get(PLAYER)!).nextNonce as number;
  const recorded = () => (JSON.parse(data.get(STORAGE_KEYS.HISTORY) ?? '[]') as { n: number; s: string; v: number }[]);
  const nextTask = () => new Promise((resolve) => setTimeout(resolve));
  /** Mining that waits for `release()`, as a slow phone's does. */
  const slowMiner = () => {
    const asked: number[] = [];
    const releases: (() => void)[] = [];
    miner.mine = (_set, _key, nonce) => {
      asked.push(nonce);
      return new Promise((resolve) => releases.push(() => resolve(ticketFor(nonce))));
    };
    return { asked, release: () => releases.shift()!() };
  };

  it('spends no ticket number until its ticket is mined, then stores the counter and mapping in one task', async () => {
    const before = await openPack(SET);
    const mining = slowMiner();
    // What the history holds once the task that stores the counter is over (a tab closed then).
    let atCounter: string | undefined;
    refuseWrite = (k) => {
      if (k === PLAYER) setTimeout(() => (atCounter = data.get(STORAGE_KEYS.HISTORY)));
      return false;
    };
    const opening = openPack(SET);
    await nextTask();
    // Closed mid-mine: nothing spent, nothing to map.
    expect(mining.asked).toEqual([before.nonce + 1]);
    expect(counter()).toBe(before.nonce + 1);
    expect(atCounter).toBeUndefined();
    mining.release();
    const pack = await opening;
    await nextTask();
    expect(pack).toMatchObject({ nonce: before.nonce + 1 });
    expect(pack.unrecorded).toBeUndefined();
    expect(counter()).toBe(before.nonce + 2);
    expect(JSON.parse(atCounter!)).toContainEqual(expect.objectContaining({ n: pack.nonce, s: SET.id, v: SET.version }));
  });

  it('spends no ticket number when mining fails', async () => {
    const before = await openPack(SET);
    miner.mine = () => Promise.reject(new Error('miner crashed'));
    await expect(openPack(SET)).rejects.toThrow('miner crashed');
    expect(counter()).toBe(before.nonce + 1);
    expect(recorded().map((e) => e.n)).toEqual([before.nonce]);
    miner.mine = mineAtOnce;
    expect((await openPack(SET)).nonce).toBe(before.nonce + 1);
  });

  it("mines the number it claimed when another tab took the one it mined, so cards match the recorded ticket", async () => {
    const before = await openPack(SET);
    const mining = slowMiner();
    const opening = openPack(SET);
    await nextTask();
    // Another tab opens a pack while this one mines.
    data.set(PLAYER, JSON.stringify({ ...JSON.parse(data.get(PLAYER)!), nextNonce: before.nonce + 2 }));
    mining.release();
    await nextTask();
    expect(mining.asked).toEqual([before.nonce + 1, before.nonce + 2]);
    mining.release();
    const pack = await opening;
    expect(pack.nonce).toBe(before.nonce + 2);
    expect(pack.cards.map((c) => c.key)).toEqual(generatePack(SET, packSeedFromTicket(ticketFor(before.nonce + 2))).map((c) => `${c.setId}/${c.cardId}`));
    // The pack takes its stand-in's place and time, so it sorts where the stand-in did.
    expect(recorded()[0]).toMatchObject({ n: before.nonce + 2, s: SET.id, v: SET.version, t: pack.openedAt });
    expect(recorded().filter((e) => e.n === before.nonce + 2)).toHaveLength(1);
    expect(counter()).toBe(before.nonce + 3);
  });

  it('refuses to claim or spend a replacement save when another tab switched player during mining', async () => {
    const before = await openPack(SET);
    const mining = slowMiner();
    const opening = openPack(SET);
    await nextTask();
    // Another tab switches player while this one mines.
    const incomingPlayer = { secretKey: 'ff'.repeat(32), name: 'Replacement', nextNonce: 0, createdAt: 1 };
    data.set(PLAYER, JSON.stringify(incomingPlayer));
    const bestBefore = data.get(STORAGE_KEYS.BEST_CARDS);
    mining.release();
    await expect(opening).rejects.toBeInstanceOf(StaleSaveError);
    // Replacement player's counter, history, best cards and pending shelf stay untouched.
    expect(counter()).toBe(0);
    expect(recorded().map((e) => e.n)).toEqual([before.nonce]);
    expect(data.get(STORAGE_KEYS.BEST_CARDS)).toBe(bestBefore);
    expect(getBestCards(getPlayer().publicKeyHex, 0).cards).toEqual([]);
  });

  it('refuses to claim when the save was replaced by a backup of the same player (new stamp) during mining', async () => {
    const before = await openPack(SET);
    const mining = slowMiner();
    const opening = openPack(SET);
    await nextTask();
    // Same player, but an import with a new stamp happened.
    const { newSaveStamp, SAVE_STAMP_KEY } = await import('./player');
    data.set(SAVE_STAMP_KEY, newSaveStamp());
    mining.release();
    await expect(opening).rejects.toBeInstanceOf(StaleSaveError);
    expect(counter()).toBe(before.nonce + 1);
    expect(recorded().map((e) => e.n)).toEqual([before.nonce]);
  });

  it('maps the number it claimed before mining it again, so a failed mine leaves a ticket to re-open, not a gap', async () => {
    const { myProfileInfo } = await import('./profiles');
    const before = await openPack(SET);
    const was = myProfileInfo()!;
    const mining = slowMiner();
    const opening = openPack(SET);
    await nextTask();
    // Another tab claims and maps the number this one mined.
    data.set(PLAYER, JSON.stringify({ ...JSON.parse(data.get(PLAYER)!), nextNonce: before.nonce + 2 }));
    recordTicket(SET.id, SET.version, before.nonce + 1, getPlayer().publicKeyHex, 1);
    // The second mine fails, as a crashed worker's (or a reload's) would.
    miner.mine = () => Promise.reject(new Error('miner crashed'));
    mining.release();
    await expect(opening).rejects.toThrow('miner crashed');
    expect(counter()).toBe(before.nonce + 3);
    expect(recorded()[0]).toEqual({ s: SET.id, v: SET.version, n: before.nonce + 2, k: expect.any(String), h: '', x: 0, t: expect.any(Number) });
    // Both new numbers have their set, so the profile link waits on re-opening them, not on a lost mapping.
    expect(myProfileInfo()).toMatchObject({ packs: was.packs + 2, filled: was.filled, missing: was.missing + 2 });
  });

  it('never hands out a recorded ticket number again after a reload, even when storage refused its counter', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = await openPack(SET);
    refuseWrite = (k) => k === PLAYER;
    const refused = await openPack(SET);
    expect(refused).toMatchObject({ nonce: before.nonce + 1, unrecorded: true });
    expect(counter()).toBe(before.nonce + 1);
    expect(recorded()[0]).toMatchObject({ n: refused.nonce });
    // Reload: a fresh tab only has what storage kept.
    refuseWrite = () => false;
    vi.resetModules();
    const player = await import('./player');
    const pulls = await import('./pulls');
    expect(player.getPlayerTickets().nextNonce).toBe(before.nonce + 2);
    expect(JSON.parse(player.exportPlayer()).nextNonce).toBe(before.nonce + 2);
    const after = await pulls.openPack(SET);
    expect(after.nonce).toBe(before.nonce + 2);
    expect(after.unrecorded).toBeUndefined();
    expect(counter()).toBe(before.nonce + 3);
    error.mockRestore();
  });
});

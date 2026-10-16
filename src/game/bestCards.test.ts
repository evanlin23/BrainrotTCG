import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { scoreCards } from '../data/cards';
import { cardPoints, derivePack, fromHex, type PulledCard, type TicketFn } from '../engine';
import {
  BEST_CARDS_CAP,
  getBestCards,
  isBestCardsStore,
  mergeBestCards,
  rebuildBestCards,
  recordBestCards,
  resetBestCards,
  type BestCandidate,
} from './bestCards';
import { decodeCard, encodeCard, toPulled } from './cardCode';
import { recordPack } from './history';
import { resetPackStore } from './packStore';
import { getPlayer } from './player';
import { syncMyBestCards } from './profiles';
import { toCardsWithMeta, type OpenedPack } from './pulls';
import { exportSaveFile, importSaveFile } from './saveFile';

// A cached card that passes the shape check but that decoding can't read: how a bad winner looks if the two drift.
vi.mock('./cardCode', async (importOriginal) => {
  const real = await importOriginal<typeof import('./cardCode')>();
  return {
    ...real,
    decodeCard: (text: string) => {
      if (text === 'unreadable') throw new TypeError('Unreadable card');
      return real.decodeCard(text);
    },
  };
});

// A later version of right-now that makes every card the rarest: it must never rescore older winners.
vi.mock('../content/sets', async (importOriginal) => {
  const real = await importOriginal<typeof import('../content/sets')>();
  const v2 = real.getSet('right-now', 2)!;
  const v3 = { ...v2, version: 3, cards: v2.cards.map((c) => ({ ...c, rarity: 'BRAINROT' as const })) };
  return { ...real, getSet: (id: string, version: number) => (id === 'right-now' && version === 3 ? v3 : real.getSet(id, version)) };
});

const data = new Map<string, string>();
let refuseWrite: (key: string) => boolean = () => false;
vi.stubGlobal('localStorage', {
  get length() { return data.size; },
  key: (index: number) => [...data.keys()][index] ?? null,
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (refuseWrite(k)) throw new DOMException('Full', 'QuotaExceededError');
    data.set(k, v);
  },
  removeItem: (k: string) => void data.delete(k),
});

const SET = getSet('right-now', 2)!;
const V1 = getSet('right-now', 1)!;
const V3 = getSet('right-now', 3)!;
const KEY = 'ab'.repeat(32);
/** Shares KEY's 16-hex prefix, which is all the pack history keeps. */
const TWIN = 'ab'.repeat(8) + 'cd'.repeat(24);
const BEST = STORAGE_KEYS.BEST_CARDS;

const points = (rarity: PulledCard['rarity'], holo = false) => cardPoints(rarity, holo, null, false);
const byPoints = [...SET.cards].sort((a, b) => points(b.rarity) - points(a.rarity));
const TOP = byPoints[0].id;
const WEAK = byPoints[byPoints.length - 1].id;
const rarityOf = (id: string) => SET.cards.find((c) => c.id === id)!.rarity;

const cardsOf = (ids: string[], set = SET) => toPulled(ids.map((id) => ({ id, holo: false })), set)!;
const pack = (nonce: number, ids: string[], openedAt = 1000 + nonce, set = SET): BestCandidate =>
  ({ setId: set.id, setVersion: set.version, nonce, openedAt, cards: cardsOf(ids, set) });
const weakPack = (nonce: number) => pack(nonce, Array(SET.packSize).fill(WEAK));
/** Offers packs, moving the weighed mark over each taken ticket that follows it. */
const offer = (key: string, ...packs: BestCandidate[]) => mergeBestCards(key, packs, (w, taken) => {
  let through = w;
  while (taken.has(through)) through++;
  return through;
});
const stored = () => JSON.parse(data.get(BEST) ?? 'null');
const refs = (key = KEY, used = 0) => getBestCards(key, used).cards.map((c) => `${c.nonce}/${c.slot}`);

const fakeTicket: TicketFn = async (_set, key, nonce) => {
  const ticket = new Uint8Array(32);
  ticket.set(key.subarray(0, 31));
  ticket[31] = nonce & 255;
  return ticket;
};

const opened = (nonce: number, pulled: PulledCard[], publicKeyHex = KEY, openedAt = 1000 + nonce): OpenedPack => {
  const cards = toCardsWithMeta(pulled);
  return { setId: SET.id, setVersion: SET.version, nonce, publicKeyHex, cards, score: scoreCards(cards), openedAt };
};

beforeEach(() => {
  data.clear();
  refuseWrite = () => false;
  resetBestCards();
  resetPackStore();
});

describe('ranking', () => {
  it('ranks by card points, then the lower ticket, then the higher slot, never by openedAt', () => {
    const early = pack(0, [WEAK, TOP, WEAK, TOP, WEAK], 5000);
    const late = pack(1, [TOP, WEAK, WEAK, WEAK, WEAK], 1);
    expect(offer(KEY, late, early)).toBe(true);
    expect(refs()).toEqual(['0/3', '0/1', '1/0', '0/4', '0/2', '0/0', '1/4', '1/3', '1/2', '1/1']);
    const [first] = getBestCards(KEY, 2).cards;
    expect(first).toMatchObject({ publicKeyHex: KEY, setId: SET.id, setVersion: SET.version, nonce: 0, slot: 3 });
    expect(first.points).toBe(points(rarityOf(TOP)));
  });

  it('keeps the 10 strongest', () => {
    const packs = Array.from({ length: 4 }, (_, n) => pack(n, n % 2 ? Array(SET.packSize).fill(TOP) : Array(SET.packSize).fill(WEAK)));
    offer(KEY, ...packs);
    const { cards } = getBestCards(KEY, 4);
    expect(cards).toHaveLength(BEST_CARDS_CAP);
    expect(cards.every((c) => c.card?.cardId === TOP)).toBe(true);
    expect(stored()[KEY].b).toHaveLength(BEST_CARDS_CAP);
  });

  it('never lists an instance twice when a pack is offered again, equal cards in two slots included', () => {
    const twice = pack(0, [WEAK, TOP, WEAK, TOP, WEAK]);
    offer(KEY, twice);
    const before = data.get(BEST);
    offer(KEY, twice);
    recordBestCards(opened(0, twice.cards as PulledCard[]));
    expect(data.get(BEST)).toBe(before);
    expect(refs()).toEqual(['0/3', '0/1', '0/4', '0/2', '0/0']);
  });

  it("scores each winner by its own set version, which a later version can't change", () => {
    offer(KEY, pack(0, Array(SET.packSize).fill(WEAK)), pack(1, Array(SET.packSize).fill(WEAK), 1001, V3));
    const { cards } = getBestCards(KEY, 2);
    expect(cards.slice(0, 5).map((c) => [c.setVersion, c.points])).toEqual(Array(5).fill([3, points('BRAINROT')]));
    expect(cards.slice(5).map((c) => [c.setVersion, c.points])).toEqual(Array(5).fill([2, points(rarityOf(WEAK))]));
    // The same cached code under v1 (no finishes) and v2 (finishes): each version's own rule.
    const code = encodeCard({ id: TOP, holo: true, finish: 'GOLD', misprint: true });
    data.set(BEST, JSON.stringify({
      [KEY]: { w: 2, b: [{ s: SET.id, v: 2, n: 0, i: 0, c: code, t: 1 }, { s: V1.id, v: 1, n: 1, i: 0, c: code, t: 2 }] },
    }));
    const [v2, v1] = getBestCards(KEY, 2).cards;
    expect(v2.points).toBe(cardPoints(rarityOf(TOP), true, 'GOLD', true));
    expect(v1.points).toBe(cardPoints(V1.cards.find((c) => c.id === TOP)!.rarity, true));
  });
});

describe('reconstruction', () => {
  it('keeps a winner rebuildable after the history drops its pack and the cached card', async () => {
    const cards = await derivePack(SET, fromHex(KEY), 0, fakeTicket);
    expect(recordPack(opened(0, cards))).toBe(true);
    recordBestCards(opened(0, cards));
    const built = stored()[KEY].b;
    data.delete(STORAGE_KEYS.HISTORY);
    data.set(BEST, JSON.stringify({ [KEY]: { w: 1, b: built.map(({ c: _c, ...ref }: { c: string }) => ref) } }));
    const lost = getBestCards(KEY, 1);
    expect(lost.complete).toBe(false);
    expect(lost.cards.every((c) => c.card === null && c.points === null)).toBe(true);
    expect(lost.cards.map((c) => `${c.nonce}/${c.slot}`)).toEqual(built.map((e: { n: number; i: number }) => `${e.n}/${e.i}`).sort((a: string, b: string) => b.localeCompare(a)));

    // A failed rebuild keeps them as they are; the next one fills them from the engine.
    const failing = await rebuildBestCards(KEY, 1, { ticketFn: () => Promise.reject(new Error('no miner')) });
    expect(failing).toMatchObject({ failed: 1, complete: false });
    expect(failing.cards).toHaveLength(SET.packSize);
    const rebuilt = await rebuildBestCards(KEY, 1, { ticketFn: fakeTicket });
    expect(rebuilt).toMatchObject({ failed: 0, complete: true, unsaved: false });
    expect(stored()[KEY].b).toEqual(built);
  });

  it("replaces a cached card that disagrees with its ticket, and stops calling the list complete", async () => {
    const cards = await derivePack(SET, fromHex(KEY), 0, fakeTicket);
    recordBestCards(opened(0, cards));
    const truth = data.get(BEST);
    const forged = stored();
    forged[KEY].b[0].c = encodeCard({ id: decodeCard(forged[KEY].b[0].c!).id === TOP ? WEAK : TOP, holo: false });
    data.set(BEST, JSON.stringify(forged));
    const rebuilt = await rebuildBestCards(KEY, 1, { all: true, ticketFn: fakeTicket });
    expect(rebuilt.complete).toBe(false);
    expect(stored()[KEY].b).toEqual(JSON.parse(truth!)[KEY].b);
  });

  it('lists the best among recoverable packs until every used ticket is weighed', () => {
    expect(getBestCards(KEY, 0).complete).toBe(true);
    recordBestCards(opened(0, weakPack(0).cards as PulledCard[]));
    recordBestCards(opened(2, cardsOf(Array(SET.packSize).fill(TOP))));
    expect(stored()[KEY].w).toBe(1);
    const partial = getBestCards(KEY, 3);
    expect(partial.complete).toBe(false);
    expect(partial.cards.slice(0, 5).every((c) => c.nonce === 2)).toBe(true);
    recordBestCards(opened(1, weakPack(1).cards as PulledCard[]));
    expect(stored()[KEY].w).toBe(2);
    offer(KEY, weakPack(1), pack(2, Array(SET.packSize).fill(TOP)));
    expect(getBestCards(KEY, 3).complete).toBe(true);
  });
});

describe('ticket assignments', () => {
  const history = (...records: [number, number, number][]) => data.set(STORAGE_KEYS.HISTORY, JSON.stringify(
    records.map(([n, v, t]) => ({ s: SET.id, v, n, k: KEY.slice(0, 16), h: 'No Matches', x: 0, t })),
  ));

  it('awards a ticket spent twice only to the pack opened first, as a profile does', () => {
    history([0, 2, 10]);
    expect(offer(KEY, pack(0, Array(SET.packSize).fill(TOP), 20, V1))).toBe(true);
    expect(refs()).toEqual([]);
    expect(stored()[KEY].w).toBe(0);
    offer(KEY, pack(0, Array(SET.packSize).fill(TOP), 10));
    expect(getBestCards(KEY, 1)).toMatchObject({ complete: true });
    // An earlier record of another set on that ticket turns up (an imported backup): it wins.
    history([0, 2, 10], [0, 1, 5]);
    offer(KEY);
    expect(refs()).toEqual([]);
    expect(getBestCards(KEY, 1).complete).toBe(false);
  });
});

describe('storage', () => {
  it('keeps the stored winners when a save fails, shows the newer list as unsaved, and retries', () => {
    offer(KEY, weakPack(0));
    const before = data.get(BEST);
    refuseWrite = (k) => k === BEST;
    expect(offer(KEY, pack(1, Array(SET.packSize).fill(TOP)))).toBe(false);
    expect(data.get(BEST)).toBe(before);
    const held = getBestCards(KEY, 2);
    expect(held).toMatchObject({ unsaved: true, complete: true });
    expect(held.cards[0].nonce).toBe(1);
    refuseWrite = () => false;
    expect(offer(KEY)).toBe(true);
    expect(getBestCards(KEY, 2)).toMatchObject({ unsaved: false, complete: true });
    expect(stored()[KEY].b[0].n).toBe(1);
  });

  it.each([['broken JSON', '{'], ['a broken shape', JSON.stringify({ short: { w: 0, b: [] } })]])('never overwrites %s', (_, raw) => {
    data.set(BEST, raw);
    expect(offer(KEY, weakPack(0))).toBe(false);
    expect(data.get(BEST)).toBe(raw);
    expect(getBestCards(KEY, 1)).toMatchObject({ unsaved: true });
  });

  it('keeps every key to its own list, even keys sharing the history prefix', () => {
    offer(KEY, weakPack(0));
    offer(TWIN, pack(0, Array(SET.packSize).fill(TOP)));
    expect(Object.keys(stored()).sort()).toEqual([KEY, TWIN]);
    expect(getBestCards(KEY, 1).cards.every((c) => c.publicKeyHex === KEY && c.card?.cardId === WEAK)).toBe(true);
    expect(getBestCards(TWIN, 1).cards.every((c) => c.publicKeyHex === TWIN && c.card?.cardId === TOP)).toBe(true);
    // A pack without its full key (the history's prefix only) goes to no list.
    expect(offer(KEY.slice(0, 16), weakPack(1))).toBe(true);
    expect(recordBestCards({ ...opened(1, weakPack(1).cards as PulledCard[]), publicKeyHex: KEY.slice(0, 16) })).toBe(true);
    expect(Object.keys(stored()).sort()).toEqual([KEY, TWIN]);
  });

  it.each<[string, unknown]>([
    ['a short key', { [KEY.slice(0, 16)]: { w: 0, b: [] } }],
    ['too many winners', { [KEY]: { w: 0, b: Array.from({ length: 11 }, (_, n) => ({ s: SET.id, v: 2, n, i: 0, c: WEAK, t: 0 })) } }],
    ['one instance twice', { [KEY]: { w: 0, b: [0, 0].map(() => ({ s: SET.id, v: 2, n: 0, i: 1, c: WEAK, t: 0 })) } }],
    ['two sets on one ticket', { [KEY]: { w: 0, b: [1, 2].map((v, i) => ({ s: SET.id, v, n: 0, i, c: WEAK, t: 0 })) } }],
    ['a negative mark', { [KEY]: { w: -1, b: [] } }],
    ['a pack list for a card', { [KEY]: { w: 0, b: [{ s: SET.id, v: 2, n: 0, i: 0, c: `${WEAK},${WEAK}`, t: 0 }] } }],
    // decodeCard can't read these (its `.` stops at line breaks), so they'd throw wherever the card is scored.
    ...[['\\n', '\n'], ['\\r', '\r'], ['U+2028', '\u2028'], ['U+2029', '\u2029']].map(([name, br]) =>
      [`a card holding ${name}`, { [KEY]: { w: 0, b: [{ s: SET.id, v: 2, n: 0, i: 0, c: `${WEAK}${br}`, t: 0 }] } }] as [string, unknown]),
  ])('rejects %s', (_, value) => {
    expect(isBestCardsStore(value)).toBe(false);
  });

  it('leaves a store holding an unreadable card alone, and never throws on it', () => {
    const raw = JSON.stringify({ [KEY]: { w: 0, b: [{ s: SET.id, v: 2, n: 0, i: 0, c: `${WEAK}\n`, t: 0 }] } });
    data.set(BEST, raw);
    expect(getBestCards(KEY, 0)).toMatchObject({ cards: [], unsaved: false });
    expect(recordBestCards(opened(0, cardsOf(Array(SET.packSize).fill(WEAK))))).toBe(false);
    expect(data.get(BEST)).toBe(raw);
    expect(getBestCards(KEY, 1)).toMatchObject({ unsaved: true });
  });

  it("skips a winner it can't score at all, keeps the rest, and rebuilds it from its reference", async () => {
    const cards = await derivePack(SET, fromHex(KEY), 0, fakeTicket);
    recordBestCards(opened(0, cards));
    const all = refs(KEY, 1);
    const list = stored();
    const [bad] = list[KEY].b.splice(0, 1, { ...list[KEY].b[0], c: 'unreadable' });
    data.set(BEST, JSON.stringify(list));
    expect(isBestCardsStore(list)).toBe(true);
    const rest = all.filter((r) => r !== `${bad.n}/${bad.i}`);
    expect(getBestCards(KEY, 1)).toMatchObject({ complete: false, unsaved: false });
    expect(refs(KEY, 1)).toEqual(rest);
    // A merge drops it, and reweighs: it may have pushed out what belongs back.
    expect(offer(KEY)).toBe(true);
    expect(stored()[KEY].w).toBe(0);
    expect(stored()[KEY].b).toHaveLength(rest.length);
    // Held but unscorable, a rebuild re-derives its pack.
    data.set(BEST, JSON.stringify(list));
    expect(await rebuildBestCards(KEY, 1, { ticketFn: fakeTicket })).toMatchObject({ failed: 0 });
    expect(refs(KEY, 1)).toEqual(all);
  });
});

describe('save files', () => {
  const SECRET = '01'.repeat(32);
  const usePlayer = (secretKey: string, nextNonce: number) =>
    data.set('brainrot-player-v1', JSON.stringify({ secretKey, name: 'Tester', nextNonce, createdAt: 0 }));

  it('carries the lists into a fresh browser, where they rebuild without the source cache', async () => {
    usePlayer(SECRET, 1);
    const me = getPlayer().publicKeyHex;
    const cards = await derivePack(SET, fromHex(me), 0, fakeTicket);
    recordBestCards(opened(0, cards, me));
    const lists = data.get(BEST);
    const save = exportSaveFile();
    expect(JSON.parse(save).bestCards).toBe(lists);

    data.clear();
    resetBestCards();
    resetPackStore();
    expect(importSaveFile(save)).toBeNull();
    expect(data.get(BEST)).toBe(lists);
    expect(getBestCards(me, 1)).toMatchObject({ complete: true, unsaved: false });
    // Reimporting it adds nothing.
    expect(importSaveFile(save)).toBeNull();
    expect(data.get(BEST)).toBe(lists);
    // Without the cached cards (or this build's cache), the references alone rebuild it.
    const bare = JSON.parse(lists!);
    for (const e of bare[me].b) delete e.c;
    data.set(BEST, JSON.stringify(bare));
    await rebuildBestCards(me, 1, { ticketFn: fakeTicket });
    expect(data.get(BEST)).toBe(lists);
  });

  it('rejects an invalid list without importing anything', () => {
    const save = JSON.parse(exportSaveFile());
    save.bestCards = JSON.stringify({ [KEY]: { w: 0, b: [0, 0].map(() => ({ s: SET.id, v: 2, n: 0, i: 1, c: WEAK, t: 0 })) } });
    const before = new Map(data);
    expect(importSaveFile(JSON.stringify(save))).toBe('The bestCards in this save is invalid. Nothing was imported.');
    expect(data).toEqual(before);
  });

  it("clears this browser's lists when another player's save without them is imported", () => {
    usePlayer(SECRET, 1);
    offer(getPlayer().publicKeyHex, weakPack(0));
    const save = JSON.parse(exportSaveFile());
    delete save.bestCards;
    save.player = JSON.stringify({ secretKey: '02'.repeat(32), name: 'Other', nextNonce: 0, createdAt: 0 });
    expect(importSaveFile(JSON.stringify(save))).toBeNull();
    expect(data.has(BEST)).toBe(false);
  });
});

describe("the current player's sync", () => {
  it('weighs every recoverable pack and reads as complete only once none is missing', () => {
    data.set('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Tester', nextNonce: 3, createdAt: 0 }));
    const me = getPlayer().publicKeyHex;
    recordPack(opened(0, cardsOf(Array(SET.packSize).fill(WEAK)), me));
    recordPack(opened(2, cardsOf(Array(SET.packSize).fill(TOP)), me));
    const partial = syncMyBestCards();
    expect(partial).toMatchObject({ complete: false, unsaved: false });
    expect(partial.cards.map((c) => c.nonce)).toEqual([2, 2, 2, 2, 2, 0, 0, 0, 0, 0]);
    expect(stored()[me].w).toBe(1);
    recordPack(opened(1, cardsOf(Array(SET.packSize).fill(WEAK)), me));
    expect(syncMyBestCards()).toMatchObject({ complete: true });
    expect(stored()[me].w).toBe(3);
  });
});

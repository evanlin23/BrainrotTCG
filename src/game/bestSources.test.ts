import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { scoreCards } from '../data/cards';
import { cardPoints, derivePack, type PulledCard, type TicketFn } from '../engine';
import type { Stats } from '../types';
import { getBestCards, recordBestCards, resetBestCards } from './bestCards';
import {
  checkBestCard,
  checkBestPack,
  checkBestSources,
  forCurrentPlayer,
  resolveBestCard,
  resolveBestPack,
  type BestCardSource,
  type BestPackSource,
  type BestSources,
} from './bestSources';
import * as history from './history';
import { recordPack as recordProgress } from './packProgress';
import * as packStore from './packStore';
import { getPlayer } from './player';
import { toCardsWithMeta, type OpenedPack } from './pulls';

// Counts every way of walking the pack history or the pack store: the highlights must use none of them.
vi.mock('./history', async (importOriginal) => {
  const real = await importOriginal<typeof import('./history')>();
  return {
    ...real,
    getHistory: vi.fn(real.getHistory),
    historyForKey: vi.fn(real.historyForKey),
    findPackWithCard: vi.fn(real.findPackWithCard),
    findPackByCards: vi.fn(real.findPackByCards),
  };
});
vi.mock('./packStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('./packStore')>();
  return { ...real, readStoredPacks: vi.fn(real.readStoredPacks), hydratePackStore: vi.fn(real.hydratePackStore) };
});

const data = new Map<string, string>();
let refuseWrite: (key: string) => boolean = () => false;
const setItem = vi.fn((k: string, v: string) => {
  if (refuseWrite(k)) throw new DOMException('Full', 'QuotaExceededError');
  data.set(k, v);
});
vi.stubGlobal('localStorage', {
  get length() { return data.size; },
  key: (index: number) => [...data.keys()][index] ?? null,
  getItem: (k: string) => data.get(k) ?? null,
  setItem,
  removeItem: (k: string) => void data.delete(k),
});

const SET = getSet('right-now', 2)!;
const PLAYER_KEY = 'brainrot-player-v1';
const MY_SECRET = '22'.repeat(32);
const OTHER_SECRET = '11'.repeat(32);

/** A cheap stand-in for Argon2id: deterministic per key and nonce. */
const fakeTicket: TicketFn = async (_set, key, nonce) => {
  const ticket = new Uint8Array(32);
  ticket.set(key.subarray(0, 28));
  new DataView(ticket.buffer).setUint32(28, nonce);
  return ticket;
};
const counted = () => {
  const calls: number[] = [];
  const fn: TicketFn = (set, key, nonce) => {
    calls.push(nonce);
    return fakeTicket(set, key, nonce);
  };
  return { fn, calls };
};

const pulledAt = async (nonce: number, key = getPlayer().publicKey): Promise<PulledCard[]> => derivePack(SET, key, nonce, fakeTicket);
const best = (cards: readonly PulledCard[]) => Math.max(...cards.map((c) => cardPoints(c.rarity, c.isHolo, c.finish, c.misprint)));
const packScore = (cards: readonly PulledCard[]) => scoreCards(toCardsWithMeta(cards, SET)).score;

/**
 * Two tickets where A has the higher pack score and B the stronger single card, so the two
 * highlights come from different packs.
 */
const findSplit = async (): Promise<{ a: number; b: number }> => {
  const packs = await Promise.all(Array.from({ length: 200 }, (_, n) => pulledAt(n)));
  for (let a = 0; a < packs.length; a++) {
    for (let b = 0; b < packs.length; b++) {
      if (packScore(packs[a]) > packScore(packs[b]) && best(packs[b]) > best(packs[a])) return { a, b };
    }
  }
  throw new Error('No split found');
};

const opened = async (nonce: number, openedAt = 1000 + nonce): Promise<OpenedPack> => {
  const cards = toCardsWithMeta(await pulledAt(nonce), SET);
  return { setId: SET.id, setVersion: SET.version, nonce, publicKeyHex: getPlayer().publicKeyHex, cards, score: scoreCards(cards), openedAt };
};

const emptyStats = (): Stats => ({ packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] });

/** Opens these tickets as the app records them: history, Best cards, Stats, and the player's count. */
const play = async (...nonces: number[]): Promise<Stats> => {
  let progress = { stats: emptyStats(), collection: {}, hallOfFame: {} };
  for (const n of nonces) {
    const pack = await opened(n);
    history.recordPack(pack);
    recordBestCards(pack);
    progress = recordProgress(progress, pack, {}).progress;
  }
  const record = JSON.parse(data.get(PLAYER_KEY)!);
  data.set(PLAYER_KEY, JSON.stringify({ ...record, nextNonce: Math.max(...nonces) + 1 }));
  return progress.stats;
};

const switchPlayer = () => {
  data.set(PLAYER_KEY, JSON.stringify({ secretKey: OTHER_SECRET, name: 'Other', nextNonce: 0, createdAt: 1 }));
};

const settle = async (stats: Stats, ticketFn: TicketFn = fakeTicket) => {
  const steps: BestSources[] = [];
  const result = await checkBestSources(stats, (s) => steps.push(s), { ticketFn });
  return { steps, result };
};

beforeEach(() => {
  data.clear();
  refuseWrite = () => false;
  resetBestCards();
  packStore.resetPackStore();
  vi.clearAllMocks();
  data.set(PLAYER_KEY, JSON.stringify({ secretKey: MY_SECRET, name: 'Me', nextNonce: 0, createdAt: 1 }));
});

describe('independent sources', () => {
  it('takes the best pack and the best card from different packs, both checked by the engine', async () => {
    const { a, b } = await findSplit();
    const stats = await play(a, b);
    const { steps, result } = await settle(stats);

    expect(steps[0].pack.status).toBe('checking');
    expect(steps[0].card.status).toBe('checking');
    const key = getPlayer().publicKeyHex;
    expect(result.pack).toMatchObject({ status: 'available', source: { ref: { setId: SET.id, setVersion: SET.version, nonce: a, publicKeyHex: key } } });
    expect(result.card).toMatchObject({ status: 'available', source: { ref: { nonce: b, publicKeyHex: key } } });
    if (result.pack.status !== 'available' || result.card.status !== 'available') throw new Error('unreachable');
    expect(result.pack.verified.score.score).toBe(packScore(await pulledAt(a)));
    // The exact instance: its slot, set version and modifiers as the engine pulls them.
    const derived = (await pulledAt(b))[result.card.source.slot];
    expect(result.card.verified.pulled).toEqual(derived);
    expect(result.card.verified.points).toBe(best(await pulledAt(b)));
    expect(result.card.verified.card).toMatchObject({ key: `${SET.id}/${derived.cardId}`, isHolo: derived.isHolo });
  });

  it('keeps the winner tie order of the Best cards list', async () => {
    await play(0, 1, 2);
    const state = resolveBestCard();
    const [top] = getBestCards(getPlayer().publicKeyHex, 3).cards;
    expect(state).toMatchObject({ status: 'checking', source: { ref: { nonce: top.nonce }, slot: top.slot, complete: true } });
  });

  it('a failure in one source leaves the other available', async () => {
    const { a, b } = await findSplit();
    const stats = await play(a, b);
    const failing: TicketFn = (set, key, nonce) => (nonce === a ? Promise.reject(new Error('miner crashed')) : fakeTicket(set, key, nonce));
    const { steps, result } = await settle(stats, failing);
    expect(result.pack).toMatchObject({ status: 'failed', reason: 'error', source: { ref: { nonce: a } } });
    expect(result.card.status).toBe('available');
    // Never blanked: every step shows each source as checking or settled, never missing.
    expect(steps.every((s) => s.pack.status !== 'unavailable' && s.card.status !== 'unavailable')).toBe(true);

    const cardFails: TicketFn = (set, key, nonce) => (nonce === b ? Promise.reject(new Error('miner crashed')) : fakeTicket(set, key, nonce));
    const other = await settle(stats, cardFails);
    expect(other.result.pack.status).toBe('available');
    expect(other.result.card).toMatchObject({ status: 'failed', reason: 'error', source: { ref: { nonce: b } } });
  });
});

describe('states', () => {
  it('is unavailable with nothing recorded, and checks nothing', async () => {
    const { fn, calls } = counted();
    const { result } = await settle(emptyStats(), fn);
    expect(result).toEqual({ pack: { status: 'unavailable', reason: 'none' }, card: { status: 'unavailable', reason: 'none' } });
    expect(calls).toEqual([]);
  });

  it('keeps a failed source for a retry, which can then succeed', async () => {
    const stats = await play(0);
    const pending = resolveBestPack(stats);
    if (pending.status !== 'checking') throw new Error('unreachable');
    const failed = await checkBestPack(pending.source, { ticketFn: () => Promise.reject(new Error('offline')) });
    expect(failed).toMatchObject({ status: 'failed', reason: 'error', source: pending.source });
    if (failed.status !== 'failed') throw new Error('unreachable');
    expect((await checkBestPack(failed.source, { ticketFn: fakeTicket })).status).toBe('available');
  });

  it('fails a best pack whose kept cards the engine does not pull, with no other variant accepted', async () => {
    const stats = await play(0);
    const [first, ...rest] = stats.highestPackCards!;
    const tampered = { ...stats, highestPackCards: [{ ...first, isHolo: !first.isHolo }, ...rest] };
    const state = resolveBestPack(tampered);
    if (state.status !== 'checking') throw new Error('unreachable');
    expect(await checkBestPack(state.source, { ticketFn: fakeTicket })).toMatchObject({ status: 'failed', reason: 'mismatch' });
  });

  it('fails a best card whose cached variant differs from the engine pull (#654), never falling back', async () => {
    await play(0);
    const state = resolveBestCard();
    if (state.status !== 'checking' || !state.source.card) throw new Error('unreachable');
    const kept = state.source.card;
    const wrong: BestCardSource = { ...state.source, card: { ...kept, isHolo: !kept.isHolo } };
    expect(await checkBestCard(wrong, { ticketFn: fakeTicket })).toMatchObject({ status: 'failed', reason: 'mismatch' });
    const wrongSlot: BestCardSource = { ...state.source, slot: SET.packSize };
    expect(await checkBestCard(wrongSlot, { ticketFn: fakeTicket })).toMatchObject({ status: 'failed', reason: 'mismatch' });
  });

  it('fills an unscored winner from the engine', async () => {
    await play(0);
    const state = resolveBestCard();
    if (state.status !== 'checking') throw new Error('unreachable');
    const unscored: BestCardSource = { ...state.source, card: null, points: null };
    const checked = await checkBestCard(unscored, { ticketFn: fakeTicket });
    expect(checked).toMatchObject({ status: 'available', verified: { pulled: state.source.card } });
  });

  it('reports nothing after an abort', async () => {
    const stats = await play(0);
    const controller = new AbortController();
    const steps: BestSources[] = [];
    const ticketFn: TicketFn = async (set, key, nonce) => {
      controller.abort();
      return fakeTicket(set, key, nonce);
    };
    await checkBestSources(stats, (s) => steps.push(s), { ticketFn, signal: controller.signal });
    expect(steps).toHaveLength(1);
    expect(steps[0].pack.status).toBe('checking');
  });
});

describe('player identity', () => {
  it("never takes another key's best pack", async () => {
    const stats = await play(0);
    switchPlayer();
    expect(resolveBestPack(stats)).toEqual({ status: 'unavailable', reason: 'other-player' });
    // Best cards are per key: the new player has none.
    expect(resolveBestCard()).toEqual({ status: 'unavailable', reason: 'none' });
  });

  it('retires a check whose player changed while it ran, so it is never certified', async () => {
    const stats = await play(0);
    const swapping: TicketFn = async (set, key, nonce) => {
      switchPlayer();
      return fakeTicket(set, key, nonce);
    };
    const { result } = await settle(stats, swapping);
    expect(result).toEqual({ pack: { status: 'unavailable', reason: 'player-changed' }, card: { status: 'unavailable', reason: 'player-changed' } });
  });

  it('refuses to check a source for another key, and retires a verified result after a switch', async () => {
    const stats = await play(0);
    const { result } = await settle(stats);
    expect(result.pack.status).toBe('available');
    expect(forCurrentPlayer(result.pack)).toBe(result.pack);
    switchPlayer();
    expect(forCurrentPlayer(result.pack)).toEqual({ status: 'unavailable', reason: 'player-changed' });
    expect(forCurrentPlayer(result.card)).toEqual({ status: 'unavailable', reason: 'player-changed' });
    if (result.pack.status !== 'available') throw new Error('unreachable');
    const { fn, calls } = counted();
    expect(await checkBestPack(result.pack.source, { ticketFn: fn })).toEqual({ status: 'unavailable', reason: 'player-changed' });
    expect(calls).toEqual([]);
  });
});

describe('storage', () => {
  it('writes nothing, and works with storage refusing every write', async () => {
    const { a, b } = await findSplit();
    const stats = await play(a, b);
    const before = new Map(data);
    setItem.mockClear();
    refuseWrite = () => true;
    const { result } = await settle(stats);
    expect(result.pack.status).toBe('available');
    expect(result.card.status).toBe('available');
    expect(setItem).not.toHaveBeenCalled();
    expect(data).toEqual(before);
  });

  it('uses a Best cards list held in memory when storage refused it', async () => {
    refuseWrite = (k) => k === STORAGE_KEYS.BEST_CARDS;
    const stats = await play(0);
    expect(data.has(STORAGE_KEYS.BEST_CARDS)).toBe(false);
    const { result } = await settle(stats);
    expect(result.card.status).toBe('available');
  });

  it('reads an old save: a best pack from before ticket references stays legacy and untouched', async () => {
    const card = toCardsWithMeta(await pulledAt(0), SET);
    const old: Stats = { packsOpened: 3, holoCards: {}, highestPackValue: 40, highestPackCards: card };
    const legacy: Stats = { ...old, highestPackFlexValue: 40, highestPackLegacy: true };
    const copies = JSON.stringify([old, legacy]);
    expect(resolveBestPack(old)).toEqual({ status: 'unavailable', reason: 'legacy' });
    expect(resolveBestPack(legacy)).toEqual({ status: 'unavailable', reason: 'legacy' });
    expect(resolveBestPack({ packsOpened: 0, holoCards: {} })).toEqual({ status: 'unavailable', reason: 'none' });
    expect(JSON.stringify([old, legacy])).toBe(copies);
  });

  it('checks an older reference with no key (or a prefix) as the current player, and one with no cards by its score', async () => {
    const stats = await play(0);
    const { publicKeyHex: _drop, ...keyless } = stats.highestPackRef!;
    for (const ref of [keyless, { ...keyless, publicKeyHex: getPlayer().publicKeyHex.slice(0, 16) }]) {
      const state = resolveBestPack({ ...stats, highestPackRef: ref });
      if (state.status !== 'checking') throw new Error('unreachable');
      expect(state.source.ref.publicKeyHex).toBe(getPlayer().publicKeyHex);
      expect((await checkBestPack(state.source, { ticketFn: fakeTicket })).status).toBe('available');
    }
    const noCards = resolveBestPack({ ...stats, highestPackCards: [] });
    if (noCards.status !== 'checking') throw new Error('unreachable');
    expect((await checkBestPack(noCards.source, { ticketFn: fakeTicket })).status).toBe('available');
    const wrongScore: BestPackSource = { ...noCards.source, score: noCards.source.score + 1 };
    expect(await checkBestPack(wrongScore, { ticketFn: fakeTicket })).toMatchObject({ status: 'failed', reason: 'mismatch' });
  });
});

describe('no full-history rebuild', () => {
  it('derives only the two source packs, never walking the history or the pack store, with unrelated rows missing', async () => {
    const { a, b } = await findSplit();
    const others = Array.from({ length: 40 }, (_, i) => 300 + i);
    const stats = await play(a, b, ...others.filter((n) => n % 3));
    // Unrelated tickets with no mapping, and mapped ones whose cached cards are gone.
    for (const n of others.filter((n) => n % 3 === 0)) history.recordTicket(SET.id, SET.version, n, getPlayer().publicKeyHex, 5000 + n);
    const { fn, calls } = counted();
    vi.clearAllMocks();

    const { result } = await settle(stats, fn);

    expect(result.pack.status).toBe('available');
    expect(result.card.status).toBe('available');
    if (result.pack.status !== 'available' || result.card.status !== 'available') throw new Error('unreachable');
    // One derivation per source, out of 29 recorded packs.
    expect(calls).toHaveLength(2);
    expect(new Set(calls)).toEqual(new Set([result.pack.source.ref.nonce, result.card.source.ref.nonce]));
    expect(history.getHistory).not.toHaveBeenCalled();
    expect(history.historyForKey).not.toHaveBeenCalled();
    expect(history.findPackWithCard).not.toHaveBeenCalled();
    expect(history.findPackByCards).not.toHaveBeenCalled();
    expect(packStore.readStoredPacks).not.toHaveBeenCalled();
    expect(packStore.hydratePackStore).not.toHaveBeenCalled();
  });
});

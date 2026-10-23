import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { computeTicket, derivePack, profileStats, profileStatsTracker, scorePulled, type SetDefinition } from '../engine';
import { encodeCard } from './cardCode';
import { resetPackStore } from './packStore';
import { getPlayer } from './player';
import { myProgress, myStats } from './profiles';
import { resetTicketList } from './myTickets';

// Counts how often the stats are worked out: each build makes one tracker.
vi.mock('../engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../engine')>();
  return { ...real, profileStatsTracker: vi.fn(real.profileStatsTracker) };
});

const data = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
});

const GENESIS = getSet('genesis', 1)!;
const RIGHT_NOW = getSet('right-now', 2)!;
const SECRET = '0c'.repeat(32);

const storePlayer = (nextNonce: number) =>
  data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET, name: 'Tester', nextNonce, createdAt: 0 }));

/** A history entry holding its pack's cards, as opening the pack stores it, and that pack. */
const opened = async (set: SetDefinition, nonce: number) => {
  const player = getPlayer();
  const cards = await derivePack(set, player.publicKey, nonce, computeTicket);
  const score = scorePulled(cards);
  const c = cards.map((x) => encodeCard({ id: x.cardId, holo: x.isHolo, finish: x.finish, misprint: x.misprint })).join(',');
  const entry = { s: set.id, v: set.version, n: nonce, k: player.publicKeyHex.slice(0, 16), c, h: score.hand.name, x: score.score, t: nonce + 1 };
  return { entry, pack: { nonce, set, cards, score } };
};

const builds = () => vi.mocked(profileStatsTracker).mock.calls.length;

beforeEach(() => {
  data.clear();
  resetPackStore();
  resetTicketList();
  storePlayer(0);
});

describe('stats and progress built from the ticket list (#699)', () => {
  it('builds each once per ticket list, shares the same stats object, and builds again when the list changes', async () => {
    const a = await opened(GENESIS, 0);
    const b = await opened(RIGHT_NOW, 1);
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify([a.entry, b.entry]));
    storePlayer(2);

    const start = builds();
    const stats = myStats();
    expect(stats).toEqual(profileStats([a.pack, b.pack]));
    expect(Object.isFrozen(stats)).toBe(true);
    const progress = myProgress();
    expect(progress).toMatchObject({ xp: stats!.xp, level: stats!.level });
    // One build for the stats and one for the progress.
    expect(builds()).toBe(start + 2);
    for (let i = 0; i < 3; i++) {
      expect(myStats()).toBe(stats);
      expect(myProgress()).toEqual(progress);
    }
    // The same save written again is the same list.
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify([a.entry, b.entry]));
    storePlayer(2);
    expect(myStats()).toBe(stats);
    expect(myProgress()).toEqual(progress);
    expect(builds()).toBe(start + 2);

    const c = await opened(RIGHT_NOW, 2);
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify([a.entry, b.entry, c.entry]));
    storePlayer(3);
    const next = myStats();
    expect(next).not.toBe(stats);
    expect(next).toEqual(profileStats([a.pack, b.pack, c.pack]));
    expect(myStats()).toBe(next);
    const nextProgress = myProgress();
    expect(nextProgress).toMatchObject({ xp: next!.xp, gained: next!.xp - stats!.xp });
    expect(myProgress()).toEqual(nextProgress);
    expect(builds()).toBe(start + 4);
  }, 30_000);
});

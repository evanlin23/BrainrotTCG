// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getSet } from '../content/sets';
import { claimsFor, derivePack, encodeProfile, publicKeyFromSecret, scorePulled, signProfile, toHex } from '../engine';
import { __resetReopenCacheForTests as resetReopenCache, REOPEN_CACHE_KEY } from './reopenCache';
import { createTicketPool } from './ticketPool';
import { verifyProfileLive } from './profileVerification';

// Each pool's tickets are answered by hand, so one can land after a later check has taken over.
vi.mock('./ticketPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ticketPool')>()),
  createTicketPool: vi.fn(),
}));

// A plain store, so the only timers are the cache's own (jsdom's queues a storage event per write).
const data = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
});

const SET = getSet('right-now', 2)!;
const secretKey = new Uint8Array(32).fill(5);
const publicKey = publicKeyFromSecret(secretKey);
const ticketBytes = new Uint8Array(32).fill(9);
// One pack whose claims match the ticket the pool hands back, so the check re-opens it.
let text: string;
beforeAll(async () => {
  const cards = await derivePack(SET, publicKey, 0, async () => ticketBytes);
  const { xp, highlights } = claimsFor([{ nonce: 0, set: SET, cards, score: scorePulled(cards) }]);
  const runs = [{ setId: SET.id, setVersion: SET.version, count: 1 }];
  text = encodeProfile(signProfile({ publicKey, name: 'Tester', runs, xp, highlights }, secretKey));
});

/** A pool the check made: answer its pending tickets, and know when it was asked and closed. */
interface Pool { finish: () => void; asked: Promise<void>; closed: Promise<void> }
let pools: Pool[];

/** The cache's page-hide and visibility listeners still attached. */
const listening = new Set<string>();
const track = (target: EventTarget) => {
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
    listening.add(type);
    add(type, listener, options);
  });
  vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
    listening.delete(type);
    remove(type, listener, options);
  });
};

beforeEach(() => {
  data.clear();
  resetReopenCache();
  listening.clear();
  pools = [];
  vi.mocked(createTicketPool).mockImplementation(() => {
    let closed = false;
    const pending: { resolve: (ticket: Uint8Array) => void; reject: (error: Error) => void }[] = [];
    let onAsk!: () => void;
    let onClosed!: () => void;
    pools.push({
      finish: () => pending.splice(0).forEach((job) => job.resolve(ticketBytes)),
      asked: new Promise((resolve) => { onAsk = resolve; }),
      closed: new Promise((resolve) => { onClosed = resolve; }),
    });
    return {
      size: 1,
      ticket: () => closed
        ? Promise.reject(new Error('Ticket pool closed'))
        : new Promise<Uint8Array>((resolve, reject) => {
          pending.push({ resolve, reject });
          onAsk();
        }),
      // Like the real pool: closing rejects every pending ticket, and closing again does nothing.
      close: () => {
        if (closed) return;
        closed = true;
        pending.splice(0).forEach((job) => job.reject(new Error('Ticket pool closed')));
        onClosed();
      },
    };
  });
  vi.useFakeTimers();
});

afterEach(() => {
  resetReopenCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('writes a pack whose ticket lands after a later check took over at once, leaving no timer or listener behind', async () => {
  const first = new AbortController();
  verifyProfileLive(text, () => {}, first.signal);
  await pools[0].asked;
  track(window);
  track(document);
  // The real path to the late write: a later call supersedes this one without aborting it, so its pool
  // stays open (an abort closes the pool, which rejects the pending ticket, as ticketPool's close() does).
  const later = new AbortController();
  verifyProfileLive(text, () => {}, later.signal);

  pools[0].finish();
  await pools[0].closed; // the first check has wound down, after caching the late pack
  later.abort(); // the later viewer goes too
  await pools[1].closed;

  expect(Object.keys(JSON.parse(data.get(REOPEN_CACHE_KEY) ?? '{}') as object)).toEqual([`${SET.id}@${SET.version}|${toHex(publicKey)}|0`]);
  expect(vi.getTimerCount()).toBe(0);
  expect([...listening]).toEqual([]);
});

// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getSet } from '../content/sets';
import { claimsFor, derivePack, encodeProfile, publicKeyFromSecret, scorePulled, signProfile, toHex } from '../engine';
import { __resetReopenCacheForTests as resetReopenCache, REOPEN_CACHE_KEY } from './reopenCache';
import { createTicketPool } from './ticketPool';
import { verifyProfileLive } from './profileVerification';

// The pool's one ticket is answered by hand, so it can land after the viewer has gone.
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

let finish: () => void;
let asked: Promise<void>;
let closedTwice: Promise<void>;

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
  let onAsk!: () => void;
  asked = new Promise((resolve) => { onAsk = resolve; });
  let closes = 0;
  let onClosedTwice!: () => void;
  closedTwice = new Promise((resolve) => { onClosedTwice = resolve; });
  vi.mocked(createTicketPool).mockImplementation(() => ({
    size: 1,
    ticket: () => new Promise<Uint8Array>((resolve) => {
      finish = () => resolve(ticketBytes);
      onAsk();
    }),
    close: () => {
      if (++closes === 2) onClosedTwice();
    },
  }));
  vi.useFakeTimers();
});

afterEach(() => {
  resetReopenCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('writes a pack whose ticket lands after the viewer has gone at once, leaving no timer or listener behind', async () => {
  const stop = new AbortController();
  verifyProfileLive(text, () => {}, stop.signal);
  await asked;
  track(window);
  track(document);
  stop.abort(); // the viewer unmounts, and App flushes what was pending (nothing yet)

  finish();
  await closedTwice; // the check has wound down, after caching the late pack

  expect(Object.keys(JSON.parse(data.get(REOPEN_CACHE_KEY) ?? '{}') as object)).toEqual([`${SET.id}@${SET.version}|${toHex(publicKey)}|0`]);
  expect(vi.getTimerCount()).toBe(0);
  expect([...listening]).toEqual([]);
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { encodeProfile, signProfile, XP_PER_PACK } from '../engine';
import { holdLive, waitingOptional } from './admission';
import { putStoredPacks, resetPackStore, type StoredPack } from './packStore';
import { getPlayer } from './player';
import { reopenMyPacks, reopenStatus, resumeReopening, verifyProfileLive, type ProfileProgress } from './profiles';
import { createTicketPool, TicketMemoryError } from './ticketPool';

// Re-opening as optional work: tickets come from a pool the test answers by hand, and writes to
// disk finish when the test says, so the resume flag can be checked at each step.
vi.mock('./ticketPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ticketPool')>()),
  createTicketPool: vi.fn(),
}));
vi.mock('./packStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./packStore')>()),
  putStoredPacks: vi.fn(),
}));

const data = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
});
vi.stubGlobal('navigator', { hardwareConcurrency: 8 }); // two optional tickets at once

const PENDING = 'brainrot-reopen-pending-v1';
const BACKOFF = 'brainrot-reopen-backoff-v1';
const SET = getSet('right-now', 2)!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const savePlayer = (secretKey: string, count: number) =>
  data.set('brainrot-player-v1', JSON.stringify({ secretKey, name: 'Tester', nextNonce: count, createdAt: 0 }));

/** A player who has used `count` tickets, all in the history without their cards. */
const setUp = (count: number) => {
  data.clear();
  resetPackStore();
  savePlayer('01'.repeat(32), count);
  const key = getPlayer().publicKeyHex.slice(0, 16);
  const history = Array.from({ length: count }, (_, n) => ({ s: SET.id, v: SET.version, n, k: key, h: 'No Matches', x: 0, t: count - n }));
  data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
};

let mining: { nonce: number; finish: () => void }[];
let writes: { packs: StoredPack[]; done: (ok: boolean) => void }[];
let closed: number;

beforeEach(() => {
  setUp(3);
  mining = [];
  writes = [];
  closed = 0;
  vi.mocked(createTicketPool).mockImplementation(() => ({
    size: 1, // two loops
    ticket: (_set, _key, nonce) =>
      new Promise<Uint8Array>((resolve) => void mining.push({ nonce, finish: () => resolve(new Uint8Array(32).fill(nonce)) })),
    close: () => void closed++,
  }));
  vi.mocked(putStoredPacks).mockImplementation((packs) =>
    new Promise<boolean>((resolve) => void writes.push({ packs: [...packs], done: resolve })));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Answer every ticket the run asks for until it has asked for `total`. */
const mineAll = async (total: number) => {
  for (let answered = 0; answered < total;) {
    await vi.waitFor(() => expect(mining.length).toBeGreaterThan(answered));
    mining[answered++].finish();
  }
};

describe('re-opening as optional work', () => {
  it('keeps the resume flag until every re-opened pack is on disk', async () => {
    const run = reopenMyPacks();
    await mineAll(3);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(data.get(PENDING)).toBe(getPlayer().publicKeyHex);
    writes[0].done(true);
    await run;
    expect(writes[0].packs.map((p) => p.nonce).sort()).toEqual([0, 1, 2]);
    expect(data.has(PENDING)).toBe(false);
    expect(closed).toBe(1);
  });

  it('keeps the resume flag when the packs could not be written', async () => {
    const run = reopenMyPacks();
    await mineAll(3);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].done(false);
    await run;
    expect(data.get(PENDING)).toBe(getPlayer().publicKeyHex);
  });

  it('starts no ticket while a pack is being opened', async () => {
    const release = holdLive();
    const run = reopenMyPacks();
    // Both loops have asked for a slot and are held back.
    await vi.waitFor(() => expect(waitingOptional()).toBe(2));
    await flush();
    expect(mining).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(mining).toHaveLength(2));
    await mineAll(3);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].done(true);
    await run;
    expect(data.has(PENDING)).toBe(false);
  });

  it('stops before the next ticket when the save switches to another player', async () => {
    const before = getPlayer().publicKeyHex;
    const run = reopenMyPacks();
    run.catch(() => undefined);
    await vi.waitFor(() => expect(mining).toHaveLength(2));
    savePlayer('02'.repeat(32), 0);
    expect(getPlayer().publicKeyHex).not.toBe(before);
    mining[0].finish();
    mining[1].finish();
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].done(true);
    await expect(run).rejects.toThrow('Your save changed while your packs were being re-opened');
    // The third ticket was never mined, and only the first player's packs were kept, as theirs.
    expect(mining).toHaveLength(2);
    expect(writes[0].packs.length).toBeGreaterThan(0);
    expect(writes[0].packs.every((p) => p.publicKeyHex === before)).toBe(true);
    expect(closed).toBe(1);
    // Unfinished, so the flag stays with the first player; the new one's next visit clears it.
    expect(data.get(PENDING)).toBe(before);
    resumeReopening();
    expect(data.has(PENDING)).toBe(false);
  });
});

describe('re-opening after packs could not be saved', () => {
  const NOW = Date.UTC(2026, 9, 16);
  const MINUTE = 60_000;
  const backoff = () => JSON.parse(data.get(BACKOFF)!) as { publicKeyHex: string; failures: number; retryAt: number };
  const reopenKeys = () => [...data.keys()].filter((k) => k.startsWith('brainrot-reopen')).sort();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  /**
   * One run (asked for or resumed) that mines all three packs and can't write them. Returns when it
   * failed: vi.waitFor moves the fake clock along while it polls.
   */
  const failedRun = async (run: () => Promise<void> | undefined): Promise<number> => {
    mining = [];
    writes = [];
    const done = run();
    expect(done).toBeDefined();
    await mineAll(3);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].packs.map((p) => p.nonce).sort()).toEqual([0, 1, 2]);
    writes[0].done(false);
    await done;
    expect(reopenStatus()?.running).toBe(false);
    return Date.now();
  };

  it('waits longer after each failed save before resuming on its own, up to a day', async () => {
    const me = getPlayer().publicKeyHex;
    const first = await failedRun(reopenMyPacks);
    expect(backoff()).toEqual({ publicKeyHex: me, failures: 1, retryAt: first + 5 * MINUTE });

    // Too soon: nothing starts, so there's no ticket to mine on every visit.
    vi.setSystemTime(first + 5 * MINUTE - 1);
    mining = [];
    expect(resumeReopening()).toBeUndefined();
    expect(mining).toHaveLength(0);

    vi.setSystemTime(first + 5 * MINUTE);
    const second = await failedRun(resumeReopening);
    expect(backoff()).toEqual({ publicKeyHex: me, failures: 2, retryAt: second + 10 * MINUTE });

    // However many failures, the wait stops growing at a day.
    data.set(BACKOFF, JSON.stringify({ publicKeyHex: me, failures: 16, retryAt: second }));
    const last = await failedRun(resumeReopening);
    expect(backoff()).toEqual({ publicKeyHex: me, failures: 16, retryAt: last + 24 * 60 * MINUTE });

    // One flag and one wait, each overwritten in place.
    expect(reopenKeys()).toEqual([BACKOFF, PENDING]);
    expect(data.get(PENDING)).toBe(me);
  });

  it('never waits longer than a day, even for a wait stored while the clock was ahead', async () => {
    const me = getPlayer().publicKeyHex;
    data.set(PENDING, me);
    data.set(BACKOFF, JSON.stringify({ publicKeyHex: me, failures: 3, retryAt: NOW + 24 * 60 * MINUTE + 1 }));
    const at = await failedRun(resumeReopening);
    expect(backoff()).toEqual({ publicKeyHex: me, failures: 4, retryAt: at + 40 * MINUTE });

    // A wait within a day is kept as stored.
    vi.setSystemTime(at + 40 * MINUTE - 1);
    mining = [];
    expect(resumeReopening()).toBeUndefined();
    expect(mining).toHaveLength(0);
  });

  it('asking re-opens at once, and saving every pack ends the wait', async () => {
    const me = getPlayer().publicKeyHex;
    data.set(PENDING, me);
    data.set(BACKOFF, JSON.stringify({ publicKeyHex: me, failures: 3, retryAt: NOW + MINUTE }));
    expect(resumeReopening()).toBeUndefined();

    const run = reopenMyPacks();
    await mineAll(3);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writes[0].done(true);
    await run;
    expect(reopenKeys()).toEqual([]);
  });

  it("ignores another player's wait", async () => {
    data.set(PENDING, getPlayer().publicKeyHex);
    data.set(BACKOFF, JSON.stringify({ publicKeyHex: '02'.repeat(32), failures: 3, retryAt: NOW + MINUTE }));
    await failedRun(resumeReopening);
    expect(backoff().failures).toBe(1);
  });

  it('stops resuming on its own when the wait itself cannot be stored', async () => {
    const setItem = localStorage.setItem;
    vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
      if (k === BACKOFF) throw new DOMException('Storage full', 'QuotaExceededError');
      setItem(k, v);
    });
    await failedRun(reopenMyPacks);
    expect(reopenKeys()).toEqual([]);
    expect(resumeReopening()).toBeUndefined();
    vi.mocked(localStorage.setItem).mockRestore();
  });
});

describe('verifying a profile on a device that runs out of memory', () => {
  /** A one-pack profile signed by the test player. */
  const proof = () => {
    const { publicKey, secretKey, name } = getPlayer();
    const runs = [{ setId: SET.id, setVersion: SET.version, count: 1 }];
    return encodeProfile(signProfile({ publicKey, name, runs, xp: XP_PER_PACK, highlights: [0] }, secretKey));
  };

  const failWith = async (error: Error) => {
    vi.mocked(createTicketPool).mockImplementation(() => ({ size: 1, ticket: () => Promise.reject(error), close: () => {} }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reports: ProfileProgress[] = [];
    verifyProfileLive(proof(), (p) => reports.push(p), new AbortController().signal);
    await vi.waitFor(() => expect(reports[reports.length - 1]?.error).toBeDefined());
    expect(logged).toHaveBeenCalledWith('Profile verification failed', error);
    logged.mockRestore();
    return reports[reports.length - 1].error!;
  };

  it('says what to do instead of showing the browser\'s error', async () => {
    const raw = 'RangeError: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance';
    const error = await failWith(new TicketMemoryError(raw));
    expect(error).toEqual({ message: 'This device ran out of memory while checking. Close other tabs and try again.' });
    expect(error.message).not.toContain('WebAssembly');
  });

  it('keeps other failures generic and never calls them fake', async () => {
    const error = await failWith(new Error('Invalid hex string'));
    expect(error.rule).toBeUndefined();
    expect(error.message).toBe('Something went wrong while re-opening the packs. Try again.');
  });
});

describe('verifying a profile again', () => {
  /** A one-pack profile from a player of its own, so no earlier test has re-opened its pack. */
  const proof = (seed: string) => {
    savePlayer(seed.repeat(32), 1);
    const { publicKey, secretKey, name } = getPlayer();
    const runs = [{ setId: SET.id, setVersion: SET.version, count: 1 }];
    return encodeProfile(signProfile({ publicKey, name, runs, xp: XP_PER_PACK, highlights: [0] }, secretKey));
  };

  it('lets only the latest check report once a later one starts', async () => {
    const text = proof('a1');
    const first: ProfileProgress[] = [];
    const second: ProfileProgress[] = [];
    verifyProfileLive(text, (p) => first.push(p), new AbortController().signal);
    await vi.waitFor(() => expect(mining).toHaveLength(1));
    verifyProfileLive(text, (p) => second.push(p), new AbortController().signal);
    await vi.waitFor(() => expect(mining).toHaveLength(2));
    // The first check's pack finishes after the second check started: it must not show.
    mining[0].finish();
    await vi.waitFor(() => expect(closed).toBe(1));
    expect(first).toHaveLength(1);
    expect(first[0].packs).toHaveLength(0);
    mining[1].finish();
    // The second check carries on to its verdict (the stand-in tickets don't match the claims).
    await vi.waitFor(() => expect(second[second.length - 1].error ?? second[second.length - 1].done).toBeTruthy());
    expect(second.some((p) => p.packs.length === 1)).toBe(true);
    expect(first).toHaveLength(1);
  });

  it('reports nothing once its page has stopped it', async () => {
    const reports: ProfileProgress[] = [];
    const stop = new AbortController();
    verifyProfileLive(proof('b2'), (p) => reports.push(p), stop.signal);
    await vi.waitFor(() => expect(mining).toHaveLength(1));
    stop.abort();
    mining[0].finish();
    await flush();
    await flush();
    expect(reports).toHaveLength(1);
    expect(reports[0].done).toBe(false);
  });
});

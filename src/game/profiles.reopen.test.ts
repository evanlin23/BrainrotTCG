import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { holdLive, waitingOptional } from './admission';
import { putStoredPacks, resetPackStore, type StoredPack } from './packStore';
import { getPlayer } from './player';
import { reopenMyPacks, reopenStatus, resumeReopening } from './reopenJob';
import { createTicketPool } from './ticketPool';

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

describe('resuming while a run is going', () => {
  it.each([
    ['once it mines', true],
    ['while saved packs are still being read first', false],
  ])('joins the run already going %s instead of starting a second one (#699)', async (_when, mined) => {
    // A run left unfinished on an earlier visit.
    data.set(PENDING, getPlayer().publicKeyHex);
    const run = reopenMyPacks();
    if (mined) await vi.waitFor(() => expect(mining).toHaveLength(2));
    let resumedDone = false;
    const resumed = resumeReopening();
    expect(resumed).toBeDefined();
    void resumed!.then(() => { resumedDone = true; });
    await mineAll(3);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    // The resumed call waits for the run it joined: it hasn't settled while that run's packs are still being written.
    await flush();
    expect(resumedDone).toBe(false);
    writes[0].done(true);
    await Promise.all([run, resumed]);
    expect(resumedDone).toBe(true);
    // One pool, three tickets: nothing was mined twice.
    expect(mining.map((m) => m.nonce).sort()).toEqual([0, 1, 2]);
    expect(closed).toBe(1);
    expect(writes).toHaveLength(1);
    expect(reopenStatus()).toMatchObject({ done: 3, total: 3, running: false });
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

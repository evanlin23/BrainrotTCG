import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { holdLive } from './admission';
import { putStoredPacks, resetPackStore, type StoredPack } from './packStore';
import { getPlayer } from './player';
import { reopenMyPacks, resumeReopening } from './profiles';
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
    await vi.waitFor(() => expect(createTicketPool).toHaveBeenCalled());
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

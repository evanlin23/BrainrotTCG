import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSet } from '../content/sets';
import { claimsFor, derivePack, encodeProfile, publicKeyFromSecret, scorePulled, signProfile, toHex, XP_PER_PACK, type ProfilePack, type SetDefinition } from '../engine';
import { __resetReopenCacheForTests, getReopened, putReopened } from './reopenCache';
import { createTicketPool, TicketMemoryError } from './ticketPool';
import { verifyProfileLive, type ProfileProgress } from './profileVerification';
import verifierSource from './profileVerification.ts?raw';

// Tickets come from a pool the test answers: by hand (`mining`), or at once with stand-in bytes.
vi.mock('./ticketPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ticketPool')>()),
  createTicketPool: vi.fn(),
}));

const data = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
});
vi.stubGlobal('navigator', { hardwareConcurrency: 8 }); // two optional tickets at once

const SET = getSet('right-now', 2)!;
const OLD_SET = getSet('right-now', 1)!;

/** A stand-in ticket: the same bytes for a nonce every time, so a test can work out the packs it gives. */
const standIn = async (_set: string, _key: Uint8Array, nonce: number) => new Uint8Array(32).fill(nonce + 7);

const keysFor = (seed: number) => {
  const secretKey = new Uint8Array(32).fill(seed);
  return { secretKey, publicKey: publicKeyFromSecret(secretKey) };
};

/** The packs the stand-in tickets give this player in these sets, in ticket order. */
const standInPacks = (publicKey: Uint8Array, sets: readonly SetDefinition[]): Promise<ProfilePack[]> =>
  Promise.all(sets.map(async (set, nonce) => {
    const cards = await derivePack(set, publicKey, nonce, standIn);
    return { nonce, set, cards, score: scorePulled(cards) };
  }));

/** A profile of `count` packs in `set` whose claims match the stand-in tickets, unless `xp` says otherwise. */
const honestProfile = async (seed: number, set: SetDefinition, count: number, xp?: (real: number) => number) => {
  const { secretKey, publicKey } = keysFor(seed);
  const packs = await standInPacks(publicKey, Array.from({ length: count }, () => set));
  const claims = claimsFor(packs);
  const runs = [{ setId: set.id, setVersion: set.version, count }];
  const text = encodeProfile(signProfile({ publicKey, name: 'Tester', runs, xp: xp ? xp(claims.xp) : claims.xp, highlights: claims.highlights }, secretKey));
  return { text, packs, keyHex: toHex(publicKey) };
};

/** Run a check and resolve with its last report, once it says done or failed. */
const verdict = (text: string, signal = new AbortController().signal, options?: import('./profileVerification').VerifyProfileOptions) =>
  new Promise<{ last: ProfileProgress; reports: ProfileProgress[] }>((resolve) => {
    const reports: ProfileProgress[] = [];
    verifyProfileLive(text, (p) => {
      reports.push(p);
      if (p.done || p.error || (options?.highlightsOnly && p.highlightsDone)) resolve({ last: p, reports });
    }, signal, options);
  });

let mining: { nonce: number; finish: () => void }[];
let onAsk: (() => void) | null;
let closed: number;
let onClose: (() => void) | null;
const closePool = () => {
  closed++;
  onClose?.();
};
let pools: number;

beforeEach(() => {
  data.clear();
  __resetReopenCacheForTests();
  mining = [];
  onAsk = null;
  closed = 0;
  onClose = null;
  pools = 0;
  vi.mocked(createTicketPool).mockImplementation(() => {
    pools++;
    // As the real pool does: closing rejects every ticket still pending, and any asked for afterwards, so
    // none is answered once the pool is closed. (The call is counted each time, as the real close is idempotent.)
    const pending = new Set<(error: Error) => void>();
    const stopped = new Error('Ticket pool closed');
    let shut = false;
    return {
      size: 1,
      ticket: (_set, _key, nonce) =>
        new Promise<Uint8Array>((resolve, reject) => {
          if (shut) return reject(stopped);
          pending.add(reject);
          mining.push({ nonce, finish: () => (pending.delete(reject), resolve(new Uint8Array(32).fill(nonce))) });
          onAsk?.();
        }),
      close: () => {
        shut = true;
        for (const reject of pending) reject(stopped);
        pending.clear();
        closePool();
      },
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Resolves once the pool has been asked for `count` tickets in all. */
const asked = (count: number) =>
  new Promise<void>((resolve) => {
    const check = () => (mining.length >= count ? resolve() : void (onAsk = check));
    check();
  });

/** Resolves once the pool has been closed `count` times in all. */
const closedTimes = (count: number) =>
  new Promise<void>((resolve) => {
    const check = () => (closed >= count ? resolve() : void (onClose = check));
    check();
  });

/** Answer every ticket at once with the stand-in bytes. */
const standInPool = () =>
  vi.mocked(createTicketPool).mockImplementation(() => {
    pools++;
    return { size: 1, ticket: standIn, close: closePool };
  });

describe('verifying a shared profile', () => {
  it('re-opens every pack, best ones first, says done when the claims match, and closes its workers', async () => {
    standInPool();
    const { text, packs, keyHex } = await honestProfile(3, SET, 4);
    const { last, reports } = await verdict(text);
    expect(last.done).toBe(true);
    expect(last.error).toBeUndefined();
    expect(last.packs.map((p) => p.cards)).toEqual(packs.map((p) => p.cards));
    expect(last.highlights?.map((p) => p.nonce)).toEqual(last.checked.profile.highlights);
    // The first report comes before any pack is in: who and how many show at once.
    expect(reports[0].packs).toEqual([]);
    await closedTimes(1);
    // Every re-opened pack is cached for the next look.
    for (const p of packs) expect(getReopened(SET, keyHex, p.nonce)).toEqual(p.cards);
  });

  it('marks a profile whose claims are made up as fake (rule "claims") and never done', async () => {
    standInPool();
    const { text } = await honestProfile(4, SET, 2, (xp) => xp + XP_PER_PACK);
    const { last, reports } = await verdict(text);
    expect(last.error?.rule).toBe('claims');
    expect(reports.some((p) => p.done)).toBe(false);
  });

  it('throws a bad profile before re-opening anything', () => {
    expect(() => verifyProfileLive('not a profile', () => {}, new AbortController().signal)).toThrow();
    expect(pools).toBe(0);
  });

  it("reads packs re-opened before from the cache under the profile's own set version", async () => {
    const { text, packs, keyHex } = await honestProfile(5, OLD_SET, 2);
    for (const p of packs) putReopened(OLD_SET, keyHex, p.nonce, p.cards);
    const { last } = await verdict(text);
    expect(last.done).toBe(true);
    expect(pools).toBe(0); // nothing re-opened, so no workers started
  });

  it("doesn't take a pack cached under another version of the set", async () => {
    const { text, packs, keyHex } = await honestProfile(6, OLD_SET, 1);
    putReopened(SET, keyHex, 0, packs[0].cards);
    const reports: ProfileProgress[] = [];
    verifyProfileLive(text, (p) => reports.push(p), new AbortController().signal);
    await asked(1);
    expect(mining.map((m) => m.nonce)).toEqual([0]);
    mining[0].finish();
    await closedTimes(1);
  });

  it('carries on from the packs a stopped check cached', async () => {
    const { text, packs, keyHex } = await honestProfile(8, SET, 3);
    putReopened(SET, keyHex, packs[1].nonce, packs[1].cards);
    const asked: number[] = [];
    vi.mocked(createTicketPool).mockImplementation(() => ({
      size: 1,
      ticket: (set, key, nonce) => (asked.push(nonce), standIn(set, key, nonce)),
      close: closePool,
    }));
    const { last } = await verdict(text);
    expect(last.done).toBe(true);
    expect(asked.sort()).toEqual([0, 2]);
  });

  it('closes its workers when its page stops it', async () => {
    const { text } = await honestProfile(9, SET, 1);
    const stop = new AbortController();
    verifyProfileLive(text, () => {}, stop.signal);
    await asked(1);
    expect(closed).toBe(0);
    stop.abort();
    expect(closed).toBe(1);
    // The pool rejected its pending ticket, which frees the optional-work slot and ends the check, which closes again.
    await closedTimes(2);
  });

  it('with highlightsOnly, re-opens only the best packs, marks highlightsDone, and closes workers without re-opening the rest', async () => {
    standInPool();
    const { text, keyHex } = await honestProfile(11, SET, 8);
    const { last } = await verdict(text, new AbortController().signal, { highlightsOnly: true });
    expect(last.highlightsDone).toBe(true);
    expect(last.done).toBe(false);
    expect(last.error).toBeUndefined();
    expect(last.highlights).not.toBeNull();
    expect(last.highlights?.length).toBe(last.checked.profile.highlights.length);
    expect(last.packs.length).toBe(last.checked.profile.highlights.length);
    await closedTimes(1);
    for (const p of last.highlights!) {
      expect(getReopened(SET, keyHex, p.nonce)).toEqual(p.cards);
    }
  });

  it('a full check after a highlights-only one reuses the re-opened best packs and opens only the rest', async () => {
    const opened: number[] = [];
    vi.mocked(createTicketPool).mockImplementation(() => ({
      size: 1,
      ticket: (set, key, nonce) => (opened.push(nonce), standIn(set, key, nonce)),
      close: closePool,
    }));
    const { text, packs } = await honestProfile(14, SET, 8);
    const first = await verdict(text, new AbortController().signal, { highlightsOnly: true });
    const best = first.last.checked.profile.highlights;
    expect(first.last.done).toBe(false);
    expect([...opened].sort((x, y) => x - y)).toEqual([...best].sort((x, y) => x - y));

    opened.length = 0;
    const { last } = await verdict(text, new AbortController().signal, { highlightsOnly: false });
    expect(last.done).toBe(true);
    expect(last.packs.map((p) => p.cards)).toEqual(packs.map((p) => p.cards));
    const rest = Array.from({ length: 8 }, (_, n) => n).filter((n) => !best.includes(n));
    expect([...opened].sort((x, y) => x - y)).toEqual(rest);
  });

  it('with highlightsOnly on a profile where all packs are highlights, verifies all and marks done', async () => {
    standInPool();
    const { text } = await honestProfile(12, SET, 3);
    const { last } = await verdict(text, new AbortController().signal, { highlightsOnly: true });
    expect(last.done).toBe(true);
    expect(last.highlightsDone).toBe(true);
    expect(last.packs.length).toBe(3);
  });

  it('with highlightsOnly, marks a profile with forged out-of-order highlights as fake', async () => {
    standInPool();
    const { secretKey, publicKey } = keysFor(13);
    const packs = await standInPacks(publicKey, Array.from({ length: 6 }, () => SET));
    const claims = claimsFor(packs);
    const reversedHighlights = [...claims.highlights].reverse();
    const runs = [{ setId: SET.id, setVersion: SET.version, count: 6 }];
    const text = encodeProfile(signProfile({ publicKey, name: 'Tester', runs, xp: claims.xp, highlights: reversedHighlights }, secretKey));
    const { last } = await verdict(text, new AbortController().signal, { highlightsOnly: true });
    expect(last.error?.rule).toBe('claims');
    expect(last.done).toBe(false);
  });
});

describe('verifying a profile on a device that runs out of memory', () => {
  const failWith = async (error: Error) => {
    vi.mocked(createTicketPool).mockImplementation(() => ({ size: 1, ticket: () => Promise.reject(error), close: () => {} }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { text } = await honestProfile(10, SET, 1);
    const { last } = await verdict(text);
    expect(logged).toHaveBeenCalledWith('Profile verification failed', error);
    logged.mockRestore();
    return last.error!;
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
  const proof = (seed: number) => {
    const { secretKey, publicKey } = keysFor(seed);
    const runs = [{ setId: SET.id, setVersion: SET.version, count: 1 }];
    return encodeProfile(signProfile({ publicKey, name: 'Tester', runs, xp: XP_PER_PACK, highlights: [0] }, secretKey));
  };

  it('lets only the latest check report once a later one starts', async () => {
    const text = proof(0xa1);
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
    verifyProfileLive(proof(0xb2), (p) => reports.push(p), stop.signal);
    await vi.waitFor(() => expect(mining).toHaveLength(1));
    stop.abort();
    // The pool rejected its pending ticket and the check ended (it closes the pool once more as it does): nothing more is reported.
    await closedTimes(2);
    expect(reports).toHaveLength(1);
    expect(reports[0].done).toBe(false);
  });
});

describe('the shared-profile verifier boundary (#698)', () => {
  it("imports none of your own player's profile, save, history or pack store", () => {
    const targets = [...verifierSource.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(targets.sort()).toEqual(['../content/sets', '../engine', './admission', './reopenCache', './ticketPool']);
  });

  it('is what profiles.ts re-exports, so older imports keep working', async () => {
    const profiles = await import('./profiles');
    expect(profiles.verifyProfileLive).toBe(verifyProfileLive);
  });
});

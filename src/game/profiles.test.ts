import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { checkProfile, computeTicket, derivePack, scorePulled, toHex } from '../engine';
import { decodeCard, encodeCard, toPulled } from './cardCode';
import { getStoredPack, putStoredPacks, resetPackStore } from './packStore';
import { getHistory, recordPack } from './history';
import type { OpenedPack } from './pulls';
import { getPlayer } from './player';
import { hydrateMyPacks, myProfileInfo, myProfileProof, myProgress, myStats, myTickets, onReopenProgress, profileUrl, reopenMyPacks, resetTicketList, resumeReopening, syncMyBestCards } from './profiles';

// No Worker or IndexedDB here: tickets are mined on this thread and the pack store stays in memory.
const data = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
});

const SECRET = '01'.repeat(32);
const PENDING = 'brainrot-reopen-pending-v1';
const SET = getSet('right-now', 2)!;

/** A player who has used `count` tickets, all in the history without their cards (as after a big import). */
const setUp = (count: number) => {
  data.clear();
  resetPackStore();
  data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET, name: 'Tester', nextNonce: count, createdAt: 0 }));
  const key = getPlayer().publicKeyHex.slice(0, 16);
  const history = Array.from({ length: count }, (_, n) => ({ s: SET.id, v: SET.version, n, k: key, h: 'No Matches', x: 0, t: count - n }));
  data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
};

const codeOf = async (nonce: number) =>
  (await derivePack(SET, getPlayer().publicKey, nonce, computeTicket))
    .map((c) => encodeCard({ id: c.cardId, holo: c.isHolo, finish: c.finish, misprint: c.misprint }))
    .join(',');

describe('re-opening your packs', () => {
  beforeEach(() => setUp(3));

  it('counts packs the store has as known', async () => {
    expect(myProfileInfo()).toMatchObject({ packs: 3, missing: 3 });
    const player = getPlayer();
    await putStoredPacks([{ setKey: 'right-now@2', publicKeyHex: player.publicKeyHex, nonce: 1, cards: await codeOf(1) }]);
    expect(myProfileInfo()).toMatchObject({ packs: 3, missing: 2 });
  });

  it('re-opens every missing pack, keeps them, reports progress and clears the resume flag', async () => {
    const seen: number[] = [];
    const stop = onReopenProgress((s) => seen.push(s.done));
    await reopenMyPacks();
    stop();
    const player = getPlayer();
    for (const n of [0, 1, 2]) expect(getStoredPack('right-now@2', player.publicKeyHex, n)).toBe(await codeOf(n));
    expect(myProfileInfo()).toMatchObject({ missing: 0 });
    expect(seen[seen.length - 1]).toBe(3);
    expect(data.has(PENDING)).toBe(false);
    // The history shows them too, though its own record still has no cards.
    expect(getHistory().every((e) => e.cards?.length === 5)).toBe(true);
    expect(data.get(STORAGE_KEYS.HISTORY)).not.toContain('"c"');
  }, 30_000);

  it('signs a profile that verifies, from re-opened packs', async () => {
    const proof = await myProfileProof();
    const checked = checkProfile(proof!, getSet);
    expect(toHex(checked.profile.publicKey)).toBe(getPlayer().publicKeyHex);
    expect(checked.tickets).toHaveLength(3);
  }, 30_000);

  it("resumes an unfinished run on load, but only for the player who started it", async () => {
    data.set(PENDING, 'ff'.repeat(32));
    resumeReopening();
    expect(data.has(PENDING)).toBe(false);
    expect(myProfileInfo()).toMatchObject({ missing: 3 });

    data.set(PENDING, getPlayer().publicKeyHex);
    resumeReopening();
    await reopenMyPacks(); // joins the resumed run
    expect(myProfileInfo()).toMatchObject({ missing: 0 });
  }, 30_000);
});


describe('original ticket provenance admission', () => {
  beforeEach(() => setUp(3));

  it.each(['missing', 'unknown set', 'unknown version', 'legacy no history'])('refuses to guess an original mapping: %s', async (kind) => {
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
    if (kind === 'missing') history.splice(1, 1);
    if (kind === 'unknown set') history[1].s = 'unavailable-historical-set';
    if (kind === 'unknown version') history[1].v = 999;
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(kind === 'legacy no history' ? [] : history));
    const original = data.get(STORAGE_KEYS.HISTORY);
    const filled = kind === 'legacy no history' ? 3 : 1;
    expect(myProfileInfo()?.filled).toBe(filled);
    await expect(myProfileProof()).rejects.toThrow('original pack set/version mappings');

    // The mapped tickets still re-open (once, on the next load), and the unmapped one isn't guessed or logged.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    data.set(PENDING, getPlayer().publicKeyHex);
    resumeReopening();
    await reopenMyPacks(); // joins the resumed run
    resumeReopening();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect(myProfileInfo()).toEqual({ packs: 3, filled, missing: filled, cache: 'ready' });
    expect(myStats()?.packs).toBe(3 - filled);
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(original);
    expect(data.has(PENDING)).toBe(false);
    await expect(myProfileProof()).rejects.toThrow('original pack set/version mappings');
  }, 30_000);

  it.each([
    ['a fractional nonce', 1, 0.5],
    ['a string nonce', 1, '1'],
    ['a string twin of a recorded nonce', 2, '1'],
  ])('does not let %s stand in for a ticket', async (_kind, index, nonce) => {
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
    history[index].n = nonce;
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    expect(myTickets().map((t) => t.nonce)).toEqual(index === 1 ? [0, 2] : [0, 1]);
    expect(myProfileInfo()?.filled).toBe(1);
    await expect(myProfileProof()).rejects.toThrow('original pack set/version mappings');
  });

  it('does not count a cached guessed pack as recovered original provenance', async () => {
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
    history.splice(1, 1);
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    await putStoredPacks([{ setKey: 'right-now@2', publicKeyHex: getPlayer().publicKeyHex, nonce: 1, cards: await codeOf(1) }]);
    expect(myProfileInfo()?.filled).toBe(1);
    expect(await hydrateMyPacks()).toBe('ready');
    expect(myStats()?.packs).toBe(0);
    await expect(myProfileProof()).rejects.toThrow('original pack set/version mappings');
  });

  it('keeps exact mixed-set/version run provenance in a newly signed profile', async () => {
    setUp(2);
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
    history[0].s = 'genesis';
    history[0].v = 1;
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    const proof = await myProfileProof();
    const checked = checkProfile(proof!, getSet);
    expect(checked.tickets.map((set) => [set.id, set.version])).toEqual([['genesis', 1], ['right-now', 2]]);
    expect(myProfileInfo()?.filled).toBe(0);
  }, 30_000);

  /** Ticket 1 recorded a second time with another set (two tabs spent it at once), stored before or after the first. */
  const conflict = (where: 'before' | 'after', record: Record<string, unknown>) => {
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
    const other = { ...history[1], ...record };
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(where === 'before' ? [other, ...history] : [...history, other]));
  };

  it.each(['before', 'after'] as const)('admits the first-opened of two sets recorded on one ticket, stored %s it', async (where) => {
    setUp(2);
    conflict(where, { s: 'genesis', v: 1, t: 50 });
    const checked = checkProfile((await myProfileProof())!, getSet);
    expect(checked.tickets.map((set) => [set.id, set.version])).toEqual([['right-now', 2], ['right-now', 2]]);
    expect(getHistory().filter((e) => e.nonce === 1)).toHaveLength(2);
  }, 30_000);

  it.each(['before', 'after'] as const)('breaks a tie in opening time by set, stored %s it', (where) => {
    conflict(where, { s: 'a-unavailable-set' });
    // 'a-unavailable-set' sorts before 'right-now', so it is admitted, and it can't be proved.
    expect(myProfileInfo()).toMatchObject({ packs: 3, filled: 1 });
  });
});

describe('profile links while other tabs write', () => {
  beforeEach(() => setUp(3));
  const storePlayer = (secretKey: string, nextNonce: number) =>
    data.set('brainrot-player-v1', JSON.stringify({ secretKey, name: 'Tester', nextNonce, createdAt: 0 }));

  it('proves the tickets used when it was asked for while another tab spends the next one', async () => {
    let spent = false;
    const proof = await myProfileProof(() => {
      if (spent) return;
      spent = true;
      storePlayer(SECRET, 4); // Another tab allocated ticket 3 and is still mining it: nothing recorded yet.
    });
    expect(spent).toBe(true);
    const checked = checkProfile(proof!, getSet);
    expect(toHex(checked.profile.publicKey)).toBe(getPlayer().publicKeyHex);
    expect(checked.tickets).toHaveLength(3);
    expect(myProfileInfo()).toMatchObject({ packs: 4, filled: 1 });
  }, 30_000);

  it('re-opens tickets recorded after a run it joined had started', async () => {
    const running = reopenMyPacks();
    storePlayer(SECRET, 5);
    const key = getPlayer().publicKeyHex.slice(0, 16);
    const newer = [4, 3].map((n) => ({ s: SET.id, v: SET.version, n, k: key, h: 'No Matches', x: 0, t: 10 + n }));
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify([...newer, ...JSON.parse(data.get(STORAGE_KEYS.HISTORY)!)]));
    const checked = checkProfile((await myProfileProof())!, getSet);
    expect(checked.tickets).toHaveLength(5);
    await running;
  }, 30_000);

  it('refuses to sign when another player is in storage by the time the packs are ready', async () => {
    let swapped = false;
    await expect(myProfileProof(() => {
      if (swapped) return;
      swapped = true;
      storePlayer('02'.repeat(32), 0); // Another tab imported a different player's save.
    })).rejects.toThrow('Your save changed');
    expect(swapped).toBe(true);
  }, 30_000);
});


it('keeps mixed-set mappings and refuses whole-profile signing after severe quota rejects a new ticket', async () => {
  setUp(3);
  const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
  history[0].s = 'genesis';
  history[0].v = 1;
  const original = JSON.stringify(history);
  data.set(STORAGE_KEYS.HISTORY, original);
  data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET, name: 'Tester', nextNonce: 4, createdAt: 0 }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, raw: string) => {
      if (key === STORAGE_KEYS.HISTORY && raw.length > original.length) throw new DOMException('full', 'QuotaExceededError');
      data.set(key, raw);
    },
    removeItem: (key: string) => data.delete(key),
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(recordPack({ setId: 'genesis', setVersion: 1, nonce: 3, publicKeyHex: getPlayer().publicKeyHex,
    cards: [], score: { hand: { name: 'No Matches' }, score: 0 }, openedAt: 4 } as unknown as OpenedPack)).toBe(false);
  expect(data.get(STORAGE_KEYS.HISTORY)).toBe(original);
  expect(myProfileInfo()).toMatchObject({ packs: 4, filled: 1 });
  await expect(myProfileProof()).rejects.toThrow('original pack set/version mappings');
  expect(data.get(STORAGE_KEYS.HISTORY)).toBe(original);
  error.mockRestore();
});

it('links a profile under the site address, with or without a base path', () => {
  // Only this test needs a window; the localStorage stub above stays for the rest of the file.
  const g = globalThis as { window?: unknown };
  const before = g.window;
  g.window = { location: { origin: 'https://example.github.io' } };
  try {
    for (const [base, url] of [
      ['/BrainrotTCG/', 'https://example.github.io/BrainrotTCG/#/profile/abc'],
      ['/', 'https://example.github.io/#/profile/abc'],
    ]) {
      vi.stubEnv('BASE_URL', base);
      expect(profileUrl('abc')).toBe(url);
    }
  } finally {
    vi.unstubAllEnvs();
    if (before === undefined) delete g.window;
    else g.window = before;
  }
});

describe('bounded profile processing for large or sparse ticket counters (#693)', () => {
  beforeEach(() => {
    data.clear();
    resetPackStore();
    resetTicketList();
  });

  it('bounds ticket enumeration to recorded history, not nextNonce', () => {
    data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET, name: 'Tester', nextNonce: 1_000_000, createdAt: 0 }));
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify([]));
    resetTicketList();

    // Tickets array should be empty, not 1,000,000 dummy tickets
    expect(myTickets()).toHaveLength(0);

    // Profile info, stats, and progress calculate in O(recorded) time without expanding missing nonces
    const info = myProfileInfo();
    expect(info).toEqual({
      packs: 1_000_000,
      filled: 1_000_000,
      missing: 1_000_000,
      cache: 'ready',
    });

    const stats = myStats();
    expect(stats).toMatchObject({
      level: 1,
      xp: 0,
      packs: 0,
    });
    expect(stats?.best).toEqual([]);

    const progress = myProgress();
    expect(progress).toMatchObject({
      level: 1,
      xp: 0,
      gained: 0,
    });
  });

  it('handles extreme safe-integer counter (Number.MAX_SAFE_INTEGER) without memory exhaustion', () => {
    // A 1M counter first, as a sentinel: if enumeration ever expanded to nextNonce again, this fails
    // (1M tickets) before the MAX_SAFE_INTEGER counter below could hang or exhaust memory.
    for (const nextNonce of [1_000_000, Number.MAX_SAFE_INTEGER]) {
      data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET, name: 'Tester', nextNonce, createdAt: 0 }));
      data.set(STORAGE_KEYS.HISTORY, JSON.stringify([]));
      resetTicketList();

      expect(myTickets()).toHaveLength(0);
      expect(myProfileInfo()).toEqual({ packs: nextNonce, filled: nextNonce, missing: nextNonce, cache: 'ready' });
      expect(myStats()?.level).toBe(1);
      expect(syncMyBestCards()).toMatchObject({ cards: [], complete: false });
    }
  });

  it('processes high-nonce mapping sparsely without enumerating preceding missing nonces', async () => {
    const HIGH_NONCE = 999_999_999;
    data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET, name: 'Tester', nextNonce: 1_000_000_000, createdAt: 0 }));
    const key = getPlayer().publicKeyHex.slice(0, 16);
    const code = await codeOf(HIGH_NONCE);
    const pulled = toPulled(code.split(',').map(decodeCard), SET)!;
    const score = scorePulled(pulled);
    const history = [{
      s: SET.id,
      v: SET.version,
      n: HIGH_NONCE,
      k: key,
      c: code,
      h: score.hand.name,
      x: score.score,
      t: 1000,
    }];
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    resetTicketList();

    // Only 1 ticket materialized
    const tickets = myTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].nonce).toBe(HIGH_NONCE);
    expect(tickets[0].set?.id).toBe(SET.id);
    expect(tickets[0].pack).not.toBeNull();

    // Profile info counts 1 valid set, 1 pack present, and 999_999_999 missing
    const info = myProfileInfo();
    expect(info).toEqual({
      packs: 1_000_000_000,
      filled: 999_999_999,
      missing: 999_999_999,
      cache: 'ready',
    });

    // Stats reflect the high-nonce pack's score and XP
    const stats = myStats();
    expect(stats?.packs).toBe(1);
    expect(stats?.xp).toBeGreaterThan(0);
    expect(stats?.best).toHaveLength(1);
    expect(stats?.best[0].nonce).toBe(HIGH_NONCE);

    // Profile proof refuses because nonces 0..999_999_998 are missing
    await expect(myProfileProof()).rejects.toThrow('original pack set/version mappings');
  });

  it('ignores out-of-range nonces in history (< 0 or >= nextNonce)', () => {
    data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET, name: 'Tester', nextNonce: 10, createdAt: 0 }));
    const key = getPlayer().publicKeyHex.slice(0, 16);
    const history = [
      { s: SET.id, v: SET.version, n: -1, k: key, h: 'No Matches', x: 0, t: 1 },
      { s: SET.id, v: SET.version, n: 5, k: key, h: 'No Matches', x: 0, t: 2 },
      { s: SET.id, v: SET.version, n: 10, k: key, h: 'No Matches', x: 0, t: 3 },
      { s: SET.id, v: SET.version, n: 999, k: key, h: 'No Matches', x: 0, t: 4 },
    ];
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    resetTicketList();

    const tickets = myTickets({ player: getPlayer(), nextNonce: 10 });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].nonce).toBe(5);
  });
});

it('recovers safely when history has an entry with malformed cached cards (#652)', () => {
  setUp(1);
  const player = getPlayer();
  const key = player.publicKeyHex.slice(0, 16);
  // Row with LF in cached card code
  const history = [{
    s: SET.id,
    v: SET.version,
    n: 0,
    k: key,
    c: 'sigma\nid',
    h: 'Pair',
    x: 100,
    t: 1000,
  }];
  data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
  resetTicketList();

  // myProfileInfo does not throw TypeError and reports the ticket
  const info = myProfileInfo();
  expect(info).toMatchObject({
    packs: 1,
  });

  // myStats does not throw
  expect(() => myStats()).not.toThrow();
});

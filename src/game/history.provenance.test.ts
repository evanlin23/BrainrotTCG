/**
 * Issue #241: a ticket's original set/version mapping is permanent, cached cards are not. One fixture
 * mixes sets and versions across a player's tickets (plus another player's pack on the same device)
 * and follows it through reloads, a save export and import, storage too full for any history write,
 * and the loss of every card cache. Each "reload" re-imports the game modules, so no in-memory state
 * survives it, as with a real page load.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { checkProfile, computeTicket, derivePack, encodeProof, fromHex, publicKeyFromSecret, scorePulled, signProof, toHex, verifyProof, type SetDefinition } from '../engine';
import { encodeCard } from './cardCode';
import type { OpenedPack } from './pulls';

// No Worker or IndexedDB here: tickets are mined on this thread and the pack store lives in memory only.
const data = new Map<string, string>();
/** When set, a write it returns true for fails as a full browser storage would. */
let refuse: ((key: string, raw: string) => boolean) | null = null;
vi.stubGlobal('localStorage', {
  get length() { return data.size; },
  key: (index: number) => [...data.keys()][index] ?? null,
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, raw: string) => {
    if (refuse?.(key, raw)) throw new DOMException('full', 'QuotaExceededError');
    data.set(key, raw);
  },
  removeItem: (key: string) => void data.delete(key),
});

const HISTORY = STORAGE_KEYS.HISTORY;
const SECRET = '03'.repeat(32);
const PUBLIC = publicKeyFromSecret(fromHex(SECRET));
const HEX = toHex(PUBLIC);
const KEY = HEX.slice(0, 16);
const OTHER_HEX = toHex(publicKeyFromSecret(fromHex('04'.repeat(32))));
const SETS = (['genesis@1', 'right-now@1', 'right-now@2', 'genesis@1', 'right-now@2'] as const).map((key) => {
  const [id, version] = key.split('@');
  return getSet(id, Number(version))!;
});
const setKeys = [...new Set(SETS.map((s) => `${s.id}@${s.version}`))];

interface Entry { s: string; v: number; n: number; k: string; c?: string; h: string; x: number; t: number }
/** Tickets 0..4 as this device opened them (field order as history.ts stores them). Only 0..3 are in the fixture. */
let opened: Entry[];
/** Ticket 4 as openPack hands it over. */
let pack4: OpenedPack;
/** Another player's pack on this device: never part of this player's profile. */
const OTHERS: Entry = { s: 'right-now', v: 2, n: 0, k: OTHER_HEX.slice(0, 16), h: 'No Matches', x: 0, t: 25 };

beforeAll(async () => {
  opened = [];
  let pulled: Awaited<ReturnType<typeof derivePack>> = [];
  for (const [n, set] of SETS.entries()) {
    pulled = await derivePack(set, PUBLIC, n, computeTicket);
    opened.push(toEntry(set, n, pulled));
  }
  // recordPack encodes the cards itself: hand it ticket 4's decoded ones so the stored code matches.
  const { s, v, n, h, x, t } = opened[4];
  pack4 = {
    setId: s, setVersion: v, nonce: n, publicKeyHex: HEX, openedAt: t,
    cards: pulled.map((c, i) => ({ id: c.cardId, isHolo: c.isHolo, finish: c.finish, misprint: c.misprint, uniqueId: i })),
    score: { hand: { name: h }, score: x },
  } as unknown as OpenedPack;
});

const toEntry = (set: SetDefinition, n: number, pulled: Awaited<ReturnType<typeof derivePack>>): Entry => {
  const score = scorePulled(pulled);
  const c = pulled.map((p) => encodeCard({ id: p.cardId, holo: p.isHolo, finish: p.finish, misprint: p.misprint })).join(',');
  return { s: set.id, v: set.version, n, k: KEY, c, h: score.hand.name, x: score.score, t: 10 * (n + 1) };
};

const bare = ({ c: _cards, ...entry }: Entry): Entry => entry;
/** Newest first, as the history keeps it: tickets 3, 2, the other player's pack, 1, 0. */
const fixture = (shape: (e: Entry) => Entry = (e) => e): Entry[] =>
  [opened[3], opened[2], OTHERS, opened[1], opened[0]].map((e) => (e === OTHERS ? e : shape(e)));
/** What a history entry maps: everything but its discardable card cache. */
const mappings = (raw: string) => (JSON.parse(raw) as Entry[]).map(bare);

const setUp = (entries: Entry[]) => {
  data.clear();
  refuse = null;
  data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET, name: 'Tester', nextNonce: 4, createdAt: 0 }));
  data.set(HISTORY, JSON.stringify(entries));
};

/** A page load: fresh game modules, so only what storage holds carries over. */
const load = async () => {
  vi.resetModules();
  const [history, player, profiles, reopenJob, saveFile, packStore] = await Promise.all([
    import('./history'), import('./player'), import('./profiles'), import('./reopenJob'), import('./saveFile'), import('./packStore'),
  ]);
  return { history, player, profiles, reopenJob, saveFile, packStore };
};

const expectFixtureProof = (proof: string | null, tickets = 4) => {
  const checked = checkProfile(proof!, getSet);
  expect(toHex(checked.profile.publicKey)).toBe(HEX);
  expect(checked.tickets.map((s) => `${s.id}@${s.version}`)).toEqual(SETS.slice(0, tickets).map((s) => `${s.id}@${s.version}`));
};

describe('original ticket mappings across a mixed-set history', () => {
  it('survive a reload and a save export then import, with identical mappings and nothing guessed', async () => {
    setUp(fixture());
    const original = data.get(HISTORY)!;
    let app = await load();
    expect(app.profiles.myProfileInfo()).toMatchObject({ packs: 4, filled: 0, missing: 0 });
    const proof = await app.profiles.myProfileProof();
    expectFixtureProof(proof);

    app = await load();
    expect(data.get(HISTORY)).toBe(original);
    expect(await app.profiles.myProfileProof()).toBe(proof);
    const file = app.saveFile.exportSaveFile();

    data.clear(); // Another browser, or this one after its site data was cleared.
    app = await load();
    expect(app.saveFile.importSaveFile(file)).toBeNull();
    expect(data.get(HISTORY)).toBe(original);

    app = await load();
    expect(JSON.parse(app.player.exportPlayer())).toMatchObject({ secretKey: SECRET, nextNonce: 4 });
    expect(app.profiles.myProfileInfo()).toMatchObject({ packs: 4, filled: 0, missing: 0 });
    expect(app.history.historyForKey(HEX).map((e) => [e.nonce, e.setId, e.setVersion]))
      .toEqual(SETS.slice(0, 4).map((s, n) => [n, s.id, s.version]));
    expect(await app.profiles.myProfileProof()).toBe(proof);
    expect(data.get(HISTORY)).toBe(original);
  });

  it('carry a lost mapping through export and import as lost, never filled in from a neighbour', async () => {
    setUp(fixture().filter((e) => !(e.k === KEY && e.n === 1)));
    const original = data.get(HISTORY)!;
    let app = await load();
    const file = app.saveFile.exportSaveFile();
    data.clear();
    app = await load();
    expect(app.saveFile.importSaveFile(file)).toBeNull();

    app = await load();
    expect(data.get(HISTORY)).toBe(original);
    expect(app.profiles.myProfileInfo()).toMatchObject({ packs: 4, filled: 1 });
    await expect(app.profiles.myProfileProof()).rejects.toThrow('original pack set/version mappings');
    expect(data.get(HISTORY)).toBe(original);
  });

  it('under quota that dropping cached cards cannot satisfy, keep every known mapping and sign only from real ones', async () => {
    // Ticket 1's cards were dropped earlier, so re-opening it has real work to do.
    setUp(fixture((e) => (e.n === 1 ? bare(e) : e)));
    const original = data.get(HISTORY)!;
    const tried: string[] = [];
    refuse = (key, raw) => key === HISTORY && tried.push(raw) > 0; // No form of the history fits any more.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let app = await load();
      expect(await app.player.claimNonce()).toMatchObject({ nonce: 4, stored: true });
      expect(app.history.recordPack(pack4)).toBe(false);
      // It tried without the cached cards before giving up, and wrote nothing.
      expect(tried.length).toBeGreaterThan(1);
      expect(tried[tried.length - 1]).not.toContain('"c"');
      expect(data.get(HISTORY)).toBe(original);

      app = await load();
      expect(app.player.peekNonce()).toBe(5);
      expect(app.profiles.myProfileInfo()).toMatchObject({ packs: 5, filled: 1, missing: 2 });
      await app.reopenJob.reopenMyPacks();
      // The mapped ticket is re-opened in its own set; the unmapped one in none.
      expect(app.packStore.getStoredPack('right-now@1', HEX, 1)).toBe(opened[1].c);
      for (const set of setKeys) expect(app.packStore.getStoredPack(set, HEX, 4)).toBeUndefined();
      expect(app.profiles.myProfileInfo()).toMatchObject({ packs: 5, filled: 1, missing: 1 });
      await expect(app.profiles.myProfileProof()).rejects.toThrow('original pack set/version mappings');
      expect(data.get(HISTORY)).toBe(original);

      // Space comes back and the app records the pack it kept: the profile then has every real mapping.
      refuse = null;
      expect(app.history.recordMissing([pack4], HEX)).toBe(true);
      expect(mappings(data.get(HISTORY)!)).toEqual([bare(opened[4]), ...mappings(original)]);
      expectFixtureProof(await app.profiles.myProfileProof(), 5);
    } finally {
      error.mockRestore();
    }
  });

  it('never change when the card caches are evicted or lost, and neither does the signed profile', async () => {
    setUp(fixture());
    const original = data.get(HISTORY)!;
    let app = await load();
    const proof = await app.profiles.myProfileProof();
    expectFixtureProof(proof);
    // This device also re-opened its packs into the pack store...
    expect(await app.packStore.putStoredPacks(opened.slice(0, 4).map((e) => ({ setKey: `${e.s}@${e.v}`, publicKeyHex: HEX, nonce: e.n, cards: e.c! }))))
      .toBe(true);
    // ...when another player's pack filled storage: the history makes room by dropping its cached cards.
    refuse = (key, raw) => key === HISTORY && raw.includes('"c"');
    expect(app.history.recordPack({ ...pack4, publicKeyHex: OTHER_HEX, nonce: 1, openedAt: 60 })).toBe(true);
    refuse = null;
    const evicted = data.get(HISTORY)!;
    expect(evicted).not.toContain('"c"');
    expect(mappings(evicted).slice(1)).toEqual(mappings(original));
    expect(await app.profiles.myProfileProof()).toBe(proof);

    // Then the pack store is lost too (evicted, or cleared with other site data): only the mappings remain.
    app = await load();
    expect(app.profiles.myProfileInfo()).toMatchObject({ packs: 4, filled: 0, missing: 4 });
    expect(await app.profiles.myProfileProof()).toBe(proof);
    expect(data.get(HISTORY)).toBe(evicted);
    for (const e of opened.slice(0, 4)) expect(app.packStore.getStoredPack(`${e.s}@${e.v}`, HEX, e.n)).toBe(e.c);
  });
});

describe('exact-variant proof attribution across cache eviction (issue #654)', () => {
  const SECRET_11 = '11'.repeat(32);
  const PUBLIC_11 = publicKeyFromSecret(fromHex(SECRET_11));
  const HEX_11 = toHex(PUBLIC_11);
  const KEY_11 = HEX_11.slice(0, 16);
  const SET_RN2 = getSet('right-now', 2)!;

  it('never links an unrelated pack when quota drops cached cards, and restores correct link on hydration', async () => {
    // 1. Compute real tickets 1 and 6 for disposable fixed identity 11.repeat(32).
    // Ticket #1 contains Silver remember-november.
    // Ticket #6 contains that card plain and as a Misprint, but no Silver.
    const pulled1 = await derivePack(SET_RN2, PUBLIC_11, 1, computeTicket);
    const pulled6 = await derivePack(SET_RN2, PUBLIC_11, 6, computeTicket);

    const hasSilver1 = pulled1.some((c) => c.cardId === 'remember-november' && c.finish === 'SILVER');
    const hasSilver6 = pulled6.some((c) => c.cardId === 'remember-november' && c.finish === 'SILVER');
    const hasPlain6 = pulled6.some((c) => c.cardId === 'remember-november' && !c.finish && !c.misprint && !c.isHolo);
    const hasMisprint6 = pulled6.some((c) => c.cardId === 'remember-november' && c.misprint);

    expect(hasSilver1).toBe(true);
    expect(hasSilver6).toBe(false);
    expect(hasPlain6).toBe(true);
    expect(hasMisprint6).toBe(true);

    const entry1 = toEntry(SET_RN2, 1, pulled1);
    const entry6 = toEntry(SET_RN2, 6, pulled6);
    // Fix key on entries to KEY_11
    entry1.k = KEY_11;
    entry6.k = KEY_11;

    // 2. Both tickets cached in history.
    data.clear();
    refuse = null;
    data.set('brainrot-player-v1', JSON.stringify({ secretKey: SECRET_11, name: 'Tester', nextNonce: 7, createdAt: 0 }));
    data.set(HISTORY, JSON.stringify([entry6, entry1])); // newest first

    let app = await load();
    const exactLookup = { isHolo: false, finish: 'SILVER' as const, misprint: false };

    // With exact cached #1 available, the correct proof wins
    const foundWithCache = app.history.findPackWithCard(HEX_11, 'right-now', 'remember-november', exactLookup, { exactOnly: true });
    expect(foundWithCache?.nonce).toBe(1);

    // Verify proof for #1 confirms presence of Silver remember-november
    const proof1 = encodeProof(signProof({ setId: 'right-now', setVersion: 2, nonce: 1, publicKey: PUBLIC_11, name: 'Tester' }, fromHex(SECRET_11)));
    const verified1 = await verifyProof(proof1, getSet);
    expect(verified1.cards.some((c) => c.cardId === 'remember-november' && c.finish === 'SILVER')).toBe(true);

    // 3. Quota fallback: ticket #1's cached cards are dropped (c: undefined) while ticket #6 retains its cards.
    // packStore is not yet hydrated.
    const evictedHistory = [entry6, { ...entry1, c: undefined }];
    data.set(HISTORY, JSON.stringify(evictedHistory));

    app = await load();
    // exactOnly: true strictly returns null because ticket #1 is evicted and ticket #6 lacks Silver
    const foundEvicted = app.history.findPackWithCard(HEX_11, 'right-now', 'remember-november', exactLookup, { exactOnly: true });
    expect(foundEvicted).toBeNull();

    // General lookup fallback without exactOnly still returns ticket #6 (preserving fallback for callers not claiming exact provenance)
    const fallback = app.history.findPackWithCard(HEX_11, 'right-now', 'remember-november', exactLookup);
    expect(fallback?.nonce).toBe(6);

    // Verify proof for #6 confirms that ticket #6 indeed lacks Silver
    const proof6 = encodeProof(signProof({ setId: 'right-now', setVersion: 2, nonce: 6, publicKey: PUBLIC_11, name: 'Tester' }, fromHex(SECRET_11)));
    const verified6 = await verifyProof(proof6, getSet);
    expect(verified6.cards.some((c) => c.cardId === 'remember-november' && c.finish === 'SILVER')).toBe(false);

    // 4. Missing cache does not delete ownership or ticket mappings; exact data restoration permits correct sharing.
    expect(await app.packStore.putStoredPacks([{ setKey: 'right-now@2', publicKeyHex: HEX_11, nonce: 1, cards: entry1.c! }])).toBe(true);

    const foundRestored = app.history.findPackWithCard(HEX_11, 'right-now', 'remember-november', exactLookup, { exactOnly: true });
    expect(foundRestored?.nonce).toBe(1);
  });
});

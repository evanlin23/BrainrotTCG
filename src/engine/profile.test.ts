import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, encodeVarint, fromBase64Url, toBase64Url, utf8 } from './bytes';
import { fingerprint, generateKeypair, sign } from './identity';
import { derivePack, ProofError } from './proof';
import {
  checkClaims,
  checkProfile,
  claimsTracker,
  claimsFor,
  createProfile,
  decodeProfile,
  encodeProfile,
  extractProfile,
  levelForXp,
  profileStats,
  signProfile,
  verifyProfile,
  type ProfileProof,
  xpForLevel,
  XP_PER_NEW_CARD,
  XP_PER_PACK,
  type ProfilePack,
} from './profile';
import { scorePack } from './scoring';
import { ticketPreimage } from './ticket';
import { validateSet, type SetDefinition } from './types';

const makeSet = (id: string): SetDefinition =>
  validateSet({
    id,
    version: 1,
    name: id,
    era: 'test',
    releasedAt: '2026-10-12',
    packSize: 5,
    odds: { COMMON: 5000, UNCOMMON: 2500, RARE: 1500, EPIC: 700, LEGENDARY: 250, BRAINROT: 50 },
    holoOdds: 500,
    cards: [
      { id: 'c1', name: 'C1', rarity: 'COMMON' },
      { id: 'c2', name: 'C2', rarity: 'COMMON' },
      { id: 'u1', name: 'U1', rarity: 'UNCOMMON' },
      { id: 'r1', name: 'R1', rarity: 'RARE' },
      { id: 'e1', name: 'E1', rarity: 'EPIC' },
      { id: 'l1', name: 'L1', rarity: 'LEGENDARY' },
      { id: 'b1', name: 'B1', rarity: 'BRAINROT' },
    ],
  });

const A = makeSet('set-a');
const B = makeSet('set-b');
const lookup = (id: string, version: number) => [A, B].find((s) => s.id === id && s.version === version);

/** Argon2 is slow and covered elsewhere; any deterministic ticket works for these tests. */
const fastTicket = async (setKey: string, publicKey: Uint8Array, nonce: number) => sha256(utf8(ticketPreimage(setKey, publicKey, nonce)));

const keys = generateKeypair();
const make = (name: string, r: typeof runs): Promise<ProfileProof> => createProfile({ publicKey: keys.publicKey, name, runs: r }, keys.secretKey, lookup, fastTicket);
const runs = [
  { setId: 'set-a', setVersion: 1, count: 3 },
  { setId: 'set-b', setVersion: 1, count: 2 },
  { setId: 'set-a', setVersion: 1, count: 1 },
];

/** Sign raw bytes the way the engine does, to build encodings the encoder would never produce. */
const signRaw = (body: Uint8Array) => toBase64Url(concatBytes(body, sign(concatBytes(utf8('brainrot-tcg/profile/v1'), body), keys.secretKey)));
const header = (name = 'Evan') => concatBytes(Uint8Array.of(1), keys.publicKey, Uint8Array.of(utf8(name).length), utf8(name));
const tableEntry = (id: string) => concatBytes(Uint8Array.of(utf8(id).length), utf8(id), Uint8Array.of(0, 1));
const run = (index: number, count: number) => concatBytes(encodeVarint(index), encodeVarint(count));
/** Claims for a hand-built body: any XP, and highlights 0..h-1 (decoding doesn't check them against the packs). */
const claims = (tickets: number) => concatBytes(encodeVarint(0), Uint8Array.of(Math.min(5, tickets)), ...Array.from({ length: Math.min(5, tickets) }, (_, i) => encodeVarint(i)));

const ruleOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof ProofError ? error.rule : `other: ${String(error)}`;
  }
  return 'accepted';
};

describe('profile proofs', () => {
  it('round-trips and lists the set of every ticket, from #0, in order', async () => {
    const text = encodeProfile(await make('Evan', runs));
    expect(decodeProfile(text).runs).toEqual(runs);
    const checked = checkProfile(text, lookup);
    expect(checked.tickets.map((s) => s.id)).toEqual(['set-a', 'set-a', 'set-a', 'set-b', 'set-b', 'set-a']);
    expect(checked.fingerprint).toBe(fingerprint(keys.publicKey));
    expect(extractProfile(`look https://x.dev/#/profile/${text} !`)).toBe(text);
  });

  it('merges neighbouring runs of the same set when signing', async () => {
    const merged = await make('Evan', [
      { setId: 'set-a', setVersion: 1, count: 2 },
      { setId: 'set-a', setVersion: 1, count: 1 },
      { setId: 'set-b', setVersion: 1, count: 0 },
    ]);
    expect(merged.runs).toEqual([{ setId: 'set-a', setVersion: 1, count: 3 }]);
    expect(merged.highlights).toHaveLength(3);
  });

  it('re-opens every pack exactly as opening it would', async () => {
    const text = encodeProfile(await make('Evan', runs));
    const { packs } = await verifyProfile(text, lookup, fastTicket);
    expect(packs).toHaveLength(6);
    for (const pack of packs) {
      expect(pack.cards).toEqual(await derivePack(pack.set, keys.publicKey, pack.nonce, fastTicket));
    }
    expect(packs[3].set.id).toBe('set-b');
  });

  it('rejects wrong claims once every pack is re-opened', async () => {
    const real = await make('Evan', runs);
    const { packs } = await verifyProfile(encodeProfile(real), lookup, fastTicket);
    expect(claimsFor(packs)).toEqual({ xp: real.xp, highlights: real.highlights });
    const inflated = encodeProfile(signProfile({ ...real, xp: real.xp + 1000 }, keys.secretKey));
    expect(ruleOf(() => checkProfile(inflated, lookup))).toBe('accepted'); // can't tell until the packs are re-opened
    await expect(verifyProfile(inflated, lookup, fastTicket)).rejects.toMatchObject({ rule: 'claims' });
    const reordered = signProfile({ ...real, highlights: [...real.highlights].reverse() }, keys.secretKey);
    expect(() => checkClaims(reordered, packs)).toThrow(ProofError);
  });

  it('rejects edits: every byte is covered by the signature', async () => {
    const text = encodeProfile(await make('Evan', runs));
    const bytes = fromBase64Url(text);
    // The last highlight (the byte just before the signature): still a valid, unused ticket number.
    const edited = bytes.slice();
    const used = new Set(decodeProfile(text).highlights);
    edited[edited.length - 65] = [0, 1, 2, 3, 4, 5].find((n) => !used.has(n))!;
    expect(ruleOf(() => checkProfile(toBase64Url(edited), lookup))).toBe('signature');
    // Someone else's key on the same body.
    const other = generateKeypair();
    const swapped = bytes.slice();
    swapped.set(other.publicKey, 1);
    expect(ruleOf(() => checkProfile(toBase64Url(swapped), lookup))).toBe('signature');
  });

  it('rejects non-canonical encodings, even when signed', () => {
    const ok = signRaw(concatBytes(header(), Uint8Array.of(2), tableEntry('set-a'), tableEntry('set-b'), encodeVarint(2), run(0, 1), run(1, 1), claims(2)));
    expect(ruleOf(() => checkProfile(ok, lookup))).toBe('accepted');

    const cases: Record<string, Uint8Array> = {
      'two runs in a row share a set': concatBytes(header(), Uint8Array.of(1), tableEntry('set-a'), encodeVarint(2), run(0, 1), run(0, 1), claims(2)),
      'empty run': concatBytes(header(), Uint8Array.of(2), tableEntry('set-a'), tableEntry('set-b'), encodeVarint(2), run(0, 0), run(1, 1), claims(1)),
      'table not in order of first use': concatBytes(header(), Uint8Array.of(2), tableEntry('set-a'), tableEntry('set-b'), encodeVarint(2), run(1, 1), run(0, 1), claims(2)),
      'unused table entry': concatBytes(header(), Uint8Array.of(2), tableEntry('set-a'), tableEntry('set-b'), encodeVarint(1), run(0, 1), claims(1)),
      'duplicate table entry': concatBytes(header(), Uint8Array.of(2), tableEntry('set-a'), tableEntry('set-a'), encodeVarint(2), run(0, 1), run(1, 1), claims(2)),
      'index out of range': concatBytes(header(), Uint8Array.of(1), tableEntry('set-a'), encodeVarint(1), run(1, 1), claims(1)),
      'no runs': concatBytes(header(), Uint8Array.of(1), tableEntry('set-a'), encodeVarint(0), claims(0)),
      'too many tickets': concatBytes(header(), Uint8Array.of(1), tableEntry('set-a'), encodeVarint(1), run(0, 100_001), claims(100_001)),
      'too few highlights': concatBytes(header(), Uint8Array.of(1), tableEntry('set-a'), encodeVarint(1), run(0, 3), claims(2)),
      'highlight past the last ticket': concatBytes(header(), Uint8Array.of(1), tableEntry('set-a'), encodeVarint(1), run(0, 1), encodeVarint(0), Uint8Array.of(1), encodeVarint(1)),
      'highlight listed twice': concatBytes(header(), Uint8Array.of(1), tableEntry('set-a'), encodeVarint(1), run(0, 2), encodeVarint(0), Uint8Array.of(2), encodeVarint(1), encodeVarint(1)),
    };
    for (const [why, body] of Object.entries(cases)) {
      expect(ruleOf(() => checkProfile(signRaw(body), lookup)), why).toBe('decode');
    }
    expect(ruleOf(() => checkProfile(ok + 'AA', lookup))).toBe('decode');
  });

  it('checks the name, then the key, then the sets', () => {
    const bad = signRaw(concatBytes(header('E\u202Evan'), Uint8Array.of(1), tableEntry('set-a'), encodeVarint(1), run(0, 1), claims(1)));
    expect(ruleOf(() => checkProfile(bad, lookup))).toBe('name');
    const unknown = signRaw(concatBytes(header(), Uint8Array.of(1), tableEntry('set-zzz'), encodeVarint(1), run(0, 1), claims(1)));
    expect(ruleOf(() => checkProfile(unknown, lookup))).toBe('set');
  });

  it("doesn't accept a pull proof's signature (different domain)", () => {
    const body = concatBytes(header(), Uint8Array.of(1), tableEntry('set-a'), encodeVarint(1), run(0, 1), claims(1));
    const wrongDomain = toBase64Url(concatBytes(body, sign(concatBytes(utf8('brainrot-tcg/proof/v1'), body), keys.secretKey)));
    expect(ruleOf(() => checkProfile(wrongDomain, lookup))).toBe('signature');
  });
});

describe('early claims checks', () => {
  /** Every pack of a profile, in the order the live verifier re-opens them: highlights, then the rest. */
  const reopen = async (proof: ProfileProof) => {
    const { packs, checked } = await verifyProfile(encodeProfile(proof), lookup, fastTicket);
    const order = [...proof.highlights, ...packs.map((p) => p.nonce).filter((n) => !proof.highlights.includes(n))];
    return { tickets: checked.tickets, inOrder: order.map((n) => packs[n]) };
  };
  const firstReason = (claims: Parameters<typeof claimsTracker>[0], tickets: SetDefinition[], packs: ProfilePack[]) => {
    const tracker = claimsTracker(claims, tickets);
    const initial = tracker.initial();
    if (initial) return { reason: initial, at: 0 };
    for (const [i, pack] of packs.entries()) {
      const reason = tracker.add(pack);
      if (reason) return { reason, at: i + 1 };
    }
    return null;
  };

  it('never rules out a real profile, whatever order its packs arrive in', async () => {
    for (const count of [1, 4, 30]) {
      const proof = await make('Evan', [{ setId: 'set-a', setVersion: 1, count }, { setId: 'set-b', setVersion: 1, count: 7 }]);
      const { tickets, inOrder } = await reopen(proof);
      expect(firstReason(proof, tickets, inOrder)).toBeNull();
      expect(firstReason(proof, tickets, [...inOrder].reverse())).toBeNull();
    }
  });

  it('rules out impossible XP before re-opening anything, and too little XP as soon as it shows', async () => {
    const proof = await make('Evan', [{ setId: 'set-a', setVersion: 1, count: 30 }]);
    const { tickets, inOrder } = await reopen(proof);
    expect(firstReason({ ...proof, xp: Number.MAX_SAFE_INTEGER }, tickets, inOrder)?.at).toBe(0);
    expect(firstReason({ ...proof, xp: 30 * XP_PER_PACK - 1 }, tickets, inOrder)?.at).toBe(0);
    const short = firstReason({ ...proof, xp: proof.xp - 100 }, tickets, inOrder);
    expect(short?.reason).toMatch(/at least/);
    expect(short!.at).toBeLessThan(30);
  });

  it('rules out made-up highlights once a better pack turns up', async () => {
    const proof = await make('Evan', [{ setId: 'set-a', setVersion: 1, count: 30 }]);
    const { tickets } = await reopen(proof);
    // Name the five worst packs as the best, in a consistent order, then re-open in the live order.
    const { packs } = await verifyProfile(encodeProfile(proof), lookup, fastTicket);
    const worst = [...packs].sort((a, b) => a.score.score - b.score.score || b.nonce - a.nonce).slice(0, 5).reverse().map((p) => p.nonce);
    const fake = { ...proof, highlights: worst };
    const order = [...worst, ...packs.map((p) => p.nonce).filter((n) => !worst.includes(n))].map((n) => packs[n]);
    const result = firstReason(fake, tickets, order);
    expect(result?.reason).toMatch(/best/);
    expect(result!.at).toBeLessThan(30);
    expect(firstReason({ ...proof, highlights: [...proof.highlights].reverse() }, tickets, order)?.reason).toMatch(/order/);
  });
});

describe('levels', () => {
  it('follows 50 x L x (L - 1)', () => {
    expect([1, 2, 3, 4, 5, 10].map(xpForLevel)).toEqual([0, 100, 300, 600, 1000, 4500]);
    expect([0, 99, 100, 299, 300, 4499, 4500].map(levelForXp)).toEqual([1, 1, 2, 2, 3, 9, 10]);
  });

  it('finds the level directly, even for huge XP', () => {
    for (let level = 1; level < 3000; level++) {
      expect(levelForXp(xpForLevel(level))).toBe(level);
      expect(levelForXp(xpForLevel(level + 1) - 1)).toBe(level);
    }
    const huge = levelForXp(Number.MAX_SAFE_INTEGER);
    expect(xpForLevel(huge)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(xpForLevel(huge + 1)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it('counts packs, new cards and hands', () => {
    const pack = (nonce: number, ids: string[], holo = false): ProfilePack => {
      const cards = ids.map((cardId, slot) => ({ setId: 'set-a', cardId, rarity: 'COMMON' as const, isHolo: holo && slot === 0, slot }));
      return { nonce, set: A, cards, score: scorePack(cards.map((c) => ({ ...c, cardId: `set-a/${c.cardId}` }))) };
    };
    const packs = [pack(0, ['c1', 'c1', 'c1', 'c2', 'c2']), pack(1, ['c1', 'u1', 'r1', 'e1', 'l1'], true)];
    const stats = profileStats(packs);
    expect(stats.packs).toBe(2);
    expect(stats.unique).toBe(6);
    expect(stats.holos).toBe(1);
    expect(stats.hands).toEqual({ FULL_HOUSE: 1, NO_MATCH: 1 });
    expect(stats.xp).toBe(2 * XP_PER_PACK + 6 * XP_PER_NEW_CARD + 50);
    expect(stats.best[0].nonce).toBe(0);
    // Every card's points (all commons here, the first of pack 1 a holo), and holos by set.
    expect(stats.points).toBe(9 * 10 + 10 * 20);
    expect(stats.holoUniqueBySet).toEqual({ 'set-a': 1 });
    expect(profileStats([...packs, pack(2, ['c1', 'c1', 'c1', 'c1', 'c1'], true)]).holoUniqueBySet).toEqual({ 'set-a': 1 }); // the same card again
  });
});

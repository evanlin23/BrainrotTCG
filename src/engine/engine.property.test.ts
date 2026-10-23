/**
 * Bounded, seeded properties for the engine's valid-input invariants (#763): pack shape, scoring,
 * proof round-trips, and ticket determinism and separation. Malformed decoder input belongs to
 * decoders.property.test.ts (#749). These supplement spec/vectors.json and the Python verifier; they
 * never replace them. Scoring is checked against an oracle written from spec/PULL_SPEC.md section 8,
 * not against scoring.ts's own tables. Argon2 runs only in the ticket property, on a fixed sample.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { ALL_SET_VERSIONS, getSet } from '../content/sets';
import { toHex } from './bytes';
import { fingerprint, isValidName, normalizeName, publicKeyFromSecret } from './identity';
import { generatePack, packSeedFromTicket } from './pack';
import { decodeProof, derivePack, encodeProof, extractProof, ProofError, pullId, signProof, verifyProof, type UnsignedProof } from './proof';
import { cardPoints, POKER_HANDS, scorePack, type PackScore } from './scoring';
import { computeTicket, ticketPreimage } from './ticket';
import {
  FINISHES_RAREST_FIRST, ODDS_TOTAL, RARITIES_RAREST_FIRST, setKey, validateSet,
  type Finish, type PulledCard, type Rarity, type SetDefinition,
} from './types';
import { forAll, SAFE_COUNTERS, unicodeText, type Rng } from '../test/property';

type Generate = (set: SetDefinition, seed: Uint8Array) => PulledCard[];
type Score = (cards: readonly { cardId: string; rarity: Rarity; isHolo: boolean; finish?: Finish | null; misprint?: boolean }[]) => PackScore;

/** A safe integer drawn across the whole 0..2^53-1 range, often at a varint or word boundary. */
const nonce = (rng: Rng) => (rng.bool(0.3) ? rng.pick(SAFE_COUNTERS) : rng.int(0, 2 ** 21 - 1) * 2 ** 32 + rng.next());

const slug = (rng: Rng, maxBytes: number) => {
  const words = Array.from({ length: rng.int(1, 4) }, () => Array.from({ length: rng.int(1, 12) }, () => rng.pick([...'abcdefghijklmnopqrstuvwxyz0123456789'])).join(''));
  return words.join('-').slice(0, maxBytes).replace(/-+$/, '');
};

/** A set definition that passes validateSet: random odds (often with empty rarities), size, holo odds and modifiers. */
const syntheticSet = (rng: Rng): SetDefinition => {
  const live = RARITIES_RAREST_FIRST.filter(() => rng.bool(0.6));
  if (live.length === 0) live.push(rng.pick(RARITIES_RAREST_FIRST));
  const odds = Object.fromEntries(RARITIES_RAREST_FIRST.map((r) => [r, 0])) as Record<Rarity, number>;
  let left = ODDS_TOTAL;
  live.forEach((r, i) => {
    const weight = i === live.length - 1 ? left : rng.int(1, left - (live.length - 1 - i));
    odds[r] = weight;
    left -= weight;
  });
  // Every live rarity has cards; an empty rarity sometimes has cards too, which must never be drawn.
  const cards = RARITIES_RAREST_FIRST.flatMap((rarity) => {
    const count = odds[rarity] > 0 ? rng.int(1, 6) : rng.bool(0.4) ? rng.int(1, 3) : 0;
    return Array.from({ length: count }, (_, i) => ({ id: `${rarity.toLowerCase()}-${i}`, name: `${rarity} ${i}`, rarity }));
  });
  return validateSet({
    id: slug(rng, 40) || 'set',
    version: rng.int(1, 65535),
    name: 'Generated',
    era: 'test',
    releasedAt: '2026-01-01',
    packSize: rng.int(1, 15),
    odds,
    holoOdds: rng.pick([0, 1, rng.int(0, ODDS_TOTAL), ODDS_TOTAL - 1, ODDS_TOTAL]),
    ...(rng.bool() ? { modifiers: 1 } : {}),
    cards,
  });
};

/** Every pack has packSize cards in slot order, each from the set's pool for a rarity the odds can draw. */
const packShapeProperty = (generate: Generate) => forAll(
  'pack shape',
  { seed: 763_001, runs: 400 },
  // Even cases take each released set version in turn; odd cases a generated set.
  (rng, index) => ({ set: index % 2 === 0 ? ALL_SET_VERSIONS[(index / 2) % ALL_SET_VERSIONS.length] : syntheticSet(rng), seed: rng.bytes(32) }),
  ({ set, seed }) => {
    const before = toHex(seed);
    const pack = generate(set, seed);
    expect(toHex(seed), 'the seed is not changed').toBe(before);
    expect(pack, 'same set and seed, same pack').toEqual(generate(set, seed.slice()));
    expect(pack.map((card) => card.slot)).toEqual(Array.from({ length: set.packSize }, (_, i) => i));
    for (const card of pack) {
      expect(card.setId).toBe(set.id);
      expect(set.cards.find((c) => c.id === card.cardId)?.rarity, `${card.cardId} is a ${card.rarity} card of the set`).toBe(card.rarity);
      expect(set.odds[card.rarity], `${card.rarity} has odds`).toBeGreaterThan(0);
      if (set.holoOdds === 0) expect(card.isHolo).toBe(false);
      if (set.holoOdds === ODDS_TOTAL) expect(card.isHolo).toBe(true);
      if (set.modifiers === 1) {
        expect([null, ...FINISHES_RAREST_FIRST]).toContain(card.finish);
        expect(typeof card.misprint).toBe('boolean');
      } else {
        expect(card).not.toHaveProperty('finish');
        expect(card).not.toHaveProperty('misprint');
      }
    }
  },
);

// spec/PULL_SPEC.md section 8, written out from the spec text.
const SPEC_POINTS: Record<Rarity, number> = { COMMON: 10, UNCOMMON: 20, RARE: 35, EPIC: 70, LEGENDARY: 200, BRAINROT: 1000 };
const SPEC_FINISH: Record<Finish, number> = { SILVER: 10, GOLD: 40, PLATINUM: 200, DIAMOND: 1000 };
const specCombo = (ids: readonly string[]): [string, number] => {
  const counts = [...ids.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map<string, number>()).values()].sort((a, b) => b - a);
  const [c1 = 0, c2 = 0] = counts;
  if (c1 >= 5) return ['5 of a Kind', 10000];
  if (c1 === 4) return ['4 of a Kind', 250];
  if (c1 === 3) return c2 === 2 ? ['Full House', 150] : ['3 of a Kind', 15];
  if (c1 === 2) return c2 === 2 ? ['Two Pair', 10] : ['Pair', 2];
  return ['No Matches', 1];
};

/** A pack to score: often a generated pack of a real set, otherwise hand-made cards from a few ids so combos are common. */
const scorable = (rng: Rng) => {
  if (rng.bool(0.3)) {
    const set = rng.pick(ALL_SET_VERSIONS);
    return generatePack(set, rng.bytes(32)).map((c) => ({ ...c, cardId: `${c.setId}/${c.cardId}` }));
  }
  const ids = rng.int(1, 7);
  return Array.from({ length: rng.int(0, 15) }, () => ({
    cardId: `card-${rng.int(1, ids)}`,
    rarity: rng.pick(RARITIES_RAREST_FIRST),
    isHolo: rng.bool(0.3),
    finish: rng.pick([undefined, null, ...FINISHES_RAREST_FIRST]),
    misprint: rng.pick([undefined, false, true]),
  }));
};

/** Score = (sum of card points) x combo multiplier, as the spec defines them, in any card order. */
const scoringProperty = (score: Score) => forAll(
  'pack score',
  { seed: 763_002, runs: 600 },
  (rng) => {
    const cards = scorable(rng);
    // A shuffled copy: a pack's score doesn't depend on where its cards sit.
    const shuffled = [...cards];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return { cards, shuffled };
  },
  ({ cards, shuffled }) => {
    const each = cards.map((c) => SPEC_POINTS[c.rarity] * (c.isHolo ? 20 : 1) * (c.finish ? SPEC_FINISH[c.finish] : 1) * (c.misprint ? 200 : 1));
    cards.forEach((c, i) => expect(cardPoints(c.rarity, c.isHolo, c.finish, c.misprint)).toBe(each[i]));
    const points = each.reduce((sum, n) => sum + n, 0);
    const [hand, multiplier] = specCombo(cards.map((c) => c.cardId));
    const result = score(cards);
    expect(result).toEqual({ points, hand: { name: hand, multiplier }, score: points * multiplier });
    expect(Number.isSafeInteger(result.score), 'the score is exact').toBe(true);
    expect(score(shuffled)).toEqual(result);
  },
);

/** Name inputs: plain, accented, decomposed, emoji and CJK text with spaces, or arbitrary stress text the signer normalises. */
const NAME_PARTS = ['a', 'Z', '7', ' ', 'é', 'é', 'ß', '世', '가', '\u{1f600}', '\u{1f468}‍\u{1f469}', 'ا', '_', '-', '.'];
const nameInput = (rng: Rng) => (rng.bool(0.7) ? Array.from({ length: rng.int(0, 30) }, () => rng.pick(NAME_PARTS)).join('') : unicodeText(rng, 30));

/** A signed proof for a real set or any slug set id, any u16 version, any safe nonce and key. */
const signedProof = (rng: Rng) => {
  const secretKey = rng.bytes(32);
  const set = rng.bool(0.6) ? rng.pick(ALL_SET_VERSIONS) : null;
  const unsigned: UnsignedProof = {
    setId: set?.id ?? (slug(rng, 64) || 's'),
    setVersion: set?.version ?? rng.pick([0, 1, 255, 256, 65535, rng.int(0, 65535)]),
    publicKey: publicKeyFromSecret(secretKey),
    nonce: nonce(rng),
    name: nameInput(rng),
  };
  return { secretKey, unsigned };
};

/** A fixed, cheap ticket for verifying generated proofs without Argon2. */
const fakeTicket = async (key: string, publicKey: Uint8Array, n: number) => sha256(new TextEncoder().encode(ticketPreimage(key, publicKey, n)));

describe('pack properties', () => {
  it('fills every slot from the right pool, for every released set version and generated sets', () => packShapeProperty(generatePack));

  it('catches a generator that reads the odds table in the wrong rarity order', async () => {
    const reversed: Generate = (set, seed) => {
      const odds = Object.fromEntries(RARITIES_RAREST_FIRST.map((r, i) => [r, set.odds[RARITIES_RAREST_FIRST[RARITIES_RAREST_FIRST.length - 1 - i]]]));
      return generatePack({ ...set, odds: odds as Record<Rarity, number> }, seed);
    };
    await expect(packShapeProperty(reversed)).rejects.toThrow(/seed 763001, case \d+ of 400 \(replay with only: \d+\)\. Case: [\s\S]+\n/);
  });
});

describe('scoring properties', () => {
  it('scores every pack as the spec sums and multiplies it', () => scoringProperty(scorePack));

  it('catches swapped combo multipliers (Pair and Two Pair)', async () => {
    const swap: Record<string, number> = { [POKER_HANDS.PAIR.name]: POKER_HANDS.TWO_PAIR.multiplier, [POKER_HANDS.TWO_PAIR.name]: POKER_HANDS.PAIR.multiplier };
    const swapped: Score = (cards) => {
      const { points, hand } = scorePack(cards);
      const multiplier = swap[hand.name] ?? hand.multiplier;
      return { points, hand: { name: hand.name, multiplier }, score: points * multiplier };
    };
    await expect(scoringProperty(swapped)).rejects.toThrow(/seed 763002, case \d+ of 600 \(replay with only: \d+\)\. Case: [\s\S]+\n/);
  });
});

describe('proof round-trip properties', () => {
  it('decodes what it encodes, canonically, with the normalised name, and finds it in a share link', async () => {
    const outcomes = { verified: 0, unknownSet: 0 };
    await forAll(
      'proof round-trip',
      { seed: 763_003, runs: 80 },
      signedProof,
      async ({ secretKey, unsigned }) => {
        const proof = signProof(unsigned, secretKey);
        expect(proof.name).toBe(normalizeName(unsigned.name));
        expect(isValidName(proof.name)).toBe(true);
        expect(signProof(unsigned, secretKey), 'signing is deterministic').toEqual(proof);
        const text = encodeProof(proof);
        const decoded = decodeProof(text);
        expect(decoded).toEqual(proof);
        expect(encodeProof(decoded)).toBe(text);
        expect(pullId(decoded)).toBe(pullId(unsigned));
        expect(extractProof(`https://example.test/BrainrotTCG/#/pull/${text}`)).toBe(text);
        expect(extractProof(` ${text}\n`)).toBe(text);

        const set = getSet(unsigned.setId, unsigned.setVersion);
        const verified = await verifyProof(text, getSet, fakeTicket).catch((e: unknown) => e);
        if (!set) {
          expect(verified).toBeInstanceOf(ProofError);
          expect((verified as ProofError).rule).toBe('set');
          outcomes.unknownSet++;
          return;
        }
        outcomes.verified++;
        const cards = generatePack(set, packSeedFromTicket(await fakeTicket(setKey(set), proof.publicKey, proof.nonce)));
        expect(verified).toEqual({
          proof, set, cards,
          score: scorePack(cards.map((c) => ({ ...c, cardId: `${c.setId}/${c.cardId}` }))),
          fingerprint: fingerprint(proof.publicKey),
        });
      },
    );
    expect(outcomes.verified, 'some proofs are for a real set and verify').toBeGreaterThan(0);
    expect(outcomes.unknownSet, 'some proofs are for an unknown set').toBeGreaterThan(0);
  });
});

describe('ticket properties', () => {
  it('writes a different preimage for every different (set key, key, nonce)', () => forAll(
    'ticket preimage separation',
    { seed: 763_004, runs: 20 },
    (rng) => {
      // Near neighbours of one input: the next nonce, a version digit moved, one key bit flipped.
      const base = { key: setKey(rng.pick(ALL_SET_VERSIONS)), publicKey: rng.bytes(32), nonce: nonce(rng) };
      return Array.from({ length: 100 }, () => {
        const publicKey = base.publicKey.slice();
        if (rng.bool(0.3)) publicKey[rng.int(0, 31)] ^= 1 << rng.int(0, 7);
        const [id, version] = base.key.split('@');
        return {
          key: rng.pick([base.key, setKey(rng.pick(ALL_SET_VERSIONS)), `${id}@${version}${rng.int(0, 9)}`, `${id}-${version}@1`]),
          publicKey,
          nonce: rng.pick([base.nonce, Math.max(0, base.nonce - 1), Math.min(Number.MAX_SAFE_INTEGER, base.nonce + 1), Number(`${base.nonce}`.slice(1) || 0)]),
        };
      });
    },
    (inputs) => {
      const preimages = new Map<string, string>();
      for (const { key, publicKey, nonce: n } of inputs) {
        const input = `${key} ${toHex(publicKey)} ${n}`;
        const preimage = ticketPreimage(key, publicKey, n);
        expect(preimages.get(preimage) ?? input, `one preimage for ${input}`).toBe(input);
        preimages.set(preimage, input);
      }
    },
  ));

  it('derives the same ticket and pack for the same input, and different tickets for a sample of neighbours', async () => {
    // A bounded sample (13 Argon2 runs): evidence of separation, not a proof that tickets never collide.
    const inputs: { set: SetDefinition; publicKey: Uint8Array; nonce: number }[] = [];
    await forAll(
      'ticket separation sample',
      { seed: 763_005, runs: 10 },
      (rng, index) => {
        const set = rng.pick(ALL_SET_VERSIONS);
        const publicKey = publicKeyFromSecret(rng.bytes(32));
        const previous = inputs[index - 1];
        // Every other case is a one-step neighbour of the case before it.
        if (index % 2 === 1 && previous) {
          const nextNonce = { ...previous, nonce: previous.nonce === Number.MAX_SAFE_INTEGER ? 0 : previous.nonce + 1 };
          const otherVersion = ALL_SET_VERSIONS.find((s) => s.id === previous.set.id && s.version !== previous.set.version);
          return rng.pick([
            nextNonce,
            otherVersion ? { ...previous, set: otherVersion } : nextNonce,
            { ...previous, publicKey: Uint8Array.from(previous.publicKey, (b, i) => (i === 0 ? b ^ 1 : b)) },
          ]);
        }
        return { set, publicKey, nonce: nonce(rng) };
      },
      (input) => void inputs.push(input),
    );
    const tickets = await Promise.all(inputs.map(({ set, publicKey, nonce: n }) => computeTicket(setKey(set), publicKey, n)));
    expect(tickets.every((t) => t.length === 32)).toBe(true);
    expect(new Set(inputs.map((i) => ticketPreimage(setKey(i.set), i.publicKey, i.nonce))).size, 'the sample has no repeated input').toBe(inputs.length);
    // On a collision, say which two cases of the seeded sample produced it.
    const firstRepeat = (values: string[]) => {
      const seen = new Map<string, number>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) return `seed 763005, cases ${seen.get(value)} and ${index}`;
        seen.set(value, index);
      }
      return 'none';
    };
    const ticketHexes = tickets.map(toHex);
    const packSeedHexes = tickets.map((t) => toHex(packSeedFromTicket(t)));
    expect(firstRepeat(ticketHexes), 'two sampled inputs share a ticket').toBe('none');
    expect(firstRepeat(packSeedHexes), 'two sampled tickets share a pack seed').toBe('none');

    for (const index of [0, 1, inputs.length - 1]) {
      const { set, publicKey, nonce: n } = inputs[index];
      const again = await derivePack(set, publicKey, n);
      expect(again, `input ${index} derives the same pack`).toEqual(generatePack(set, packSeedFromTicket(tickets[index])));
    }
  });
});

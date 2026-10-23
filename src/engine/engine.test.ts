import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeVarint, encodeVarint, fromBase64Url, toBase64Url, toHex, utf8 } from './bytes';
import { fingerprint, generateKeypair, isValidName, normalizeName } from './identity';
import { createRng, generatePack, packFromDraws } from './pack';
import { decodeProof, derivePack, encodeProof, extractProof, signProof, verifyProof } from './proof';
import { getPokerHand, POKER_HANDS, scorePack, type HandKey } from './scoring';
import { handOdds, specialPackChance, versionPackChance } from './odds';
import { handFromCounts } from './scoring';
import { computeTicket } from './ticket';
import { ODDS_TOTAL, validateSet, type Finish, type SetDefinition } from './types';

const TEST_SET: SetDefinition = validateSet({
  id: 'test-set',
  version: 1,
  name: 'Test Set',
  era: 'now',
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
const lookup = (id: string, version: number) => (id === TEST_SET.id && version === TEST_SET.version ? TEST_SET : undefined);

describe('bytes', () => {
  it('round-trips base64url for every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = sha256(Uint8Array.of(n)).slice(0, n);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it('round-trips varints', () => {
    for (const v of [0, 1, 127, 128, 300, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      expect(decodeVarint(encodeVarint(v), 0).value).toBe(v);
    }
  });
});

describe('pack generation', () => {
  it('is deterministic for a seed (spec lock)', () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const pack = generatePack(TEST_SET, seed);
    expect(pack).toEqual(generatePack(TEST_SET, seed));
    expect(pack.map((c) => `${c.cardId}${c.isHolo ? '*' : ''}`)).toMatchInlineSnapshot(`
      [
        "l1",
        "c1",
        "c1",
        "c1",
        "c2",
      ]
    `);
  });

  it('matches the configured odds', () => {
    const counts: Record<string, number> = {};
    let holos = 0;
    const packs = 40_000;
    for (let i = 0; i < packs; i++) {
      for (const card of generatePack(TEST_SET, sha256(utf8(`seed-${i}`)))) {
        counts[card.rarity] = (counts[card.rarity] ?? 0) + 1;
        if (card.isHolo) holos++;
      }
    }
    const total = packs * TEST_SET.packSize;
    for (const [rarity, weight] of Object.entries(TEST_SET.odds)) {
      expect(Math.abs(counts[rarity] / total - weight / 10_000)).toBeLessThan(0.004);
    }
    expect(Math.abs(holos / total - 0.05)).toBeLessThan(0.003);
  });

  it('rng.int stays in range', () => {
    const rng = createRng(new Uint8Array(32));
    for (let i = 0; i < 10_000; i++) {
      const v = rng.int(7);
      expect(v >= 0 && v < 7).toBe(true);
    }
  });
});

describe('scoring', () => {
  const card = (cardId: string, isHolo = false) => ({ cardId, rarity: 'COMMON' as const, isHolo });
  it('detects poker hands', () => {
    expect(getPokerHand([card('a'), card('a'), card('a'), card('b'), card('b')]).name).toBe('Full House');
    expect(getPokerHand([card('a'), card('a'), card('a'), card('a'), card('b')]).name).toBe('4 of a Kind');
    expect(getPokerHand([card('a'), card('b'), card('c'), card('d'), card('e')]).name).toBe('No Matches');
  });
  it('multiplies points by the combo', () => {
    // 4 commons (10 each) + a holo common (10 x 20), with a pair
    expect(scorePack([card('a'), card('a'), card('b'), card('c'), card('d', true)])).toMatchObject({ points: 240, score: 480 });
  });
  it('counts copies of one card whatever its holo, finish or misprint, and keeps same-rarity cards apart (#645)', () => {
    expect(handFromCounts([1, 1, 1, 1, 1])).toBe('NO_MATCH');
    expect(handFromCounts([2, 1, 1, 1])).toBe('PAIR');
    expect(handFromCounts([3, 2])).toBe('FULL_HOUSE');
    const plain = card('a');
    const holo = card('a', true);
    const gold = { ...card('a'), finish: 'GOLD' as const };
    const misprint = { ...card('a'), misprint: true };
    const other = card('b');
    expect(getPokerHand([gold, plain, other, other, other]).name).toBe('Full House');
    expect(getPokerHand([holo, misprint, plain, other, other]).name).toBe('Full House');
    expect(getPokerHand([plain, other]).name).toBe('No Matches');
  });
});

/** One card's version: what versionPackChance and specialPackChance look at. */
type Version = { cardId: string; isHolo: boolean; finish: Finish | null; misprint: boolean };
const VERSION_FIELDS = ['cardId', 'isHolo', 'finish', 'misprint'] as const;

/** One slot of `set`, rolled by generatePack's rules from scripted draws, with the range each draw asked for. */
const rollSlot = (set: SetDefinition, draws: readonly number[]) => {
  const asked: number[] = [];
  const [card] = packFromDraws({ ...set, packSize: 1 }, { int: (n) => draws[asked.push(n) - 1] });
  const version: Version = { cardId: card.cardId, isHolo: card.isHolo, finish: card.finish ?? null, misprint: !!card.misprint };
  return { version, asked };
};

/** Whether two slots asked for the same draws (the card draw's range is its rarity's pool, so it may differ). */
const sameDraws = (a: number[], b: number[]) => a.length === b.length && a.every((n, j) => j === 1 || n === b[j]);

const exactSlots = new Map<SetDefinition, { cards: Map<string, number>; slot: { version: Version; chance: number }[] }>();

/**
 * The exact chance of every version one slot of `set` can roll, read off generatePack's own rules
 * (packFromDraws) by trying every value of every draw instead of sampling seeds. The rarity and card
 * draws are tried together over every value. Each later draw (holo, then with modifiers finish and
 * misprint) is tried over its whole range with every other draw at the bottom, and then the top, of
 * its range: it must ask for the same draws, move at most one field that no other draw moves, never
 * the card, and split that field the same way both times. A version's chance is then its card's
 * chance times the share of each later draw's value. Cached per set.
 */
const exactSlot = (set: SetDefinition) => {
  const cached = exactSlots.get(set);
  if (cached) return cached;
  const bottom = rollSlot(set, [0, 0, 0, 0, 0]);
  const ranges = bottom.asked;
  const cards = new Map<string, number>();
  const rolled = new Map<string, { version: Version; chance: number }>();
  for (let rarity = 0; rarity < ranges[0]; rarity++) {
    const pool = rollSlot(set, [rarity, 0, 0, 0, 0]).asked[1];
    for (let pick = 0; pick < pool; pick++) {
      const { version, asked } = rollSlot(set, [rarity, pick, 0, 0, 0]);
      if (!sameDraws(asked, ranges)) expect(asked).toEqual(ranges);
      const chance = 1 / ranges[0] / pool;
      cards.set(version.cardId, (cards.get(version.cardId) ?? 0) + chance);
      const key = JSON.stringify(version);
      rolled.set(key, { version, chance: (rolled.get(key)?.chance ?? 0) + chance });
    }
  }
  const topPool = rollSlot(set, [ranges[0] - 1, 0, 0, 0, 0]).asked[1];
  const ends = [ranges.map(() => 0), ranges.map((n, j) => (j === 1 ? topPool : n) - 1)];
  const movedBy = new Set<string>();
  let slot = [...rolled.values()];
  for (let j = 2; j < ranges.length; j++) {
    const [low, high] = ends.map((end) => {
      const tally = new Map(VERSION_FIELDS.map((field) => [field, new Map<unknown, number>()]));
      for (let value = 0; value < ranges[j]; value++) {
        const draws = [...end];
        draws[j] = value;
        const { version, asked } = rollSlot(set, draws);
        if (!sameDraws(asked, ranges)) expect(asked).toEqual(ranges);
        for (const field of VERSION_FIELDS) tally.get(field)!.set(version[field], (tally.get(field)!.get(version[field]) ?? 0) + 1);
      }
      const moved = VERSION_FIELDS.filter((field) => tally.get(field)!.size > 1);
      return { moved, split: moved.map((field) => tally.get(field)) };
    });
    expect(high, `draw ${j} at the top of the other draws`).toEqual(low);
    expect(low.moved.length, `draw ${j} moves one field`).toBeLessThanOrEqual(1);
    const field = low.moved[0];
    if (!field) continue;
    expect(field).not.toBe('cardId');
    expect(movedBy.has(field), `${field} moved by two draws`).toBe(false);
    movedBy.add(field);
    const split = low.split[0]!;
    slot = slot.flatMap(({ version, chance }) => [...split].map(([value, count]) => ({ version: { ...version, [field]: value }, chance: chance * count / ranges[j] })));
  }
  const result = { cards, slot: slot.filter((s) => s.chance > 0) };
  exactSlots.set(set, result);
  return result;
};

describe('odds', () => {
  const MODIFIED_SET: SetDefinition = { ...TEST_SET, modifiers: 1 };

  it('rolls every slot of a pack from its own draws, by the same rules', () => {
    for (const set of [TEST_SET, MODIFIED_SET]) {
      const perSlot = rollSlot(set, [0, 0, 0, 0, 0]).asked.length;
      // Scripted draws that differ from slot to slot; the card draw stays 0, inside every pool.
      const chunks = Array.from({ length: set.packSize }, (_, s) => Array.from({ length: perSlot }, (_, j) => (j === 1 ? 0 : (s * 2_377 + j * 4_391) % ODDS_TOTAL)));
      const asked: number[] = [];
      const draws = chunks.flat();
      const pack = packFromDraws(set, { int: (n) => draws[asked.push(n) - 1] });
      expect(asked).toHaveLength(set.packSize * perSlot);
      expect(pack.map(({ cardId, isHolo, finish, misprint, slot }) => ({ slot, version: { cardId, isHolo, finish: finish ?? null, misprint: !!misprint } })))
        .toEqual(chunks.map((chunk, slot) => ({ slot, version: rollSlot(set, chunk).version })));
    }
  });

  it('sums to 1 and matches every pack generatePack can roll', () => {
    const exact = handOdds(TEST_SET);
    expect(Object.values(exact).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    // Every ordered pack of cards (7^5), each slot from its own draws.
    const { cards } = exactSlot(TEST_SET);
    const counts: Record<string, number> = {};
    const pack: string[] = [];
    const walk = (chance: number) => {
      if (pack.length === TEST_SET.packSize) {
        const key = handFromCounts([...new Set(pack)].map((id) => pack.filter((c) => c === id).length));
        counts[key] = (counts[key] ?? 0) + chance;
        return;
      }
      for (const [id, p] of cards) {
        pack.push(id);
        walk(chance * p);
        pack.pop();
      }
    };
    walk(1);
    expect(Object.keys(counts).sort()).toEqual(Object.keys(exact).sort());
    for (const [hand, chance] of Object.entries(exact)) expect(chance, hand).toBeCloseTo(counts[hand], 12);
  });

  it('gives the chance of a special card in a pack, matching generatePack with and without modifiers', () => {
    for (const set of [TEST_SET, MODIFIED_SET]) {
      const { slot } = exactSlot(set);
      const plain = slot.filter(({ version: v }) => !v.isHolo && !v.finish && !v.misprint).reduce((sum, s) => sum + s.chance, 0);
      expect(specialPackChance(set)).toBeCloseTo(1 - plain ** set.packSize, 12);
    }
  });

  it('gives the chance of a pack with an exact card version, matching generatePack', () => {
    for (const set of [TEST_SET, MODIFIED_SET]) {
      const { slot } = exactSlot(set);
      // 7 cards x holo or not, and with modifiers x 5 finishes (or none) x misprint or not.
      expect(slot).toHaveLength(set.modifiers ? 7 * 2 * 5 * 2 : 7 * 2);
      expect(slot.reduce((sum, s) => sum + s.chance, 0)).toBeCloseTo(1, 12);
      for (const { version, chance } of slot) {
        expect(versionPackChance(set, version), JSON.stringify(version)).toBeCloseTo(1 - (1 - chance) ** set.packSize, 12);
      }
    }
  });

  it('gives exact version chances at the edges', () => {
    // One card, one slot: the slot's own chance.
    const one = { ...TEST_SET, packSize: 1 };
    expect(versionPackChance(one, { cardId: 'b1', isHolo: true })).toBeCloseTo(0.005 * 0.05, 12);
    expect(versionPackChance(one, { cardId: 'c1', isHolo: false })).toBeCloseTo(0.25 * 0.95, 12);
    // At least one of five slots.
    expect(versionPackChance(TEST_SET, { cardId: 'c1', isHolo: false })).toBeCloseTo(1 - (1 - 0.25 * 0.95) ** 5, 12);
    // Modifiers: Diamond 0.1%, no misprint 99.5%; plain means no finish (86.9%).
    const mod = { ...one, modifiers: 1 as const };
    expect(versionPackChance(mod, { cardId: 'b1', isHolo: true, finish: 'DIAMOND', misprint: true })).toBeCloseTo(0.005 * 0.05 * 0.001 * 0.005, 15);
    expect(versionPackChance(mod, { cardId: 'u1', isHolo: false, finish: null, misprint: false })).toBeCloseTo(0.25 * 0.95 * 0.869 * 0.995, 12);
    // What the set can't make.
    expect(versionPackChance(TEST_SET, { cardId: 'nope', isHolo: false })).toBe(0);
    expect(versionPackChance(TEST_SET, { cardId: 'c1', isHolo: false, finish: 'GOLD' })).toBe(0);
    expect(versionPackChance(TEST_SET, { cardId: 'c1', isHolo: false, misprint: true })).toBe(0);
    expect(versionPackChance({ ...TEST_SET, holoOdds: 0 }, { cardId: 'c1', isHolo: true })).toBe(0);
    expect(versionPackChance({ ...TEST_SET, modifiers: 2 as unknown as 1 }, { cardId: 'c1', isHolo: false })).toBeNull();
  });

  it('has no special-card chance for a modifier table it does not know', () => {
    expect(specialPackChance({ ...TEST_SET, modifiers: 2 as unknown as 1 })).toBeNull();
    expect(specialPackChance({ ...TEST_SET, holoOdds: 0 })).toBe(0);
  });

  it('pays rarer combos more (rarity corresponds to reward)', () => {
    const exact = handOdds(TEST_SET);
    const order: HandKey[] = ['PAIR', 'TWO_PAIR', 'THREE_OF_A_KIND', 'FULL_HOUSE', 'FOUR_OF_A_KIND', 'FIVE_OF_A_KIND'];
    for (let i = 1; i < order.length; i++) {
      expect(exact[order[i]]).toBeLessThan(exact[order[i - 1]]);
      expect(POKER_HANDS[order[i]].multiplier).toBeGreaterThan(POKER_HANDS[order[i - 1]].multiplier);
    }
  });
});

describe('tickets and proofs', () => {
  it('ticket hash is fixed for given inputs (spec lock: changing params needs a new ticket version)', async () => {
    const ticket = await computeTicket('test-set@1', new Uint8Array(32), 0);
    expect(toHex(ticket)).toMatchInlineSnapshot(`"bac88a9a2bc2ccf35d6a9a2521cb7acf33a8ff99ac1d13546a675b8d21b07b35"`);
  });

  it('round-trips and verifies a signed proof', async () => {
    const { secretKey, publicKey } = generateKeypair();
    const proof = signProof({ setId: 'test-set', setVersion: 1, publicKey, nonce: 42, name: '  Sigma   Toaster 🍞 ' }, secretKey);
    const text = encodeProof(proof);
    expect(text.length).toBeLessThan(220);
    expect(decodeProof(text)).toEqual(proof);
    expect(proof.name).toBe('Sigma Toaster 🍞');

    const verified = await verifyProof(text, lookup);
    expect(verified.cards).toEqual(await derivePack(TEST_SET, publicKey, 42));
    expect(verified.fingerprint).toBe(fingerprint(publicKey));
    expect(extractProof(`look https://x.github.io/BrainrotTCG/#/pull/${text} wow`)).toBe(text);
  });

  it('rejects tampered proofs', async () => {
    const { secretKey, publicKey } = generateKeypair();
    const proof = signProof({ setId: 'test-set', setVersion: 1, publicKey, nonce: 7, name: 'Evan' }, secretKey);
    const tamperedNonce = encodeProof({ ...proof, nonce: 8 });
    const tamperedName = encodeProof({ ...proof, name: 'Not Evan' });
    await expect(verifyProof(tamperedNonce, lookup)).rejects.toThrow(/Signature/);
    await expect(verifyProof(tamperedName, lookup)).rejects.toThrow(/Signature/);
    const other = signProof({ setId: 'nope', setVersion: 1, publicKey, nonce: 7, name: 'Evan' }, secretKey);
    await expect(verifyProof(encodeProof(other), lookup)).rejects.toThrow(/Unknown set/);
  });

  it('every normalised name is a valid proof name', () => {
    const pool = ['a', 'Z', ' ', '  ', '\t', '\n', '\u00A0', '\u200D', '\u202E', '\uFEFF', '\u0301', '\u{1F9E0}', '\u{E0067}', '\u3000', 'é', '\u0000'];
    let seed = 1;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    for (let i = 0; i < 2000; i++) {
      const raw = Array.from({ length: rand(40) }, () => pool[rand(pool.length)]).join('');
      expect(isValidName(normalizeName(raw)), JSON.stringify(raw)).toBe(true);
    }
  });

  it('normalises names', () => {
    expect(normalizeName('a\u0000b\n  c')).toBe('ab c');
    expect(Array.from(normalizeName('🍞'.repeat(40))).length).toBe(24);
  });
});

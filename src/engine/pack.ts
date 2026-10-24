import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8 } from './bytes';
import { FINISHES_RAREST_FIRST, MODIFIERS_V1, ODDS_TOTAL, RARITIES_RAREST_FIRST, type Finish, type PulledCard, type Rarity, type SetDefinition } from './types';

/**
 * sfc32 PRNG. Integer-only, so every JS engine produces the same sequence.
 * Seeded from the first 16 bytes of a 32-byte seed.
 */
export const createRng = (seed: Uint8Array) => {
  if (seed.length < 16) throw new Error('Seed must be at least 16 bytes');
  const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
  let a = view.getUint32(0, true);
  let b = view.getUint32(4, true);
  let c = view.getUint32(8, true);
  let d = view.getUint32(12, true);
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 15; i++) next();
  /** Uniform integer in [0, n). Exact: u32 * n stays below 2^53 for n <= 2^21. */
  const int = (n: number): number => Math.floor((next() * n) / 4294967296);
  return { next, int };
};

/** Derive the pack seed from a ticket hash (domain-separated so the ticket's raw bytes are never reused). */
export const packSeedFromTicket = (ticket: Uint8Array): Uint8Array => sha256(concatBytes(utf8('brainrot-tcg/pack/v1'), ticket));

/**
 * Deterministically generate a pack. Spec, per slot:
 *   1. roll = int(ODDS_TOTAL); rarity = first rarity (rarest first) whose cumulative odds exceed roll
 *   2. card = cards of that rarity, in set order, [int(count)]
 *   3. holo = int(ODDS_TOTAL) < holoOdds
 * and only for sets with `modifiers: 1` (section 5.4), two more draws:
 *   4. roll = int(ODDS_TOTAL); finish = first finish (rarest first) whose cumulative odds exceed roll, else none
 *   5. misprint = int(ODDS_TOTAL) < misprintOdds
 */
export const generatePack = (set: SetDefinition, seed: Uint8Array): PulledCard[] => packFromDraws(set, createRng(seed));

/** The draws a pack is rolled from: createRng's `int`, uniform in [0, n). */
export interface PackDraws { int: (n: number) => number }

/**
 * generatePack's slot rules on any source of draws. generatePack passes createRng(seed); tests pass
 * scripted draws to enumerate every outcome of a slot exactly instead of sampling seeds.
 */
export const packFromDraws = (set: SetDefinition, rng: PackDraws): PulledCard[] => {
  const pools = new Map<Rarity, string[]>();
  for (const r of RARITIES_RAREST_FIRST) pools.set(r, set.cards.filter((c) => c.rarity === r).map((c) => c.id));

  return Array.from({ length: set.packSize }, (_, slot) => {
    const roll = rng.int(ODDS_TOTAL);
    let cumulative = 0;
    let rarity: Rarity = 'COMMON';
    for (const r of RARITIES_RAREST_FIRST) {
      cumulative += set.odds[r];
      if (roll < cumulative) {
        rarity = r;
        break;
      }
    }
    const pool = pools.get(rarity)!;
    const cardId = pool[rng.int(pool.length)];
    const isHolo = rng.int(ODDS_TOTAL) < set.holoOdds;
    if (set.modifiers !== 1) return { setId: set.id, cardId, rarity, isHolo, slot };
    const finishRoll = rng.int(ODDS_TOTAL);
    let finishTotal = 0;
    let finish: Finish | null = null;
    for (const f of FINISHES_RAREST_FIRST) {
      finishTotal += MODIFIERS_V1.finishOdds[f];
      if (finishRoll < finishTotal) {
        finish = f;
        break;
      }
    }
    const misprint = rng.int(ODDS_TOTAL) < MODIFIERS_V1.misprintOdds;
    return { setId: set.id, cardId, rarity, isHolo, finish, misprint, slot };
  });
};

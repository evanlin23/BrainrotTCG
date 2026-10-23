/**
 * Seeded, bounded property runs for tests (#749; #763 reuses it). No dependency, no Math.random, no
 * clock: a property is a fixed seed and a fixed number of cases, so every run draws the same inputs.
 * Each case draws from its own generator, seeded from the property's seed and the case index, so a
 * failure names the case and `only` replays just that case.
 */

/** A deterministic 32-bit generator (mulberry32). */
export interface Rng {
  /** Uniform in 0..2^32-1. */
  next(): number;
  /** Uniform integer in min..max, both inclusive. */
  int(min: number, max: number): number;
  bool(chance?: number): boolean;
  pick<T>(items: readonly T[]): T;
  bytes(length: number): Uint8Array;
}

export const seededRng = (seed: number): Rng => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const int = (min: number, max: number) => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min || max - min >= 2 ** 32) throw new Error(`bad range ${min}..${max}`);
    return min + (next() % (max - min + 1));
  };
  return {
    next,
    int,
    bool: (chance = 0.5) => next() / 2 ** 32 < chance,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick from an empty list');
      return items[int(0, items.length - 1)];
    },
    bytes: (length) => Uint8Array.from({ length }, () => next() & 255),
  };
};

/** The seed for one case: the property's seed mixed with the case index. */
export const caseSeed = (seed: number, index: number): number => (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77)) >>> 0;

export interface PropertyRun {
  /** Fixed, recorded seed. */
  seed: number;
  /** Fixed number of cases. */
  runs: number;
  /** Replay just this case index (from a failure message). */
  only?: number;
}

/** A readable, bounded description of a generated case for failure messages. */
export const show = (value: unknown): string => {
  const text = JSON.stringify(value, (_key, v: unknown) => (v instanceof Uint8Array ? `hex:${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}` : v));
  return text === undefined ? String(value) : text.length > 600 ? `${text.slice(0, 600)}... (${text.length} chars)` : text;
};

/**
 * Runs `check` on `runs` generated cases. On the first failure it throws, naming the property, seed,
 * case index and the case itself, with the original error as `cause`. Never retries.
 */
export const forAll = async <T>(
  name: string,
  { seed, runs, only }: PropertyRun,
  generate: (rng: Rng, index: number) => T,
  check: (value: T, index: number) => void | Promise<void>,
): Promise<void> => {
  for (let index = only ?? 0; index < (only === undefined ? runs : only + 1); index++) {
    const value = generate(seededRng(caseSeed(seed, index)), index);
    try {
      await check(value, index);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw Object.assign(new Error(`Property "${name}" failed: seed ${seed}, case ${index} of ${runs} (replay with only: ${index}). Case: ${show(value)}\n${reason}`), { cause });
    }
  }
};

/** Integers around the safe-integer and varint boundaries. */
export const SAFE_COUNTERS: readonly number[] = [0, 1, 127, 128, 255, 256, 16_383, 16_384, 2 ** 31 - 1, 2 ** 31, 2 ** 32, 2 ** 49, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
/** Numbers no counter may hold: negative, fractional, unsafe or non-finite (JSON writes those as null). */
export const UNSAFE_COUNTERS: readonly number[] = [-1, -Number.MAX_SAFE_INTEGER, 0.5, 1e-9, Number.MAX_SAFE_INTEGER + 1, 2 ** 53 + 2, 2 ** 64, 1e21, Number.MAX_VALUE];

/** Code points that stress UTF-8, normalisation and name rules (lone surrogates included). */
const CODE_POINTS = [
  'a', 'Z', '0', ' ', '  ', '\t', '\n', '\u0000', '\u007f', '\u0085', ' ', '­', 'é', 'é', '́', '가', '가',
  '世', 'ا', '‮', '​', '‍', ' ', '﻿', '�', '￿', '\ud800', '\udc00', '\u{1f600}', '\u{1f468}‍\u{1f469}',
  '❤️', '\u{e0001}', '\u{10ffff}', '\u{3134a}', '<', '"', '\\', '%',
];

/** A string of up to `maxParts` stress code points. */
export const unicodeText = (rng: Rng, maxParts = 12): string => Array.from({ length: rng.int(0, maxParts) }, () => rng.pick(CODE_POINTS)).join('');

/** Byte sequences that are not UTF-8: stray continuation, overlong, surrogate, past U+10FFFF, cut short. */
export const INVALID_UTF8: readonly (readonly number[])[] = [[0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xfe], [0xff]];

/** Raw LEB128-like bytes: minimal, non-minimal, overlong, unterminated and past 2^53-1. */
export const varintBytes = (rng: Rng): Uint8Array => {
  const length = rng.int(1, 10);
  return Uint8Array.from({ length }, (_, i) => {
    const continues = i < length - 1 ? 0x80 : rng.bool(0.1) ? 0x80 : 0;
    return continues | rng.pick([0, 1, 0x7f, rng.next() & 0x7f]);
  });
};

/** One random edit to a byte string, described so a failure shows what was done. */
export const mutateBytes = (rng: Rng, input: Uint8Array): { bytes: Uint8Array; edit: string } => {
  const at = rng.int(0, Math.max(0, input.length - 1));
  const value = rng.pick([0x00, 0x01, 0x7f, 0x80, 0xff, rng.next() & 255]);
  const splice = (start: number, remove: number, insert: ArrayLike<number> = []) =>
    Uint8Array.from([...input.subarray(0, start), ...Array.from(insert), ...input.subarray(start + remove)]);
  switch (rng.int(0, 6)) {
    case 0: return { bytes: splice(at, 1, [input[at] ^ (1 << rng.int(0, 7))]), edit: `flip a bit of byte ${at}` };
    case 1: return { bytes: splice(at, 1, [value]), edit: `set byte ${at} to ${value}` };
    case 2: return { bytes: splice(at, rng.int(1, 4)), edit: `delete bytes from ${at}` };
    case 3: return { bytes: splice(at, 0, rng.bytes(rng.int(1, 4))), edit: `insert bytes at ${at}` };
    case 4: return { bytes: input.slice(0, at), edit: `truncate to ${at}` };
    case 5: return { bytes: Uint8Array.from([...input, ...rng.bytes(rng.int(1, 8))]), edit: 'append bytes' };
    default: return { bytes: splice(at, 0, varintBytes(rng)), edit: `insert a varint at ${at}` };
  }
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON value of mixed, often wrong, types: nested arrays and objects, edge numbers, odd keys and text. */
export const jsonValue = (rng: Rng, depth = 3): Json => {
  const scalar = (): Json => rng.pick<() => Json>([
    () => null, () => true, () => false, () => '', () => '{', () => '[]', () => unicodeText(rng, 4),
    () => rng.pick(SAFE_COUNTERS), () => rng.pick(UNSAFE_COUNTERS), () => -0,
  ])();
  if (depth <= 0 || rng.bool(0.5)) return scalar();
  if (rng.bool()) return Array.from({ length: rng.int(0, 3) }, () => jsonValue(rng, depth - 1));
  const keys = ['id', 'key', 'card', 'count', 'setId', 'nonce', '__proto__', 'constructor', 'toString', unicodeText(rng, 3)];
  return Object.fromEntries(Array.from({ length: rng.int(0, 3) }, () => [rng.pick(keys), jsonValue(rng, depth - 1)]));
};

/** Replaces one randomly chosen node (or the root) of a JSON value, returning the new value and its path. */
export const replaceSomewhere = (rng: Rng, root: unknown, replacement: unknown): { value: unknown; path: string[] } => {
  const path: string[] = [];
  const visit = (node: unknown): unknown => {
    const children = node && typeof node === 'object' ? Object.keys(node) : [];
    if (children.length === 0 || rng.bool(0.3)) return replacement;
    const key = rng.pick(children);
    path.push(key);
    if (Array.isArray(node)) return node.map((child, i) => (String(i) === key ? visit(child) : child));
    // defineProperty keeps a "__proto__" key an own property, as JSON.parse makes it.
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) Object.defineProperty(copy, k, { value: k === key ? visit(v) : v, enumerable: true, writable: true, configurable: true });
    return copy;
  };
  return { value: visit(root), path };
};

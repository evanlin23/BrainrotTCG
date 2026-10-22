/**
 * Bounded, seeded malformed-input properties for the public proof and profile decoders (#749).
 * Generated negatives only: the signed vectors are mutation starting points and are never changed,
 * and no generated case runs Argon2 (verification gets a ticket function that refuses to run).
 * A decoder may accept structure that is not a verified proof, so the signature checks stay explicit.
 */
import { describe, expect, it } from 'vitest';
import vectors from '../../spec/vectors.json';
import { getSet } from '../content/sets';
import { concatBytes, decodeVarint, encodeVarint, fromBase64Url, toBase64Url, trimAsciiSpace, utf8 } from './bytes';
import { normalizeName, publicKeyFromSecret } from './identity';
import { decodeProof, ProofError, signProof, verifyProof, type ProofRule, type PullProof } from './proof';
import { checkProfile, decodeProfile, MAX_PROFILE_TICKETS, PROFILE_HIGHLIGHTS, type ProfileProof } from './profile';
import {
  forAll, INVALID_UTF8, mutateBytes, SAFE_COUNTERS, seededRng, unicodeText, varintBytes, type Rng,
} from '../test/property';

const lookup = (id: string, version: number) => getSet(id, version);
const PROOFS = vectors.valid.map((v) => v.proof);
const PROFILES = vectors.profiles.map((p) => p.profile);
const NOT_TICKETED = new Error('a generated case reached the ticket function');
const refuseTicket = () => Promise.reject(NOT_TICKETED);
/** Rules a changed but well-framed proof must fail on before any pack is derived. */
const CHEAP_RULES: ProofRule[] = ['name', 'publicKey', 'signature'];

const u8 = (...values: number[]) => Uint8Array.of(...values);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A proof's bytes with its nonce field replaced by raw varint bytes. */
const withNonceBytes = (p: PullProof, varint: Uint8Array) => {
  const id = utf8(p.setId);
  const name = utf8(p.name);
  return concatBytes(u8(1, id.length), id, u8(p.setVersion >> 8, p.setVersion & 255), p.publicKey, varint, u8(name.length), name, p.signature);
};

/** The proof's bytes written straight from spec/PULL_SPEC.md, without the encoder's name normalisation. */
const rawProof = (p: PullProof) => withNonceBytes(p, encodeVarint(p.nonce));

/** The profile's bytes from the spec layout: the set table is the sets in order of first use. */
const rawProfile = (p: ProfileProof) => {
  const table: { setId: string; setVersion: number }[] = [];
  const indexOf = (run: { setId: string; setVersion: number }) => {
    const i = table.findIndex((t) => t.setId === run.setId && t.setVersion === run.setVersion);
    return i >= 0 ? i : table.push({ setId: run.setId, setVersion: run.setVersion }) - 1;
  };
  const runs = p.runs.map((run) => concatBytes(encodeVarint(indexOf(run)), encodeVarint(run.count)));
  const name = utf8(p.name);
  return concatBytes(
    u8(1), p.publicKey, u8(name.length), name, u8(table.length),
    ...table.map((t) => concatBytes(u8(utf8(t.setId).length), utf8(t.setId), u8(t.setVersion >> 8, t.setVersion & 255))),
    encodeVarint(runs.length), ...runs, encodeVarint(p.xp), u8(p.highlights.length), ...p.highlights.map((n) => encodeVarint(n)), p.signature,
  );
};

/** Calls `fn`; returns its result, or the ProofError it threw. Any other exception fails the case. */
const attempt = <T>(fn: () => T): T | ProofError => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ProofError) return error;
    throw Object.assign(new Error(`threw ${String(error)} instead of a ProofError`), { cause: error });
  }
};

const expectDecodeError = (result: unknown) => {
  expect(result).toBeInstanceOf(ProofError);
  expect((result as ProofError).rule).toBe('decode');
};

/** A changed proof that still decodes must fail a cheap rule; reaching the ticket function would be a forgery. */
const expectProofUnverified = async (text: string) => {
  const error = await verifyProof(text, lookup, refuseTicket).then(() => null, (e: unknown) => e);
  if (error === NOT_TICKETED) throw new Error('changed proof passed name, key and signature checks');
  expect(error).toBeInstanceOf(ProofError);
  expect(CHEAP_RULES).toContain((error as ProofError).rule);
};

const expectProfileUnverified = (text: string) => {
  const error = attempt(() => checkProfile(text, lookup));
  expect(error).toBeInstanceOf(ProofError);
  expect(CHEAP_RULES).toContain((error as ProofError).rule);
};

type Decode<T> = (text: string) => T;

/** How many cases a property's decoder accepted and rejected, so a test can show neither side is empty. */
interface Outcomes { accepted: number; rejected: number }
const expectBothOutcomes = ({ accepted, rejected }: Outcomes) => {
  expect(accepted, 'some generated cases decode').toBeGreaterThan(0);
  expect(rejected, 'some generated cases are refused').toBeGreaterThan(0);
};

/** Random edits of signed proofs: a clean decode error, or canonical bytes that fail verification. */
const proofEditProperty = async (outcomes: Outcomes, decode: Decode<PullProof>) => forAll(
  'proof byte edits',
  { seed: 749_001, runs: 300 },
  (rng) => {
    const original = fromBase64Url(rng.pick(PROOFS));
    return { original, ...mutateBytes(rng, original) };
  },
  async ({ original, bytes }) => {
    const text = toBase64Url(bytes);
    const result = attempt(() => decode(text));
    if (result instanceof ProofError) { outcomes.rejected++; return expectDecodeError(result); }
    outcomes.accepted++;
    expect(same(rawProof(result), bytes), 'accepted bytes are the canonical encoding of what was decoded').toBe(true);
    if (!same(bytes, original)) await expectProofUnverified(text);
  },
);

const profileEditProperty = async (outcomes: Outcomes, decode: Decode<ProfileProof>) => forAll(
  'profile byte edits',
  { seed: 749_002, runs: 200 },
  (rng) => {
    const original = fromBase64Url(rng.pick(PROFILES));
    return { original, ...mutateBytes(rng, original) };
  },
  ({ original, bytes }) => {
    const text = toBase64Url(bytes);
    const result = attempt(() => decode(text));
    if (result instanceof ProofError) { outcomes.rejected++; return expectDecodeError(result); }
    outcomes.accepted++;
    expect(same(rawProfile(result), bytes), 'accepted bytes are the canonical encoding of what was decoded').toBe(true);
    if (!same(bytes, original)) expectProfileUnverified(text);
  },
);

/** An injected mistake: a decoder that forgot the trailing-bytes check and reads the longest valid prefix. */
const ignoringTrailingBytes = <T>(decode: Decode<T>): Decode<T> => (text) => {
  const bytes = fromBase64Url(trimAsciiSpace(text));
  for (let n = bytes.length; n > 0; n--) {
    try {
      return decode(toBase64Url(bytes.subarray(0, n)));
    } catch { /* try a shorter prefix */ }
  }
  throw new ProofError('decode', 'nothing decodes');
};

describe('proof decoder properties', () => {
  it('decodes every signed vector to exactly its bytes', () => {
    for (const text of PROOFS) expect(toBase64Url(rawProof(decodeProof(text)))).toBe(text);
  });

  it('rejects every truncation of every signed vector, as bytes and as text', () => {
    for (const text of PROOFS) {
      const bytes = fromBase64Url(text);
      for (let n = 0; n < bytes.length; n++) expectDecodeError(attempt(() => decodeProof(toBase64Url(bytes.subarray(0, n)))));
      for (let n = 0; n < text.length; n++) expectDecodeError(attempt(() => decodeProof(text.slice(0, n))));
    }
  });

  it('turns random byte edits into decode errors or canonical, unverified proofs', async () => {
    const outcomes = { accepted: 0, rejected: 0 };
    await proofEditProperty(outcomes, decodeProof);
    expectBothOutcomes(outcomes);
  });

  it('frames the nonce varint strictly', async () => {
    const outcomes = { accepted: 0, rejected: 0 };
    await forAll(
      'proof nonce varints',
      { seed: 749_003, runs: 400 },
      (rng) => ({ text: rng.pick(PROOFS), varint: varintBytes(rng) }),
      async ({ text, varint }) => {
        const p = decodeProof(text);
        const bytes = withNonceBytes(p, varint);
        const alone = (() => { try { return decodeVarint(varint, 0); } catch { return null; } })();
        const result = attempt(() => decodeProof(toBase64Url(bytes)));
        outcomes[result instanceof ProofError ? 'rejected' : 'accepted']++;
        if (alone && alone.next === varint.length) {
          expect(same(encodeVarint(alone.value), varint), 'only the minimal encoding decodes').toBe(true);
          expect(result).not.toBeInstanceOf(ProofError);
          expect((result as PullProof).nonce).toBe(alone.value);
          if (alone.value !== p.nonce) await expectProofUnverified(toBase64Url(bytes));
        } else if (!(result instanceof ProofError)) {
          expect(same(rawProof(result), bytes)).toBe(true);
        }
      },
    );
    expectBothOutcomes(outcomes);
  });

  it('reads nonces up to 2^53-1 and refuses the varints past it', () => {
    const p = decodeProof(PROOFS[0]);
    const withNonce = (varint: Uint8Array) => withNonceBytes(p, varint);
    for (const nonce of SAFE_COUNTERS) expect(decodeProof(toBase64Url(withNonce(encodeVarint(nonce)))).nonce).toBe(nonce);
    const past = [
      [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10], // 2^53
      [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f], // 2^56 - 1
      [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01], // nine bytes
      [0x81, 0x00], // not minimal
    ];
    for (const varint of past) expectDecodeError(attempt(() => decodeProof(toBase64Url(withNonce(Uint8Array.from(varint))))));
  });

  it('keeps any Unicode name the signer normalised, and refuses invalid UTF-8', () => forAll(
    'proof names',
    { seed: 749_004, runs: 40 },
    (rng) => ({ name: unicodeText(rng), bad: rng.pick(INVALID_UTF8), at: rng.int(0, 4) }),
    async ({ name, bad, at }) => {
      const base = decodeProof(PROOFS[0]);
      const secretKey = new Uint8Array(32).fill(0x49); // disposable test key, never a player's
      const signed = signProof({ setId: base.setId, setVersion: base.setVersion, publicKey: publicKeyFromSecret(secretKey), nonce: 3, name }, secretKey);
      const text = toBase64Url(rawProof(signed));
      expect(decodeProof(text).name).toBe(normalizeName(name));
      // Every cheap check passes, so verification goes on to the ticket function.
      await expect(verifyProof(text, lookup, refuseTicket)).rejects.toBe(NOT_TICKETED);
      const nameBytes = utf8(signed.name);
      const broken = concatBytes(nameBytes.subarray(0, at), Uint8Array.from(bad), nameBytes.subarray(at));
      const head = rawProof({ ...signed, name: '' }).subarray(0, -65);
      expectDecodeError(attempt(() => decodeProof(toBase64Url(concatBytes(head, u8(broken.length), broken, signed.signature)))));
    },
  ));

  it('trims only ASCII whitespace around the text and refuses any other character', () => forAll(
    'proof text edits',
    { seed: 749_005, runs: 200 },
    (rng) => {
      const text = rng.pick(PROOFS);
      const pad = () => Array.from({ length: rng.int(0, 3) }, () => rng.pick([' ', '\t', '\r', '\n'])).join('');
      if (rng.bool(0.3)) return { text, edited: `${pad()}${text}${pad()}`, accepted: true };
      const at = rng.bool(0.3) ? rng.pick([0, text.length]) : rng.int(1, text.length - 1);
      const insert = rng.pick(['=', '+', '/', '.', ' ', '\t', ' ', '﻿', '　', 'é', '%', '\u0000']);
      // A space or tab only trims at either end.
      const accepted = (at === 0 || at === text.length) && [' ', '\t'].includes(insert);
      return { text, edited: text.slice(0, at) + insert + text.slice(at), accepted };
    },
    ({ text, edited, accepted }) => {
      const result = attempt(() => decodeProof(edited));
      if (accepted) expect(result).toEqual(decodeProof(text));
      else expectDecodeError(result);
    },
  ));

  it('detects an injected parser mistake (no trailing-bytes check), naming the seed', async () => {
    await expect(proofEditProperty({ accepted: 0, rejected: 0 }, ignoringTrailingBytes(decodeProof))).rejects.toThrow(/seed 749001, case \d+ of 300/);
  });
});

/** A profile byte string built field by field, each field valid or not by chance. */
const generatedProfile = (rng: Rng) => {
  const sets = [['base', 1], ['base', 2], ['é', 1], ['x'.repeat(64), 65535]] as const;
  const setCount = rng.pick([0, 1, 2, 3, 65, 255]);
  const table = Array.from({ length: Math.min(setCount, 4) }, (_, i) => {
    const [id, version] = rng.bool(0.85) ? sets[i % sets.length] : rng.pick([['', 1], ['y'.repeat(65), 1], [sets[0][0], sets[0][1]]] as const);
    return concatBytes(u8(utf8(id).length), utf8(id), u8(version >> 8, version & 255));
  });
  const runCount = rng.pick([0, 1, 2, 3, Number.MAX_SAFE_INTEGER]);
  const counts = [1, 2, 5, 99_999, MAX_PROFILE_TICKETS, MAX_PROFILE_TICKETS + 1, 0, Number.MAX_SAFE_INTEGER];
  const runs = Array.from({ length: Math.min(runCount, 3) }, (_, i) => concatBytes(
    encodeVarint(rng.bool(0.8) ? Math.min(i, Math.max(0, table.length - 1)) : rng.pick([0, 1, 5, Number.MAX_SAFE_INTEGER])),
    rng.bool(0.1) ? varintBytes(rng) : encodeVarint(rng.pick(counts)),
  ));
  const highlightCount = rng.pick([0, 1, 2, PROFILE_HIGHLIGHTS, PROFILE_HIGHLIGHTS + 1, 255]);
  const highlights = Array.from({ length: Math.min(highlightCount, 6) }, (_, i) => encodeVarint(rng.bool(0.8) ? i : rng.pick([0, 99_999, Number.MAX_SAFE_INTEGER])));
  const name = rng.bool(0.9) ? utf8(unicodeText(rng, 6)) : Uint8Array.from(rng.pick(INVALID_UTF8));
  return concatBytes(
    u8(rng.bool(0.95) ? 1 : rng.pick([0, 2, 255])), rng.bytes(32), u8(name.length), name, u8(setCount), ...table,
    encodeVarint(runCount), ...runs, rng.bool(0.9) ? encodeVarint(rng.pick(SAFE_COUNTERS)) : varintBytes(rng),
    u8(highlightCount), ...highlights, rng.bytes(rng.pick([64, 64, 64, 0, 63, 65])),
  );
};

describe('profile decoder properties', () => {
  it('decodes every signed vector to exactly its bytes', () => {
    for (const text of PROFILES) expect(toBase64Url(rawProfile(decodeProfile(text)))).toBe(text);
  });

  it('rejects every truncation of every signed vector', () => {
    for (const text of PROFILES) {
      const bytes = fromBase64Url(text);
      for (let n = 0; n < bytes.length; n++) expectDecodeError(attempt(() => decodeProfile(toBase64Url(bytes.subarray(0, n)))));
    }
  });

  it('turns random byte edits into decode errors or canonical, unverified profiles', async () => {
    const outcomes = { accepted: 0, rejected: 0 };
    await profileEditProperty(outcomes, decodeProfile);
    expectBothOutcomes(outcomes);
  });

  it('admits generated framing only within the documented limits', async () => {
    const outcomes = { accepted: 0, rejected: 0 };
    await forAll(
      'generated profile framing',
      { seed: 749_006, runs: 400 },
      (rng) => generatedProfile(rng),
      (bytes) => {
        const result = attempt(() => decodeProfile(toBase64Url(bytes)));
        if (result instanceof ProofError) { outcomes.rejected++; return expectDecodeError(result); }
        outcomes.accepted++;
        const total = result.runs.reduce((n, r) => n + r.count, 0);
        expect(result.runs.length).toBeGreaterThan(0);
        expect(total).toBeLessThanOrEqual(MAX_PROFILE_TICKETS);
        expect(result.highlights).toHaveLength(Math.min(PROFILE_HIGHLIGHTS, total));
        expect(new Set(result.highlights).size).toBe(result.highlights.length);
        for (const n of result.highlights) expect(n).toBeLessThan(total);
        expect(same(rawProfile(result), bytes)).toBe(true);
        // Random keys and signatures: structure is not authenticity.
        expectProfileUnverified(toBase64Url(bytes));
      },
    );
    expectBothOutcomes(outcomes);
  });

  it('detects an injected parser mistake (no trailing-bytes check), naming the seed', async () => {
    await expect(profileEditProperty({ accepted: 0, rejected: 0 }, ignoringTrailingBytes(decodeProfile))).rejects.toThrow(/seed 749002, case \d+ of 200/);
  });
});

describe('property harness', () => {
  it('draws the same values for the same seed', () => {
    const draw = (seed: number) => { const rng = seededRng(seed); return Array.from({ length: 8 }, () => rng.next()); };
    expect(draw(749)).toEqual(draw(749));
    expect(draw(749)).not.toEqual(draw(750));
  });
});

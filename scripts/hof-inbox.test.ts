import { describe, expect, it } from 'vitest';
import vectors from '../spec/vectors.json';
import { getSet } from '../src/content/sets/index.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeProof, encodeProof, pullId, signProof, utf8 } from '../src/engine/index.ts';
import { hallOfFameEvent } from '../src/game/nostrInbox.ts';
import { addRanges, buildSkipLine, clipRanges, deferredFrom, everyRelayFailed, logSafeError, newestGap, oldestGap, olderReadLine, parseReadRanges, parseSeenCache, probeLine, processInbox, rangeRead, relayReadLine, seenCacheText, type InboxContext } from './hof-inbox.ts';

const byNote = (note: string) => vectors.valid.find((v) => v.note === note)!.proof;
const fourOfAKind = byNote('mined 4 of a Kind'); // qualifies
const pair = byNote('simple'); // real, doesn't qualify
const idOf = (proof: string) => pullId(decodeProof(proof));
/** The same 4 of a Kind, signed again with the vectors' key under a display name that isn't allowed. */
const blockedName = (() => {
  const { setId, setVersion, publicKey, nonce } = decodeProof(fourOfAKind);
  return encodeProof(signProof({ setId, setVersion, publicKey, nonce, name: 'xXfuckXx' }, sha256(utf8('brainrot-tcg/vector-key/1'))));
})();

const context = (overrides: Partial<InboxContext> = {}) => {
  const filedProofs: string[] = [];
  const ctx: InboxContext = {
    seen: new Set(),
    filed: new Set(),
    budget: 10,
    maxFiled: 10,
    lookup: getSet,
    file: async (proof) => {
      filedProofs.push(proof);
    },
    ...overrides,
  };
  return { ctx, filedProofs };
};

describe('Hall of Fame inbox', () => {
  it('files a qualifying pull once, even when it arrives twice', async () => {
    const { ctx, filedProofs } = context();
    const events = [hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 1000), hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 2000)];
    expect((await processInbox(events, ctx)).added).toBe(1);
    expect(filedProofs).toEqual([fourOfAKind]);
    // A later run sees nothing new.
    expect((await processInbox(events, ctx)).added).toBe(0);
  });

  it('ignores pulls that do not qualify, do not verify, or are already in the Hall of Fame', async () => {
    const forged = fourOfAKind.slice(0, -4) + (fourOfAKind.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const { ctx, filedProofs } = context({ filed: new Set([idOf(byNote('mined 3 of a Kind'))]) });
    const events = [
      hallOfFameEvent(pair, idOf(pair)),
      hallOfFameEvent(forged, 'forged'),
      hallOfFameEvent(byNote('mined 3 of a Kind'), idOf(byNote('mined 3 of a Kind'))),
      { ...hallOfFameEvent(fourOfAKind, idOf(fourOfAKind)), sig: '00'.repeat(64) }, // broken transport signature
    ];
    expect((await processInbox(events, ctx)).added).toBe(0);
    expect(filedProofs).toEqual([]);
  });

  it("sets aside a pull whose display name isn't allowed without checking it or spending budget", async () => {
    const log: string[] = [];
    const { ctx, filedProofs } = context({ budget: 1, log: (line) => log.push(line) });
    const events = [hallOfFameEvent(blockedName, idOf(blockedName), 1000), hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 2000)];
    expect(await processInbox(events, ctx)).toEqual({ added: 1, deferred: 0 });
    expect(filedProofs).toEqual([fourOfAKind]);
    expect(ctx.seen.has(events[0].id)).toBe(true);
    expect(log).toEqual([`${events[0].id}: display name isn't allowed; not filed`]);
  });

  it('stops at the budget and leaves the rest for the next run', async () => {
    const { ctx } = context({ budget: 1 });
    const events = [hallOfFameEvent(pair, idOf(pair), 1000), hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 2000)];
    expect(await processInbox(events, ctx)).toEqual({ added: 0, deferred: 1 });
    ctx.budget = 1;
    expect((await processInbox(events, ctx)).added).toBe(1);
  });

  it('files at most maxFiled per run and leaves the rest for the next run', async () => {
    const { ctx, filedProofs } = context({ maxFiled: 0 });
    const events = [hallOfFameEvent(fourOfAKind, idOf(fourOfAKind))];
    expect(await processInbox(events, ctx)).toEqual({ added: 0, deferred: 1 });
    ctx.maxFiled = 1;
    expect((await processInbox(events, ctx)).added).toBe(1);
    expect(filedProofs).toEqual([fourOfAKind]);
  });

  it("skips a real, qualifying pull that wouldn't make the list, and doesn't check it again", async () => {
    let asked = 0;
    const { ctx, filedProofs } = context({ accepts: () => (asked++, false) });
    const events = [hallOfFameEvent(fourOfAKind, idOf(fourOfAKind))];
    expect((await processInbox(events, ctx)).added).toBe(0);
    expect((await processInbox(events, ctx)).added).toBe(0);
    expect(filedProofs).toEqual([]);
    expect(asked).toBe(1);
  });

  describe('intake floor (score hint)', () => {
    const counting = () => {
      let checked = 0;
      const lookup: InboxContext['lookup'] = (...args) => (checked++, getSet(...args));
      return { lookup, checked: () => checked };
    };

    it("sets aside a pull that claims a score at or below the floor without re-deriving it or spending budget", async () => {
      const { lookup, checked } = counting();
      const lines: string[] = [];
      const { ctx, filedProofs } = context({ floor: 50_000, budget: 1, lookup, log: (l) => void lines.push(l) });
      const low = hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 1000, 50_000);
      const real = hallOfFameEvent(byNote('mined 3 of a Kind'), idOf(byNote('mined 3 of a Kind')), 2000, 60_000);
      // The skipped event costs nothing, so the one budgeted check goes to the next event.
      expect(await processInbox([low, real], ctx)).toEqual({ added: 0, deferred: 0 });
      expect(checked()).toBe(1);
      expect(filedProofs).toEqual([]); // the 3 of a Kind claimed 60,000 but doesn't qualify once verified
      expect(ctx.seen.has(low.id)).toBe(true);
      expect(ctx.filed.has(idOf(fourOfAKind))).toBe(false);
      expect(lines.some((l) => l.startsWith(`${low.id}: claims 50000`))).toBe(true);
    });

    it('verifies in full a pull that claims more than the floor, so a false claim gains nothing', async () => {
      const { lookup, checked } = counting();
      const { ctx, filedProofs } = context({ floor: 50_000, lookup });
      const events = [hallOfFameEvent(pair, idOf(pair), 1000, 10 ** 12), hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 2000, 10 ** 12)];
      expect((await processInbox(events, ctx)).added).toBe(1);
      expect(checked()).toBe(2);
      expect(filedProofs).toEqual([fourOfAKind]); // the pair claimed a fortune and was still turned down
    });

    it("ignores the hint while there's room, and handles events without one (older clients) as before", async () => {
      for (const floor of [null, undefined]) {
        const { ctx, filedProofs } = context({ floor });
        expect((await processInbox([hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 1000, 0)], ctx)).added).toBe(1);
        expect(filedProofs).toEqual([fourOfAKind]);
      }
      const { ctx, filedProofs } = context({ floor: 10 ** 12 });
      expect((await processInbox([hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 1000)], ctx)).added).toBe(1);
      expect(filedProofs).toEqual([fourOfAKind]);
    });

    it("can't be used to block someone else's pull: a low-claim copy is a separate event", async () => {
      const { ctx, filedProofs } = context({ floor: 1000 });
      const copy = hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 1000, 1);
      const real = hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 2000, 10 ** 9);
      expect((await processInbox([copy, real], ctx)).added).toBe(1);
      expect(filedProofs).toEqual([fourOfAKind]);
    });
  });

  it('retries next run when filing on GitHub fails', async () => {
    let fail = true;
    const { ctx } = context({
      file: async () => {
        if (fail) throw new Error('GitHub 502');
      },
    });
    const events = [hallOfFameEvent(fourOfAKind, idOf(fourOfAKind))];
    expect((await processInbox(events, ctx)).added).toBe(0);
    fail = false;
    expect((await processInbox(events, ctx)).added).toBe(1);
  });

  it('logs untrusted error text on one capped line, so it cannot start a workflow command', async () => {
    const hostile = `bad\n::error::x\r\n::add-mask::y\u2028::warning::z\0${'a'.repeat(1000)}`;
    const lines: string[] = [];
    const log = (line: string) => void lines.push(line);
    const events = [hallOfFameEvent(fourOfAKind, idOf(fourOfAKind))];
    // A proof that doesn't verify (an unknown set's name comes from the proof itself), then a filing error.
    const lookup = () => {
      throw new Error(hostile);
    };
    await processInbox(events, context({ log, lookup }).ctx);
    await processInbox(events, context({ log, file: async () => lookup() }).ctx);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
      expect(line).not.toMatch(/^\s*::/);
      expect(line).toContain('bad ::error::x ::add-mask::y ::warning::z a');
      expect(line.length).toBeLessThan(400);
    }
  });
});

describe('Hall of Fame seen cache (hall-of-fame.ts inbox)', () => {
  const now = 1_800_000_000;
  const since = now - 7 * 86_400;

  it('reads ids with their times, bare ids from older caches as made now, and starts empty on anything else', () => {
    expect(parseSeenCache(JSON.stringify([['a', 5], 'b', ['c', 1.5], ['d'], 7, null]), now)).toEqual(new Map([['a', 5], ['b', now]]));
    for (const text of ['', 'not json', '{"a":1}', 'null']) expect(parseSeenCache(text, now)).toEqual(new Map());
  });

  it('keeps every handled id inside the window, newest first, and none from before it', () => {
    const at = new Map([['old', since - 1], ['edge', since], ['new', now - 10], ['later', now + 3600]]);
    expect(JSON.parse(seenCacheText(['old', 'edge', 'new', 'later', 'undated'], at, since, now, 10))).toEqual([['later', now], ['undated', now], ['new', now - 10], ['edge', since]]);
  });

  it('drops the oldest past the cap, saving a future date as now', () => {
    const at = new Map([['a', now - 30], ['b', now - 20], ['future', now + 86_400], ['c', now - 10]]);
    expect(JSON.parse(seenCacheText(at.keys(), at, since, now, 2))).toEqual([['future', now], ['c', now - 10]]);
    // Round trip.
    const text = seenCacheText(at.keys(), at, since, now, 10);
    expect(parseSeenCache(text, now)).toEqual(new Map([...at, ['future', now]]));
  });

  it("doesn't let far-future ids at the cap push out real ones read later", () => {
    // A run fills the cache with junk dated 2049 (relays drop it soon after, e.g. by NIP-40 expiry).
    const junk = new Map([['junk-1', 2_500_000_000], ['junk-2', 2_500_000_000]]);
    const first = parseSeenCache(seenCacheText(junk.keys(), junk, since, now, 2), now);
    // An hour later relays no longer serve the junk, and a real event arrives.
    const later = now + 3600;
    const seenAt = new Map([...first, ['real', later - 60]]);
    expect(JSON.parse(seenCacheText(seenAt.keys(), seenAt, later - 7 * 86_400, later, 2)).map(([id]: [string]) => id)).toContain('real');
  });
});

describe('Hall of Fame relay outage (hall-of-fame.ts inbox)', () => {
  const down = { relay: 'wss://a', count: 0, error: 'connection failed' };
  it('is an outage only when every relay failed without sending an event', () => {
    expect(everyRelayFailed([down, { ...down, relay: 'wss://b', error: 'timed out' }])).toBe(true);
    expect(everyRelayFailed([down, { relay: 'wss://b', count: 0 }])).toBe(false); // answered with nothing
    expect(everyRelayFailed([down, { relay: 'wss://b', count: 3, error: 'timed out' }])).toBe(false); // read, then failed
    expect(everyRelayFailed([])).toBe(false);
  });
});

describe('Hall of Fame relay log lines (hall-of-fame.ts inbox and probe)', () => {
  const hostile = `blocked\n::error::x\r\n::add-mask::y\u2028\u001b[31m::warning::z\u200b${'a'.repeat(1000)}`;
  const relay = 'wss://relay.example';
  const clean = (line: string) => {
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    expect(line).toContain('blocked ::error::x ::add-mask::y [31m::warning::z a');
    expect(line.length).toBeLessThan(600);
  };

  it("keeps a relay's CLOSED reason on one capped line", () => {
    expect(relayReadLine({ relay, count: 3 })).toBe(`${relay}: 3 events`);
    const line = relayReadLine({ relay, count: 0, error: hostile });
    expect(line.startsWith(`${relay}: 0 events (blocked ::error::x`)).toBe(true);
    clean(line);
  });

  it("keeps a relay's OK message and read error on one capped line", () => {
    expect(probeLine(relay, { relay, ok: true, message: '' }, { count: 1 })).toBe(`${relay}: write ok, read ok`);
    expect(probeLine(relay, { relay, ok: false, message: 'timed out' }, { count: 0 })).toBe(`${relay}: write failed (timed out), read failed (not found)`);
    const line = probeLine(relay, { relay, ok: false, message: hostile }, { count: 0, error: hostile });
    expect(line.split('failed (blocked ::error::x')).toHaveLength(3);
    clean(line);
  });
});

describe('Hall of Fame log lines and the legacy ##[command] form', () => {
  // The runner runs `##[command]` anywhere in a line, and `::command::` at the start of one.
  const hostile = ['x##[error title=x]y', '::error::x', '::add-mask::y ##[add-mask]z', '#\u200b#[warning]w', '#\ufe0f#\u034f[stop-commands]s', 'a##[##[b'];
  const inert = (line: string) => {
    expect(line).not.toContain('##[');
    expect(line).not.toMatch(/^\s*::/);
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u);
  };

  it('puts a space inside ##[ anywhere in the text, keeping the rest readable', () => {
    expect(logSafeError('x##[error title=x]y')).toBe('x## [error title=x]y');
    expect(logSafeError(new Error('a##[##[b'))).toBe('a## [## [b');
    expect(logSafeError('#\u200b#[warning]w')).toBe('# #[warning]w');
    expect(logSafeError(`${'a'.repeat(198)}##[error]x`)).toBe(`${'a'.repeat(198)}##…`);
    for (const text of hostile) expect(logSafeError(text)).not.toContain('##[');
  });

  it('keeps relay, probe, inbox and build lines inert', async () => {
    const relay = 'wss://relay.example';
    const lines: string[] = [];
    for (const text of hostile) {
      lines.push(relayReadLine({ relay, count: 0, error: text }));
      lines.push(probeLine(relay, { relay, ok: false, message: text }, { count: 0, error: text }));
      lines.push(buildSkipLine(42, `This pull didn't verify: ${text}`));
      const lookup = () => {
        throw new Error(`Unknown set ${text}`);
      };
      await processInbox([hallOfFameEvent(fourOfAKind, idOf(fourOfAKind))], context({ log: (line) => void lines.push(line), lookup }).ctx);
    }
    expect(lines).toHaveLength(hostile.length * 4);
    expect(lines[0]).toBe(`${relay}: 0 events (x## [error title=x]y)`);
    expect(lines[2]).toBe("#42: skipped (This pull didn't verify: x## [error title=x]y)");
    expect(lines[3]).toMatch(/^[0-9a-f]{64}: didn't verify \(Unknown set x## \[error title=x\]y\)$/);
    for (const line of lines) inert(line);
  });
});

describe('read ranges (#999)', () => {
  it('merges ranges that overlap or touch, and clips them', () => {
    expect(addRanges([[10, 20], [40, 50]], [[21, 25], [30, 45], [5, 3]])).toEqual([[10, 25], [30, 50]]);
    expect(clipRanges([[10, 25], [30, 50]], 20, 35)).toEqual([[20, 25], [30, 35]]);
    expect(clipRanges([[10, 25]], 30, 40)).toEqual([]);
  });

  it('finds the newest part of the window not read through', () => {
    expect(newestGap([], 0, 100)).toEqual([0, 100]);
    expect(newestGap([[60, 100]], 0, 100)).toEqual([0, 59]);
    expect(newestGap([[0, 20], [60, 100]], 0, 100)).toEqual([21, 59]);
    expect(newestGap([[0, 20], [60, 80]], 0, 100)).toEqual([81, 100]);
    expect(newestGap([[-50, 150]], 0, 100)).toBeUndefined();
  });

  it('finds the oldest part of the window not read through', () => {
    expect(oldestGap([], 0, 100)).toEqual([0, 100]);
    expect(oldestGap([[60, 100]], 0, 100)).toEqual([0, 59]);
    expect(oldestGap([[0, 20], [60, 100]], 0, 100)).toEqual([21, 59]);
    expect(oldestGap([[0, 20], [40, 50], [60, 80]], 0, 100)).toEqual([21, 39]);
    expect(oldestGap([[0, 20], [21, 100]], 0, 100)).toBeUndefined();
    expect(oldestGap([[-50, 150]], 0, 100)).toBeUndefined();
  });

  it('counts a read stopped at `more` from just above it, a full read all the way, and one that failed before a page nowhere', () => {
    expect(rangeRead({}, 0, 100)).toEqual([[0, 100]]);
    expect(rangeRead({ more: 60 }, 0, 100)).toEqual([[61, 100]]);
    expect(rangeRead({ more: 100 }, 0, 100)).toEqual([]);
    expect(rangeRead({ error: 'timed out' }, 0, 100)).toEqual([]);
    // The pages it finished before it failed.
    expect(rangeRead({ error: 'timed out', more: 60 }, 0, 100)).toEqual([[61, 100]]);
  });

  it('reads the ranges file for the given relays only, and anything malformed as nothing read', () => {
    const text = JSON.stringify({ 'wss://a': [[30, 40], [10, 20], [15, 25], ['1', 2], [3], [1.5, 2], [9, 4]], 'wss://gone': [[1, 2]], 'wss://b': 'x' });
    expect([...parseReadRanges(text, ['wss://a', 'wss://b', 'wss://c'])]).toEqual([['wss://a', [[10, 25], [30, 40]]]]);
    for (const bad of ['', 'not json', '[]', 'null', '7']) expect(parseReadRanges(bad, ['wss://a']).size).toBe(0);
  });

  it('places the first deferred event where processInbox stops: oldest first', async () => {
    const events = [3, 1, 2].map((t) => hallOfFameEvent(fourOfAKind, `e${t}`, t * 1000));
    expect(deferredFrom(events, 0)).toBe(Infinity);
    expect(deferredFrom(events, 1)).toBe(3);
    expect(deferredFrom(events, 3)).toBe(1);
    // processInbox with budget for one: the oldest is handled, the other two wait.
    const { ctx } = context({ budget: 1, accepts: () => false });
    const { deferred } = await processInbox(events, ctx);
    expect(deferred).toBe(2);
    expect(deferredFrom(events, deferred)).toBe(2);
    expect([...ctx.seen]).toEqual([events[1].id]);
  });

  it('says when the page cap stopped a read, in a line the harness does not count as a failure', () => {
    expect(relayReadLine({ relay: 'wss://a', count: 4942, more: 60 })).toBe('wss://a: 4942 events, stopped at the page cap');
    expect(olderReadLine({ relay: 'wss://a', count: 258 }, 60)).toBe('wss://a: 258 older events up to 1970-01-01T00:01:00.000Z');
    expect(olderReadLine({ relay: 'wss://a', count: 5000, more: 50 }, 60)).toBe('wss://a: 5000 older events up to 1970-01-01T00:01:00.000Z, stopped at the page cap');
    for (const line of [relayReadLine({ relay: 'wss://a', count: 1, more: 1 }), olderReadLine({ relay: 'wss://a', count: 0, error: 'timed out' }, 60)]) {
      expect(line).not.toMatch(/^wss:\/\/\S+: \d+ events \(/);
    }
  });
});

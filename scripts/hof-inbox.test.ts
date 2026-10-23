import { schnorr } from '@noble/curves/secp256k1.js';
import { describe, expect, it, vi } from 'vitest';
import vectors from '../spec/vectors.json';
import { getSet } from '../src/content/sets/index.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeProof, encodeProof, pullId, signProof, utf8 } from '../src/engine/index.ts';
import { hallOfFameEvent } from '../src/game/nostrInbox.ts';
import { buildSkipLine, logSafeError, parseFiledIndex, probeLine, processInbox, relayReadLine, type InboxContext } from './hof-inbox.ts';

// Count signature checks (schnorr is frozen, so it can't be spied on in place).
vi.mock('@noble/curves/secp256k1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/curves/secp256k1.js')>();
  return { ...actual, schnorr: { ...actual.schnorr, verify: vi.fn(actual.schnorr.verify) } };
});

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

  it("passes over a pull only a kept index calls filed, but doesn't mark its event seen", async () => {
    const id = idOf(fourOfAKind);
    const { ctx, filedProofs } = context({ filed: new Set([id]), unconfirmed: new Set([id]) });
    const event = hallOfFameEvent(fourOfAKind, id, 1000);
    expect((await processInbox([event], ctx)).added).toBe(0);
    expect(ctx.seen.has(event.id)).toBe(false);
    // Once a full listing no longer has it, the same event is filed.
    ctx.filed.clear();
    ctx.unconfirmed!.clear();
    expect((await processInbox([event], ctx)).added).toBe(1);
    expect(filedProofs).toEqual([fourOfAKind]);
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

  it('checks signatures only of events not handled yet, and a failing one stays unhandled (#1000)', async () => {
    const { ctx, filedProofs } = context();
    const good = hallOfFameEvent(fourOfAKind, idOf(fourOfAKind));
    const badSig = { ...good, sig: (good.sig[0] === '0' ? '1' : '0') + good.sig.slice(1) };
    const handled = hallOfFameEvent(pair, idOf(pair));
    ctx.seen.add(handled.id);
    vi.mocked(schnorr.verify).mockClear();
    expect(await processInbox([handled, badSig], ctx)).toEqual({ added: 0, deferred: 0 });
    expect(vi.mocked(schnorr.verify).mock.calls.length).toBe(1);
    expect(ctx.seen.has(badSig.id)).toBe(false);
    // The copy that verifies, read later, is still filed.
    expect(await processInbox([good], ctx)).toEqual({ added: 1, deferred: 0 });
    expect(filedProofs).toEqual([fourOfAKind]);
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

describe('parseFiledIndex (#1000)', () => {
  const now = 1_800_000_000_000;
  const day = 86_400_000;
  const id = idOf(fourOfAKind);
  const text = (data: unknown) => JSON.stringify(data);

  it('reads an index listed within the max age', () => {
    const index = { listedAt: now - day, issues: { 1: [id, 'Combo Miner'], 20: [id, 'xXfuckXx'] } };
    expect(parseFiledIndex(text(index), now, day)).toEqual(index);
    expect(parseFiledIndex(text({ listedAt: now, issues: {} }), now, day)).toEqual({ listedAt: now, issues: {} });
  });

  it.each([
    ['not JSON', '{'],
    ['not an object', '[]'],
    ['too old', text({ listedAt: now - day - 1, issues: {} })],
    ['from the future', text({ listedAt: now + 1, issues: {} })],
    ['without a time', text({ issues: {} })],
    ['without issues', text({ listedAt: now })],
    ['issues as a list', text({ listedAt: now, issues: [] })],
    ['an issue number that is not one', text({ listedAt: now, issues: { '01': [id, 'a'] } })],
    ['an entry without a name', text({ listedAt: now, issues: { 1: [id] } })],
    ['an empty pull id', text({ listedAt: now, issues: { 1: ['', 'a'] } })],
    ['a name that is not text', text({ listedAt: now, issues: { 1: [id, 5] } })],
  ])('reads nothing from an index %s', (_, raw) => {
    expect(parseFiledIndex(raw, now, day)).toBeNull();
  });
});

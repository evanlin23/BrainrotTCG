import { describe, expect, it } from 'vitest';
import vectors from '../spec/vectors.json';
import { getSet } from '../src/content/sets/index.ts';
import { decodeProof, pullId } from '../src/engine/index.ts';
import { hallOfFameEvent } from '../src/game/nostrInbox.ts';
import { buildSkipLine, logSafeError, probeLine, processInbox, relayReadLine, type InboxContext } from './hof-inbox.ts';

const byNote = (note: string) => vectors.valid.find((v) => v.note === note)!.proof;
const fourOfAKind = byNote('mined 4 of a Kind'); // qualifies
const pair = byNote('simple'); // real, doesn't qualify
const idOf = (proof: string) => pullId(decodeProof(proof));

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

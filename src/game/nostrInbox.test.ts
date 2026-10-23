import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../engine/bytes';
import {
  eventByteSize,
  fetchEvents,
  hallOfFameEvent,
  HOF_KIND,
  HOF_TAG,
  isRetainable,
  matchesFilter,
  MAX_EVENT_TAG_ITEMS,
  MAX_EVENT_TAGS,
  MAX_RAW_MESSAGE_CHARS,
  MAX_RELAY_INVALID_MESSAGES,
  MAX_RETAINED_EVENT_BYTES,
  proofFromEvent,
  publishEvent,
  publishUntilAccepted,
  scoreHintFromEvent,
  signEvent,
  verifyEvent,
  type Filter,
  type NostrEvent,
  type SocketFactory,
} from './nostrInbox';

// Count signature checks (schnorr is frozen, so it can't be spied on in place).
vi.mock('@noble/curves/secp256k1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/curves/secp256k1.js')>();
  return { ...actual, schnorr: { ...actual.schnorr, verify: vi.fn(actual.schnorr.verify) } };
});

/** Shaped like a pull link's proof (base64url, 100–400 characters); these tests don't decode it. */
const PROOF = `AQ${'abcXYZ09_-'.repeat(13)}`;

describe('cancelled relay reads', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('opens no connection when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const open = vi.fn<SocketFactory>();
    const result = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://a'], 5000, open, 1, controller.signal);
    expect(open).not.toHaveBeenCalled();
    expect(result).toEqual({ events: [], perRelay: [{ relay: 'wss://a', count: 0, error: 'aborted' }] });
  });

  it.each([0, 1])('closes readyState %s connections immediately and ignores retired callbacks', async (readyState) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const sockets: ReturnType<SocketFactory>[] = [];
    const open: SocketFactory = () => {
      const socket = { readyState, send: vi.fn(), close: vi.fn(), onopen: null, onmessage: null, onerror: null, onclose: null };
      sockets.push(socket);
      return socket;
    };
    const result = fetchEvents({ kinds: [HOF_KIND] }, ['wss://a', 'wss://b'], 5000, open, 1, controller.signal);
    if (readyState === 1) for (const socket of sockets) socket.onopen?.({});
    controller.abort();
    const closed = await result;
    expect(closed.events).toEqual([]);
    expect(closed.perRelay.map((relay) => relay.error)).toEqual(['aborted', 'aborted']);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(2);
    for (const socket of sockets) {
      expect(socket.close).toHaveBeenCalledTimes(1);
      const calls = vi.mocked(socket.send).mock.calls.length;
      socket.onopen?.({});
      socket.onmessage?.({ data: JSON.stringify(['EVENT', 'old', hallOfFameEvent(PROOF, 'late')]) });
      socket.onclose?.({});
      expect(socket.send).toHaveBeenCalledTimes(calls);
      expect(socket.close).toHaveBeenCalledTimes(1);
      if (readyState === 0) expect(socket.send).not.toHaveBeenCalled();
    }
  });

  it('still closes a connection when sending its goodbye throws', async () => {
    const controller = new AbortController();
    const socket = { readyState: 1, send: vi.fn(() => { throw new Error('Send denied'); }), close: vi.fn(), onopen: null, onmessage: null, onerror: null, onclose: null };
    const result = fetchEvents({ kinds: [HOF_KIND] }, ['wss://a'], 5000, () => socket, 1, controller.signal);
    controller.abort();
    expect((await result).perRelay[0].error).toBe('aborted');
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});

type Behaviour = 'accept' | 'refuse' | 'silent' | 'fail';

/**
 * In-memory relays: EVENT gets OK (or a refusal); REQ gets the newest `limit` stored events up to
 * `until` (inclusive, like real relays), then EOSE. `stored` may differ per relay.
 */
const fakeRelays = (behaviour: Record<string, Behaviour>, stored: NostrEvent[] | Record<string, NostrEvent[]> = [], requests: string[] = []): SocketFactory => (url) => {
  const socket = {
    onopen: null as ((e: unknown) => void) | null,
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    onclose: null as ((e: unknown) => void) | null,
    send: (raw: string) => {
      const msg = JSON.parse(raw) as unknown[];
      const reply = (data: unknown[]) => queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(data) }));
      if (msg[0] === 'EVENT' && behaviour[url] === 'accept') reply(['OK', (msg[1] as NostrEvent).id, true, '']);
      if (msg[0] === 'EVENT' && behaviour[url] === 'refuse') reply(['OK', (msg[1] as NostrEvent).id, false, 'blocked: no']);
      if (msg[0] === 'REQ') {
        const filter = msg[2] as Filter;
        requests.push(`${url} until=${filter.until ?? '-'}`);
        const mine = Array.isArray(stored) ? stored : (stored[url] ?? []);
        const page = mine
          .filter((e) => filter.until === undefined || e.created_at <= filter.until)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit ?? Infinity);
        for (const e of page) reply(['EVENT', msg[1], e]);
        reply(['EOSE', msg[1]]);
      }
    },
    close: () => undefined,
  };
  queueMicrotask(() => (behaviour[url] === 'fail' ? socket.onerror?.({}) : socket.onopen?.({})));
  return socket;
};

describe('nostr inbox', () => {
  it('signs NIP-01 events that verify, and rejects any edit', () => {
    const event = hallOfFameEvent(PROOF, 'right-now@1/abc/9', 1_700_000_000_000);
    expect(event.kind).toBe(HOF_KIND);
    expect(event.created_at).toBe(1_700_000_000);
    expect(event.tags).toContainEqual(['t', HOF_TAG]);
    expect(verifyEvent(event)).toBe(true);
    expect(verifyEvent({ ...event, content: event.content.replace('AQ', 'AR') })).toBe(false);
    expect(verifyEvent({ ...event, sig: '00'.repeat(64) })).toBe(false);
    expect(proofFromEvent(event)).toBe(PROOF);
  });

  it('carries an optional score hint that leaves the proof readable', () => {
    const hinted = hallOfFameEvent(PROOF, 'x', 1_700_000_000_000, 4200);
    expect(verifyEvent(hinted)).toBe(true);
    expect(proofFromEvent(hinted)).toBe(PROOF);
    expect(scoreHintFromEvent(hinted)).toBe(4200);
    const plain = hallOfFameEvent(PROOF, 'x');
    expect(JSON.parse(plain.content)).toEqual({ v: 1, proof: PROOF }); // older submissions look exactly like this
    expect(scoreHintFromEvent(plain)).toBeNull();
    for (const score of [-1, 1.5, '4200', null, Number.MAX_SAFE_INTEGER + 1]) expect(scoreHintFromEvent({ ...plain, content: JSON.stringify({ v: 1, proof: PROOF, score }) })).toBeNull();
    expect(scoreHintFromEvent({ ...plain, content: 'not json' })).toBeNull();
  });

  it('uses a fresh key for every submission', () => {
    expect(hallOfFameEvent(PROOF, 'x').pubkey).not.toBe(hallOfFameEvent(PROOF, 'x').pubkey);
  });

  it('only reads submissions in the expected shape', () => {
    const sk = schnorr.utils.randomSecretKey();
    const pubkey = toHex(schnorr.getPublicKey(sk));
    const make = (kind: number, tags: string[][], content: string) => signEvent({ pubkey, created_at: 1, kind, tags, content }, sk);
    const content = (proof: unknown, v = 1) => JSON.stringify({ v, proof });
    expect(proofFromEvent(make(HOF_KIND, [['t', HOF_TAG]], content(PROOF)))).toBe(PROOF);
    expect(proofFromEvent(make(1, [['t', HOF_TAG]], content(PROOF)))).toBeNull(); // wrong kind
    expect(proofFromEvent(make(HOF_KIND, [['t', 'other']], content(PROOF)))).toBeNull(); // wrong tag
    expect(proofFromEvent(make(HOF_KIND, [['t', HOF_TAG]], 'not json'))).toBeNull();
    expect(proofFromEvent(make(HOF_KIND, [['t', HOF_TAG]], content(PROOF, 2)))).toBeNull(); // unknown version
    expect(proofFromEvent(make(HOF_KIND, [['t', HOF_TAG]], content('x'.repeat(5000))))).toBeNull();
    // Padding still decodes, but it wouldn't survive being written into a link and read back.
    expect(proofFromEvent(make(HOF_KIND, [['t', HOF_TAG]], content(`\n${PROOF}`)))).toBeNull();
    expect(proofFromEvent(make(HOF_KIND, [['t', HOF_TAG]], content(`${PROOF} `)))).toBeNull();
    expect(proofFromEvent(make(HOF_KIND, [['t', HOF_TAG]], content(`#/pull/${PROOF}`)))).toBeNull();
  });

  it('rejects events with the wrong field types instead of throwing', () => {
    const sk = schnorr.utils.randomSecretKey();
    const pubkey = toHex(schnorr.getPublicKey(sk));
    // Validly signed, but tags isn't a list of lists: some relays pass this through.
    const odd = signEvent({ pubkey, created_at: 1, kind: HOF_KIND, tags: null as unknown as string[][], content: JSON.stringify({ v: 1, proof: PROOF }) }, sk);
    expect(verifyEvent(odd)).toBe(false);
    expect(proofFromEvent(odd)).toBeNull();
    expect(verifyEvent(null)).toBe(false);
    expect(verifyEvent({ ...hallOfFameEvent(PROOF, 'x'), created_at: 1.5 })).toBe(false);
  });

  it('reports which relays accepted a submission', async () => {
    const event = hallOfFameEvent(PROOF, 'x');
    const relays = ['wss://a', 'wss://b', 'wss://c', 'wss://d'];
    const results = await publishEvent(event, relays, 200, fakeRelays({ 'wss://a': 'accept', 'wss://b': 'refuse', 'wss://c': 'silent', 'wss://d': 'fail' }));
    expect(results.map((r) => [r.relay, r.ok])).toEqual([
      ['wss://a', true],
      ['wss://b', false],
      ['wss://c', false],
      ['wss://d', false],
    ]);
    expect(results[2].message).toBe('timed out');
  });

  it('returns on the first relay that accepts while the others are still sending', async () => {
    const event = hallOfFameEvent(PROOF, 'x');
    const relays = ['wss://a', 'wss://b', 'wss://c'];
    let allSettled = false;
    const { accepted, all } = await publishUntilAccepted(event, relays, 200, fakeRelays({ 'wss://a': 'silent', 'wss://b': 'accept', 'wss://c': 'silent' }));
    void all.then(() => (allSettled = true));
    await Promise.resolve();
    expect(accepted).toEqual({ relay: 'wss://b', ok: true, message: '' });
    expect(allSettled).toBe(false);
  });

  it('lets the other relays finish in the background', async () => {
    const event = hallOfFameEvent(PROOF, 'x');
    const relays = ['wss://a', 'wss://b', 'wss://c'];
    const { accepted, all } = await publishUntilAccepted(event, relays, 200, fakeRelays({ 'wss://a': 'accept', 'wss://b': 'silent', 'wss://c': 'refuse' }));
    expect(accepted?.relay).toBe('wss://a');
    expect((await all).map((r) => [r.relay, r.ok, r.message])).toEqual([
      ['wss://a', true, ''],
      ['wss://b', false, 'timed out'],
      ['wss://c', false, 'blocked: no'],
    ]);
  });

  it('fails only when no relay accepts', async () => {
    const event = hallOfFameEvent(PROOF, 'x');
    const relays = ['wss://a', 'wss://b', 'wss://c'];
    const { accepted, all } = await publishUntilAccepted(event, relays, 200, fakeRelays({ 'wss://a': 'refuse', 'wss://b': 'silent', 'wss://c': 'fail' }));
    expect(accepted).toBeNull();
    expect((await all).map((r) => r.ok)).toEqual([false, false, false]);
  });

  it('merges what every relay returns, once per event', async () => {
    const a = hallOfFameEvent(PROOF, 'a');
    const b = hallOfFameEvent(PROOF, 'b');
    const { events, perRelay } = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://a', 'wss://b'], 200, fakeRelays({ 'wss://a': 'accept', 'wss://b': 'accept' }, [a, b]));
    expect(events.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(perRelay.map((r) => r.count)).toEqual([2, 2]);
  });

  it("keeps the good copy when one relay serves a tampered one", async () => {
    const good = hallOfFameEvent(PROOF, 'x');
    const tampered = { ...good, content: good.content.replace('AQ', 'AR') };
    const { events } = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://bad', 'wss://good'], 200, fakeRelays({ 'wss://bad': 'accept', 'wss://good': 'accept' }, { 'wss://bad': [tampered], 'wss://good': [good] }));
    expect(events).toEqual([good]);
  });

  it('pages back past a burst of newer events, and stops when nothing is new', async () => {
    const old = hallOfFameEvent(PROOF, 'old', 1_000_000);
    const burst = Array.from({ length: 7 }, (_, i) => hallOfFameEvent(PROOF, `junk${i}`, 2_000_000 + i * 1000));
    const requests: string[] = [];
    const relays = fakeRelays({ 'wss://a': 'accept' }, [old, ...burst], requests);
    // One page (the browser's default) only sees the newest three.
    const first = await fetchEvents({ kinds: [HOF_KIND], limit: 3 }, ['wss://a'], 500, relays);
    expect(first.events.map((e) => e.id)).not.toContain(old.id);
    const all = await fetchEvents({ kinds: [HOF_KIND], limit: 3 }, ['wss://a'], 500, relays, 20);
    expect(all.events.map((e) => e.id).sort()).toEqual([old, ...burst].map((e) => e.id).sort());
    expect(requests.length).toBeLessThan(10); // 1 + 4 pages, not 20
  });
});

type MockSocketHandlers = {
  send?: (raw: string, socket: ReturnType<SocketFactory>) => void;
  close?: () => void;
};

const createMockSocket = (handlers: MockSocketHandlers = {}): SocketFactory => () => {
  const socket: ReturnType<SocketFactory> = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (raw: string) => handlers.send?.(raw, socket),
    close: () => handlers.close?.(),
  };
  queueMicrotask(() => socket.onopen?.({}));
  return socket;
};

/** A relay that answers its first REQ with `frames(sub)` (strings sent as is, arrays as JSON), then EOSE. */
const rogueRelay = (frames: (sub: unknown) => unknown[], close?: () => void): SocketFactory =>
  createMockSocket({
    send: (raw, socket) => {
      const msg = JSON.parse(raw) as unknown[];
      if (msg[0] !== 'REQ') return;
      for (const f of [...frames(msg[1]), ['EOSE', msg[1]]]) {
        queueMicrotask(() => socket.onmessage?.({ data: Array.isArray(f) ? JSON.stringify(f) : f }));
      }
    },
    close,
  });

const key = schnorr.utils.randomSecretKey();
const pubkey = toHex(schnorr.getPublicKey(key));
/** A validly signed Hall of Fame event with whatever content and tags. */
const signedHof = (created_at: number, content: string, tags: string[][] = [['t', HOF_TAG]]) =>
  signEvent({ pubkey, created_at, kind: HOF_KIND, tags, content }, key);

const verifyCalls = () => vi.mocked(schnorr.verify).mock.calls.length;

describe('relay ingress boundaries (#621)', () => {
  beforeEach(() => { vi.mocked(schnorr.verify).mockClear(); });

  it('stops a relay that sends more than `limit` events, without verifying the excess', async () => {
    const events = Array.from({ length: 12 }, (_, i) => hallOfFameEvent(PROOF, `pull-${i}`, 1_000_000 + i));
    const result = await fetchEvents({ kinds: [HOF_KIND], limit: 1 }, ['wss://rogue'], 5000, rogueRelay((sub) => events.map((e) => ['EVENT', sub, e])));
    expect(result.events).toHaveLength(1);
    expect(result.perRelay[0].error).toBe('relay event budget exceeded');
    expect(verifyCalls()).toBe(1);
  });

  it('keeps at most 100 of 103 events for limit 100', async () => {
    const events = Array.from({ length: 103 }, (_, i) => hallOfFameEvent(PROOF, `pull-${i}`, 1_000_000 + i));
    const result = await fetchEvents({ kinds: [HOF_KIND], limit: 100 }, ['wss://rogue'], 5000, rogueRelay((sub) => events.map((e) => ['EVENT', sub, e])));
    expect(result.events).toHaveLength(100);
    expect(result.perRelay[0].error).toBe('relay event budget exceeded');
    expect(verifyCalls()).toBe(100);
  });

  it('skips oversized frames unparsed without counting them as malformed', async () => {
    const jsonParseSpy = vi.spyOn(JSON, 'parse');
    const valid = hallOfFameEvent(PROOF, 'valid', 1_000_000);
    const huge = 'x'.repeat(MAX_RAW_MESSAGE_CHARS + 10);
    try {
      // More oversized frames than the malformed-frame budget: an honest relay allowing bigger
      // events than we read could send these, so they must not close it.
      const frames = (sub: unknown) => [...Array<string>(MAX_RELAY_INVALID_MESSAGES + 5).fill(huge), ['EVENT', sub, valid]];
      const result = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://big'], 5000, rogueRelay(frames));
      expect(result.events).toEqual([valid]);
      expect(result.perRelay[0].error).toBeUndefined();
      expect(jsonParseSpy.mock.calls.map((call) => call[0])).not.toContain(huge);
    } finally {
      jsonParseSpy.mockRestore();
    }
  });

  it('pages on past well-formed events too big to keep, without verifying them', async () => {
    // Valid Nostr an honest relay would serve (strfry allows 64 KB), but bigger than a Hall of Fame
    // event needs: two pages' worth, newest first, with the real submission behind them.
    // More of them than the malformed-frame budget, so counting them as malformed would close the relay.
    const fat = [
      ...Array.from({ length: 40 }, (_, i) => signedHof(2_000_000 + i, 'a'.repeat(5 * MAX_RETAINED_EVENT_BYTES))),
      ...Array.from({ length: 40 }, (_, i) => signedHof(3_000_000 + i, '{}', [['t', HOF_TAG], ...Array.from({ length: 60 }, (_, j) => ['x', `${j}`])])),
    ];
    const real = hallOfFameEvent(PROOF, 'real', 1_000_000);
    expect(fat.some(isRetainable)).toBe(false);
    expect(isRetainable(real)).toBe(true);
    const requests: string[] = [];
    const result = await fetchEvents({ kinds: [HOF_KIND], '#t': [HOF_TAG], limit: 20 }, ['wss://a'], 5000, fakeRelays({ 'wss://a': 'accept' }, [real, ...fat], requests), 20);
    expect(result.events).toEqual([real]);
    expect(result.perRelay[0].error).toBeUndefined();
    expect(requests.length).toBeGreaterThan(5); // past every page of fat events, to the real one
    expect(verifyCalls()).toBe(1);
  });

  it('skips oversized or off-filter events without verifying them', async () => {
    const bigContent = signedHof(1_000_000, 'a'.repeat(MAX_RETAINED_EVENT_BYTES));
    const manyTags = signedHof(1_000_001, '{}', Array.from({ length: MAX_EVENT_TAGS + 1 }, (_, i) => ['t', `tag-${i}`]));
    const longTag = signedHof(1_000_002, '{}', [['t', HOF_TAG, ...Array<string>(MAX_EVENT_TAG_ITEMS).fill('x')]]);
    const wrongKind = signEvent({ pubkey, created_at: 1_500_000, kind: 1, tags: [['t', HOF_TAG]], content: 'test' }, key);
    const wrongTag = signedHof(1_500_001, 'test', [['t', 'other-tag']]);
    const tooOld = signedHof(500, 'test');
    const good = hallOfFameEvent(PROOF, 'good', 1_500_000);
    const filter: Filter = { kinds: [HOF_KIND], '#t': [HOF_TAG], since: 1000, until: 2_000_000 };
    expect([bigContent, manyTags, longTag].some(isRetainable)).toBe(false);
    expect([wrongKind, wrongTag, tooOld].some((e) => matchesFilter(e, filter))).toBe(false);
    expect(matchesFilter(good, filter)).toBe(true);
    const all = [bigContent, manyTags, longTag, wrongKind, wrongTag, tooOld, good];
    const result = await fetchEvents(filter, ['wss://rogue'], 5000, rogueRelay((sub) => all.map((e) => ['EVENT', sub, e])));
    expect(result.events).toEqual([good]);
    expect(result.perRelay[0]).toEqual({ relay: 'wss://rogue', count: all.length, error: undefined });
    expect(verifyCalls()).toBe(1);
  });

  it('closes a relay that keeps sending malformed frames', async () => {
    let closed = false;
    const frames = (sub: unknown) => [
      ...Array<string>(30).fill('not valid json {{{'),
      ...Array<unknown[]>(30).fill(['EVENT', sub, { id: 'nope' }]),
    ];
    const result = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://spammer'], 5000, rogueRelay(frames, () => { closed = true; }));
    expect(closed).toBe(true);
    expect(result.perRelay[0].error).toBe('invalid message budget exceeded');
    expect(result.events).toEqual([]);
  });

  it('counts binary frames as malformed', async () => {
    const socket = createMockSocket({
      send: (raw, s) => {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] !== 'REQ') return;
        for (let i = 0; i <= MAX_RELAY_INVALID_MESSAGES; i++) queueMicrotask(() => s.onmessage?.({ data: new Uint8Array(4) }));
      },
    });
    const result = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://binary'], 5000, socket);
    expect(result.perRelay[0].error).toBe('invalid message budget exceeded');
  });

  it('closes a relay that sends more frames than its message budget', async () => {
    const e = hallOfFameEvent(PROOF, 'dup', 1_000_000);
    const result = await fetchEvents({ kinds: [HOF_KIND], limit: 10 }, ['wss://chatty'], 5000, rogueRelay((sub) => Array<unknown[]>(500).fill(['EVENT', sub, e])));
    expect(result.events).toEqual([e]);
    // 10 events + 1 EOSE + 50 malformed + 100 spare.
    expect(result.perRelay[0]).toEqual({ relay: 'wss://chatty', count: 161, error: 'message budget exceeded' });
    expect(verifyCalls()).toBe(1);
  });

  it("gives each relay its own share of the retained-byte budget, so one can't starve the others", async () => {
    const hog = Array.from({ length: 5 }, (_, i) => hallOfFameEvent(PROOF, `hog-${i}`, 1_000_000 + i));
    const honest = Array.from({ length: 2 }, (_, i) => hallOfFameEvent(PROOF, `honest-${i}`, 1_000_000 + i));
    const size = Math.max(...[...hog, ...honest].map(eventByteSize));
    const relays: Record<string, NostrEvent[]> = { 'wss://hog': hog, 'wss://honest': honest };
    // The hog connects and answers first.
    const result = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://hog', 'wss://honest'], 5000, (url) => rogueRelay((sub) => relays[url].map((e) => ['EVENT', sub, e]))(url), 1, undefined, { maxRetainedBytes: 2 * 2 * size });
    expect(result.perRelay.map((r) => r.error)).toEqual(['retained byte budget exceeded', undefined]);
    expect(result.events.map((e) => e.id)).toEqual(expect.arrayContaining(honest.map((e) => e.id)));
    expect(result.events).toHaveLength(4);
  });

  it('keeps a full answer of the largest retainable events from every relay by default', async () => {
    const tags = [['t', HOF_TAG]];
    const padding = MAX_RETAINED_EVENT_BYTES - eventByteSize(signedHof(0, '', tags));
    const relays = ['wss://a', 'wss://b', 'wss://c'];
    const stored = Object.fromEntries(relays.map((r, n) => [r, Array.from({ length: 50 }, (_, i) => signedHof(1_000_000 + n * 100 + i, 'a'.repeat(padding), tags))]));
    expect(eventByteSize(stored['wss://a'][0])).toBe(MAX_RETAINED_EVENT_BYTES);
    const result = await fetchEvents({ kinds: [HOF_KIND], limit: 50 }, relays, 500, fakeRelays({ 'wss://a': 'accept', 'wss://b': 'accept', 'wss://c': 'accept' }, stored));
    expect(result.events).toHaveLength(150);
    expect(result.perRelay.map((r) => r.error)).toEqual([undefined, undefined, undefined]);
  });

  it('fits a Hall of Fame event with the longest proof and a score', () => {
    const e = hallOfFameEvent(`AQ${'a'.repeat(398)}`, 'x'.repeat(64), 1_000_000, 123_456_789);
    expect(eventByteSize(e)).toBeLessThan(MAX_RETAINED_EVENT_BYTES / 3);
    expect(isRetainable(e)).toBe(true);
  });
});

describe('publish replies', () => {
  it('skips binary and oversized frames while waiting for OK', async () => {
    const event = hallOfFameEvent(PROOF, 'x');
    const socket = createMockSocket({
      send: (raw, s) => {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] !== 'EVENT') return;
        queueMicrotask(() => s.onmessage?.({ data: new Uint8Array(4) }));
        queueMicrotask(() => s.onmessage?.({ data: JSON.stringify(['NOTICE', 'x'.repeat(MAX_RAW_MESSAGE_CHARS)]) }));
        queueMicrotask(() => s.onmessage?.({ data: JSON.stringify(['OK', event.id, true, '']) }));
      },
    });
    expect(await publishEvent(event, ['wss://a'], 5000, socket)).toEqual([{ relay: 'wss://a', ok: true, message: '' }]);
  });
});

describe('lazy signatures (#1000)', () => {
  beforeEach(() => { vi.mocked(schnorr.verify).mockClear(); });
  const read = (stored: Record<string, NostrEvent[]>) =>
    fetchEvents({ kinds: [HOF_KIND] }, Object.keys(stored), 500, fakeRelays(Object.fromEntries(Object.keys(stored).map((r) => [r, 'accept' as const])), stored), 1, undefined, {}, true);

  it('keeps events without checking signatures, so the caller pays only for the ones it uses', async () => {
    const events = Array.from({ length: 5 }, (_, i) => hallOfFameEvent(PROOF, `pull-${i}`, 1_000_000 + i * 1000));
    const result = await read({ 'wss://a': events, 'wss://b': events });
    expect(result.events.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
    expect(verifyCalls()).toBe(0);
    // Without it, each event is checked once.
    await fetchEvents({ kinds: [HOF_KIND] }, ['wss://a', 'wss://b'], 500, fakeRelays({ 'wss://a': 'accept', 'wss://b': 'accept' }, events));
    expect(verifyCalls()).toBe(5);
  });

  it('still drops a copy whose content does not match its id', async () => {
    const good = hallOfFameEvent(PROOF, 'x');
    const tampered = { ...good, content: good.content.replace('AQ', 'AR') };
    expect((await read({ 'wss://bad': [tampered] })).events).toEqual([]);
    expect((await read({ 'wss://bad': [tampered], 'wss://good': [good] })).events).toEqual([good]);
    expect(verifyCalls()).toBe(0);
  });

  it('keeps the copy that verifies when relays send one event with different signatures', async () => {
    const good = hallOfFameEvent(PROOF, 'x');
    const badSig = { ...good, sig: (good.sig[0] === '0' ? '1' : '0') + good.sig.slice(1) };
    expect((await read({ 'wss://bad': [badSig], 'wss://good': [good] })).events).toEqual([good]);
    expect((await read({ 'wss://good': [good], 'wss://bad': [badSig], 'wss://bad2': [{ ...badSig }] })).events).toEqual([good]);
    // Kept alone, the bad copy is returned for the caller's own check to turn down.
    const alone = (await read({ 'wss://bad': [badSig] })).events;
    expect(alone).toEqual([badSig]);
    expect(verifyEvent(alone[0])).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../engine/bytes';
import {
  eventByteSize,
  fetchEvents,
  hallOfFameEvent,
  HOF_KIND,
  HOF_TAG,
  isEventShape,
  matchesFilter,
  MAX_EVENT_CONTENT_BYTES,
  MAX_EVENT_TAG_VALUE_BYTES,
  MAX_EVENT_TAGS_COUNT,
  MAX_RAW_MESSAGE_BYTES,
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

describe('relay ingress boundaries (#621)', () => {
  it('enforces limit 1 by rejecting excess events and halting crypto verification', async () => {
    const verifySpy = vi.fn(verifyEvent);

    // 12 valid events
    const events = Array.from({ length: 12 }, (_, i) => hallOfFameEvent(PROOF, `pull-${i}`, 1_000_000 + i));
    const rogueSocket = createMockSocket({
      send: (raw, socket) => {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] === 'REQ') {
          const sub = msg[1];
          for (const e of events) {
            queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EVENT', sub, e]) }));
          }
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EOSE', sub]) }));
        }
      },
    });

    const result = await fetchEvents({ kinds: [HOF_KIND], limit: 1 }, ['wss://rogue'], 500, rogueSocket, 1, undefined, { verify: verifySpy });
    expect(result.events).toHaveLength(1);
    expect(result.perRelay[0].error).toBe('relay event budget exceeded');
    // Crypto must NOT be run on the 11 excess events!
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('enforces limit 100 by rejecting excess events beyond 100 and halting crypto', async () => {
    const verifySpy = vi.fn(verifyEvent);

    // 103 valid events
    const events = Array.from({ length: 103 }, (_, i) => hallOfFameEvent(PROOF, `pull-${i}`, 1_000_000 + i));
    const rogueSocket = createMockSocket({
      send: (raw, socket) => {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] === 'REQ') {
          const sub = msg[1];
          for (const e of events) {
            queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EVENT', sub, e]) }));
          }
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EOSE', sub]) }));
        }
      },
    });

    const result = await fetchEvents({ kinds: [HOF_KIND], limit: 100 }, ['wss://rogue'], 500, rogueSocket, 1, undefined, { verify: verifySpy });
    expect(result.events).toHaveLength(100);
    expect(result.perRelay[0].error).toBe('relay event budget exceeded');
    expect(verifySpy).toHaveBeenCalledTimes(100);
  });

  it('rejects oversized raw messages before JSON.parse', async () => {
    const jsonParseSpy = vi.spyOn(JSON, 'parse');
    const validEvent = hallOfFameEvent(PROOF, 'valid', 1_000_000);
    const hugeMessage = 'x'.repeat(MAX_RAW_MESSAGE_BYTES + 10);

    const rogueSocket = createMockSocket({
      send: (raw, socket) => {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] === 'REQ') {
          const sub = msg[1];
          queueMicrotask(() => socket.onmessage?.({ data: hugeMessage }));
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EVENT', sub, validEvent]) }));
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EOSE', sub]) }));
        }
      },
    });

    const initialParseCalls = jsonParseSpy.mock.calls.length;
    const result = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://rogue'], 500, rogueSocket, 1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe(validEvent.id);

    // Verify JSON.parse was never called on hugeMessage
    const parseArgs = jsonParseSpy.mock.calls.slice(initialParseCalls).map((call) => call[0]);
    expect(parseArgs).not.toContain(hugeMessage);

    jsonParseSpy.mockRestore();
  });

  it('rejects events with oversized content or tags without crypto verification', async () => {
    const verifySpy = vi.fn(verifyEvent);

    const sk = schnorr.utils.randomSecretKey();
    const pubkey = toHex(schnorr.getPublicKey(sk));

    // 1. Oversized content (e.g. 20 KB > MAX_EVENT_CONTENT_BYTES 16 KB)
    const bigContentEvent = signEvent(
      { pubkey, created_at: 1_000_000, kind: HOF_KIND, tags: [['t', HOF_TAG]], content: 'a'.repeat(MAX_EVENT_CONTENT_BYTES + 100) },
      sk,
    );

    // 2. Excess tags (> MAX_EVENT_TAGS_COUNT 50)
    const excessTags = Array.from({ length: MAX_EVENT_TAGS_COUNT + 5 }, (_, i) => ['t', `tag-${i}`]);
    const excessTagsEvent = signEvent(
      { pubkey, created_at: 1_000_000, kind: HOF_KIND, tags: excessTags, content: '{}' },
      sk,
    );

    // 3. Oversized tag item (> MAX_EVENT_TAG_VALUE_BYTES 1024)
    const bigTagEvent = signEvent(
      { pubkey, created_at: 1_000_000, kind: HOF_KIND, tags: [['t', 'b'.repeat(MAX_EVENT_TAG_VALUE_BYTES + 50)]], content: '{}' },
      sk,
    );

    expect(isEventShape(bigContentEvent)).toBe(false);
    expect(isEventShape(excessTagsEvent)).toBe(false);
    expect(isEventShape(bigTagEvent)).toBe(false);

    const validEvent = hallOfFameEvent(PROOF, 'good', 1_000_000);
    const rogueSocket = createMockSocket({
      send: (raw, socket) => {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] === 'REQ') {
          const sub = msg[1];
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EVENT', sub, bigContentEvent]) }));
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EVENT', sub, excessTagsEvent]) }));
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EVENT', sub, bigTagEvent]) }));
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EVENT', sub, validEvent]) }));
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EOSE', sub]) }));
        }
      },
    });

    const result = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://rogue'], 500, rogueSocket, 1, undefined, { verify: verifySpy });
    expect(result.events).toEqual([validEvent]);
    // Schnorr verify was ONLY called for validEvent!
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('drops off-filter events before running crypto verification', async () => {
    const verifySpy = vi.fn(verifyEvent);

    const sk = schnorr.utils.randomSecretKey();
    const pubkey = toHex(schnorr.getPublicKey(sk));

    // Valid signatures on off-filter events
    const wrongKind = signEvent({ pubkey, created_at: 1_000_000, kind: 1, tags: [['t', HOF_TAG]], content: 'test' }, sk);
    const wrongTag = signEvent({ pubkey, created_at: 1_000_000, kind: HOF_KIND, tags: [['t', 'other-tag']], content: 'test' }, sk);
    const tooOld = signEvent({ pubkey, created_at: 500, kind: HOF_KIND, tags: [['t', HOF_TAG]], content: 'test' }, sk);
    const tooNew = signEvent({ pubkey, created_at: 5_000, kind: HOF_KIND, tags: [['t', HOF_TAG]], content: 'test' }, sk);
    const good = hallOfFameEvent(PROOF, 'good', 1_500_000);

    const filter: Filter = { kinds: [HOF_KIND], '#t': [HOF_TAG], since: 1000, until: 2000 };
    expect(matchesFilter(wrongKind, filter)).toBe(false);
    expect(matchesFilter(wrongTag, filter)).toBe(false);
    expect(matchesFilter(tooOld, filter)).toBe(false);
    expect(matchesFilter(tooNew, filter)).toBe(false);
    expect(matchesFilter(good, filter)).toBe(true);

    const rogueSocket = createMockSocket({
      send: (raw, socket) => {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] === 'REQ') {
          const sub = msg[1];
          for (const e of [wrongKind, wrongTag, tooOld, tooNew, good]) {
            queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EVENT', sub, e]) }));
          }
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(['EOSE', sub]) }));
        }
      },
    });

    const result = await fetchEvents(filter, ['wss://rogue'], 500, rogueSocket, 1, undefined, { verify: verifySpy });
    expect(result.events).toEqual([good]);
    // Schnorr verify was ONLY called for good, none of the 4 off-filter events!
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('closes connection when invalid message budget is exhausted', async () => {
    let closed = false;
    const rogueSocket = createMockSocket({
      send: (_raw, socket) => {
        for (let i = 0; i < 60; i++) {
          queueMicrotask(() => socket.onmessage?.({ data: 'not valid json {{{' }));
        }
      },
      close: () => { closed = true; },
    });

    const result = await fetchEvents({ kinds: [HOF_KIND] }, ['wss://spammer'], 500, rogueSocket, 1);
    expect(closed).toBe(true);
    expect(result.perRelay[0].error).toBe('invalid message budget exceeded');
    expect(result.events).toEqual([]);
  });

  it('computes event byte size accurately', () => {
    const e = hallOfFameEvent(PROOF, 'test-pull', 1_000_000);
    const size = eventByteSize(e);
    expect(size).toBeGreaterThan(100);
    expect(size).toBeLessThan(1000);
  });
});

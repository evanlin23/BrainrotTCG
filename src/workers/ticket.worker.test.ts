import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { argon2id } from 'hash-wasm';
import { computeTicket, fromHex, fromUtf8, toHex } from '../engine';
import type { TicketRequest } from './ticket.worker';

// The real Argon2id unless a test says otherwise, so the protocol tests can also prove which
// bytes the worker hands back.
vi.mock('hash-wasm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hash-wasm')>();
  return { ...actual, argon2id: vi.fn(actual.argon2id) };
});

type Reply = { id: number; ticket?: Uint8Array; error?: string };

const SET_KEY = 'right-now@2';
const PUBLIC_KEY_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';

const scope = { postMessage: vi.fn<(reply: Reply) => void>(), onmessage: undefined as undefined | ((event: { data: TicketRequest }) => Promise<void>) };
const send = (request: TicketRequest) => scope.onmessage!({ data: request });
const request = (over: Partial<TicketRequest> = {}): TicketRequest => ({ id: 1, setKey: SET_KEY, publicKeyHex: PUBLIC_KEY_HEX, nonce: 0, ...over });
const replies = () => scope.postMessage.mock.calls.map(([reply]) => reply);

beforeAll(async () => {
  vi.stubGlobal('self', scope);
  await import('./ticket.worker');
});
afterAll(() => vi.unstubAllGlobals());

let realArgon2id: typeof argon2id;
beforeEach(async () => {
  realArgon2id ??= (await vi.importActual<typeof import('hash-wasm')>('hash-wasm')).argon2id;
  scope.postMessage.mockReset();
  vi.mocked(argon2id).mockReset();
  vi.mocked(argon2id).mockImplementation(realArgon2id);
});

describe('ticket worker', () => {
  it('installs itself as the message handler', () => {
    expect(scope.onmessage).toBeTypeOf('function');
  });

  it('answers a valid request with { id, ticket } holding the ticket for that set, key and nonce', async () => {
    await send(request({ id: 7, nonce: 3 }));

    expect(scope.postMessage).toHaveBeenCalledTimes(1);
    const [reply] = replies();
    expect(Object.keys(reply).sort()).toEqual(['id', 'ticket']);
    expect(reply.id).toBe(7);
    expect(reply.ticket).toBeInstanceOf(Uint8Array);
    expect(reply.ticket).toHaveLength(32);
    expect(toHex(reply.ticket!)).toBe(toHex(await computeTicket(SET_KEY, fromHex(PUBLIC_KEY_HEX), 3)));
  });

  it('mines different tickets for different nonces, keys and sets', async () => {
    const other = PUBLIC_KEY_HEX.replace(/^01/, 'ff');
    await send(request({ id: 1, nonce: 0 }));
    await send(request({ id: 2, nonce: 1 }));
    await send(request({ id: 3, publicKeyHex: other }));
    await send(request({ id: 4, setKey: 'web-ancients@2' }));
    const tickets = replies().map((r) => toHex(r.ticket!));
    expect(new Set(tickets).size).toBe(4);
  });

  it('posts the reply with no transfer list', async () => {
    await send(request());
    expect(scope.postMessage.mock.calls[0]).toHaveLength(1);
  });

  it('keeps each reply tied to its request id when the answers arrive out of order', async () => {
    // One gate per nonce, made by whichever side reaches it first, so the test needn't know when mining starts.
    type Gate = { promise: Promise<Uint8Array>; resolve: (bytes: Uint8Array) => void };
    const gates = new Map<number, Gate>();
    const gate = (nonce: number): Gate => {
      if (!gates.has(nonce)) {
        const g = {} as Gate;
        g.promise = new Promise((resolve) => (g.resolve = resolve));
        gates.set(nonce, g);
      }
      return gates.get(nonce)!;
    };
    vi.mocked(argon2id).mockImplementation(((options: { password: Uint8Array }) =>
      gate(Number(fromUtf8(options.password).split('|')[3])).promise) as unknown as typeof argon2id);

    const first = send(request({ id: 10, nonce: 1 }));
    const second = send(request({ id: 11, nonce: 2 }));

    gate(2).resolve(Uint8Array.of(2));
    await second;
    expect(replies()).toEqual([{ id: 11, ticket: Uint8Array.of(2) }]);

    gate(1).resolve(Uint8Array.of(1));
    await first;
    expect(replies()).toEqual([
      { id: 11, ticket: Uint8Array.of(2) },
      { id: 10, ticket: Uint8Array.of(1) },
    ]);
  });

  it('tells a failing request from a succeeding one by id', async () => {
    await Promise.all([send(request({ id: 20, nonce: 0 })), send(request({ id: 21, nonce: -1 }))]);
    const byId = new Map(replies().map((r) => [r.id, r]));
    expect(byId.get(20)?.ticket).toHaveLength(32);
    expect(byId.get(20)).not.toHaveProperty('error');
    expect(byId.get(21)).toStrictEqual({ id: 21, error: 'Error: Invalid nonce' });
  });

  describe('failures come back as { id, error } strings instead of throwing', () => {
    it.each([
      ['a negative nonce', { nonce: -1 }],
      ['a fractional nonce', { nonce: 1.5 }],
      ['NaN', { nonce: Number.NaN }],
      ['Infinity', { nonce: Number.POSITIVE_INFINITY }],
      ['a nonce past the safe integers', { nonce: 2 ** 53 }],
      ['a missing nonce', { nonce: undefined as unknown as number }],
    ])('rejects %s without mining', async (_name, over) => {
      await expect(send(request({ id: 5, ...over }))).resolves.toBeUndefined();
      expect(replies()).toStrictEqual([{ id: 5, error: 'Error: Invalid nonce' }]);
      expect(argon2id).not.toHaveBeenCalled();
    });

    it.each([
      ['non-hex characters', 'zz'],
      ['an odd number of digits', 'abc'],
      ['a 0x prefix', '0x0102'],
      ['whitespace', '01 02'],
    ])('rejects a public key with %s without mining', async (_name, publicKeyHex) => {
      await send(request({ id: 6, publicKeyHex }));
      expect(replies()).toStrictEqual([{ id: 6, error: 'Error: Invalid hex string' }]);
      expect(argon2id).not.toHaveBeenCalled();
    });

    it('accepts upper-case hex like lower-case', async () => {
      await send(request({ id: 1, publicKeyHex: PUBLIC_KEY_HEX.toUpperCase() }));
      await send(request({ id: 2 }));
      const [upper, lower] = replies();
      expect(toHex(upper.ticket!)).toBe(toHex(lower.ticket!));
    });

    it('turns an Argon2 failure into the error text', async () => {
      vi.mocked(argon2id).mockRejectedValue(new RangeError('WebAssembly.Memory(): could not allocate memory'));
      await send(request({ id: 8 }));
      expect(replies()).toStrictEqual([{ id: 8, error: 'RangeError: WebAssembly.Memory(): could not allocate memory' }]);
    });

    it('stringifies a rejection that is not an Error', async () => {
      vi.mocked(argon2id).mockRejectedValue('out of memory');
      await send(request({ id: 9 }));
      expect(replies()).toStrictEqual([{ id: 9, error: 'out of memory' }]);
    });

    it('keeps answering after a failure', async () => {
      await send(request({ id: 1, nonce: -1 }));
      await send(request({ id: 2, nonce: 0 }));
      expect(replies().map((r) => [r.id, r.error ?? 'ticket'])).toEqual([[1, 'Error: Invalid nonce'], [2, 'ticket']]);
    });
  });
});

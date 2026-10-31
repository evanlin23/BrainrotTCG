import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketRequest, TicketResponse } from '../workers/ticket.worker';

vi.mock('../engine', async (importOriginal) => ({
  ...await importOriginal<typeof import('../engine')>(),
  computeTicket: vi.fn(),
}));

const OOM = 'RangeError: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance';

/** The miner's one worker: it answers only when the test says so. */
class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent<TicketResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: TicketRequest[] = [];
  terminate = vi.fn();
  postMessage = vi.fn((request: TicketRequest) => void this.requests.push(request));

  constructor() {
    ControlledWorker.instances.push(this);
  }

  /** Answer the latest request with a ticket naming its nonce. */
  reply() {
    const request = this.requests[this.requests.length - 1];
    this.onmessage?.({ data: { id: request.id, ticket: Uint8Array.of(request.nonce) } } as MessageEvent<TicketResponse>);
  }

  /** Answer the latest request the way a worker does when Wasm has no memory left. */
  runOutOfMemory() {
    const request = this.requests[this.requests.length - 1];
    this.onmessage?.({ data: { id: request.id, error: OOM } } as MessageEvent<TicketResponse>);
  }

  crash() {
    this.onerror?.({ preventDefault: vi.fn(), message: 'crashed' } as unknown as ErrorEvent);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const publicKey = Uint8Array.of(1, 2, 3);
const SET = 'set@1';

let miner: typeof import('./ticketMiner');
let admission: typeof import('./admission');
/** Loaded with the miner, so its TicketMemoryError is the one the miner throws. */
let pool: typeof import('./ticketPool');
let computeTicket: ReturnType<typeof vi.fn>;
/** The worker now in use: the miner swaps in a fresh one every few tickets. */
const worker = () => ControlledWorker.instances[ControlledWorker.instances.length - 1];
const nonces = () => ControlledWorker.instances.flatMap((w) => w.requests.map((r) => r.nonce));
const posts = () => ControlledWorker.instances.reduce((sum, w) => sum + w.postMessage.mock.calls.length, 0);
const running = () => ControlledWorker.instances.filter((w) => w.terminate.mock.calls.length === 0);
const live = (nonce: number) => miner.getTicket(SET, publicKey, nonce);
const check = (nonce: number, signal?: AbortSignal) => miner.getTicket(SET, publicKey, nonce, 'optional', signal);

beforeEach(async () => {
  // Fresh miner, admission and engine mock for every test: they keep module state.
  vi.resetModules();
  ControlledWorker.instances = [];
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 8 }); // optional limit 2
  computeTicket = vi.mocked((await import('../engine')).computeTicket);
  computeTicket.mockImplementation(async (_set: string, _key: Uint8Array, nonce: number) => Uint8Array.of(nonce));
  admission = await import('./admission');
  miner = await import('./ticketMiner');
  pool = await import('./ticketPool');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ticket miner lanes', () => {
  it('mines a pack ticket before optional checks that were asked for first', async () => {
    const checks = [check(0), check(1), check(2)];
    await flush();
    expect(nonces()).toEqual([0]);
    const pack = live(9);
    worker().reply();
    await flush();
    expect(nonces()).toEqual([0, 9]);
    worker().reply();
    expect(await pack).toEqual(Uint8Array.of(9));
    await flush();
    expect(nonces()).toEqual([0, 9, 1]);
    worker().reply();
    await flush();
    worker().reply();
    expect(await Promise.all(checks)).toEqual([0, 1, 2].map((n) => Uint8Array.of(n)));
    expect(nonces()).toEqual([0, 9, 1, 2]);
  });

  it('holds back optional work in other pools while a pack ticket mines', async () => {
    const pack = live(4);
    let ran = 0;
    const other = admission.admitOptional(async () => ++ran);
    await flush();
    expect(ran).toBe(0);
    worker().reply();
    await pack;
    await flush();
    expect(await other).toBe(1);
  });

  it('keeps the prefetched pack ticket cached through many optional checks', async () => {
    miner.prefetchTicket(SET, publicKey, 100);
    worker().reply();
    await flush();
    for (let nonce = 0; nonce < 10; nonce++) {
      const ticket = check(nonce);
      await flush();
      worker().reply();
      expect(await ticket).toEqual(Uint8Array.of(nonce));
    }
    const posted = posts();
    expect(await live(100)).toEqual(Uint8Array.of(100));
    expect(posts()).toBe(posted);
  });

  it('lets a pack take over a ticket that is waiting to be checked', async () => {
    const first = check(4);
    const waiting = check(5);
    const later = check(6);
    await flush();
    expect(nonces()).toEqual([4]);
    const pack = live(5);
    worker().reply();
    await flush();
    expect(nonces()).toEqual([4, 5]);
    worker().reply();
    expect(await pack).toEqual(Uint8Array.of(5));
    expect(await waiting).toEqual(Uint8Array.of(5));
    await flush();
    worker().reply();
    await Promise.all([first, later]);
    expect(nonces()).toEqual([4, 5, 6]);
  });

  it('never mines a check whose page closed before it started', async () => {
    const first = check(1);
    const stop = new AbortController();
    const closed = check(2, stop.signal);
    await flush();
    stop.abort(new Error('Left the page'));
    await expect(closed).rejects.toThrow('Left the page');
    worker().reply();
    await first;
    await flush();
    expect(nonces()).toEqual([1]);
    // A check still wanted by another caller is mined for it.
    const keep = check(3);
    const leaving = new AbortController();
    const gone = check(3, leaving.signal);
    leaving.abort();
    await expect(gone).rejects.toThrow();
    await flush();
    worker().reply();
    expect(await keep).toEqual(Uint8Array.of(3));
  });

  it('finishes on the main thread after a worker error, then carries on and frees the slot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pack = live(7);
    const after = check(8);
    expect(nonces()).toEqual([7]);
    worker().crash();
    expect(await pack).toEqual(Uint8Array.of(7));
    expect(await after).toEqual(Uint8Array.of(8));
    expect(computeTicket.mock.calls.map((call) => call[2])).toEqual([7, 8]);
    expect(worker().terminate).toHaveBeenCalledOnce();
    expect(await live(9)).toEqual(Uint8Array.of(9));
    // Neither the pack's hold nor the check's slot is left behind.
    expect(await admission.admitOptional(async () => 'free')).toBe('free');
  });

  it('restarts its worker after running out of memory and tries the ticket once more', async () => {
    const pack = live(7);
    const [first] = ControlledWorker.instances;
    first.runOutOfMemory();
    expect(first.terminate).toHaveBeenCalledOnce();
    const fresh = ControlledWorker.instances[1];
    expect(fresh.requests.map((request) => request.nonce)).toEqual([7]);
    fresh.reply();
    expect(await pack).toEqual(Uint8Array.of(7));
    // The fresh worker carries on with later tickets.
    const after = check(8);
    await flush();
    fresh.reply();
    expect(await after).toEqual(Uint8Array.of(8));
    expect(ControlledWorker.instances).toHaveLength(2);
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('gives up with a clear error when the fresh worker runs out of memory too, then carries on', async () => {
    const pack = live(7);
    ControlledWorker.instances[0].runOutOfMemory();
    ControlledWorker.instances[1].runOutOfMemory();
    await expect(pack).rejects.toThrow('This device ran out of memory. Close other tabs and try again.');
    expect(ControlledWorker.instances.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
    const next = live(8);
    expect(ControlledWorker.instances).toHaveLength(3);
    ControlledWorker.instances[2].reply();
    expect(await next).toEqual(Uint8Array.of(8));
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('replaces its worker every few tickets, never running two at once', async () => {
    for (let nonce = 0; nonce < pool.TICKETS_PER_WORKER * 2 + 1; nonce++) {
      const ticket = live(nonce);
      await flush();
      expect(running()).toHaveLength(1);
      worker().reply();
      expect(await ticket).toEqual(Uint8Array.of(nonce));
    }
    const [first, second, third] = ControlledWorker.instances;
    expect(ControlledWorker.instances).toHaveLength(3);
    expect(first.requests.map((r) => r.nonce)).toEqual([0, 1, 2, 3]);
    expect(second.requests.map((r) => r.nonce)).toEqual([4, 5, 6, 7]);
    expect(third.requests.map((r) => r.nonce)).toEqual([8]);
    expect([first, second].every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
    expect(running()).toEqual([third]);
  });
});

describe('ticket miner on the main thread', () => {
  const oom = () => new RangeError('WebAssembly.Memory(): could not allocate memory');
  const noWorkers = () =>
    vi.stubGlobal('Worker', class {
      constructor() {
        throw new Error('Workers unavailable');
      }
    });

  it('tries a ticket that ran out of memory once more, like the worker path', async () => {
    noWorkers();
    computeTicket.mockRejectedValueOnce(oom());
    expect(await live(7)).toEqual(Uint8Array.of(7));
    expect(computeTicket.mock.calls.map((call) => call[2])).toEqual([7, 7]);
  });

  it('gives up with a memory error when the retry runs out of memory too, then carries on', async () => {
    noWorkers();
    computeTicket.mockRejectedValueOnce(oom()).mockRejectedValueOnce(oom());
    const error = await live(7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(pool.TicketMemoryError);
    expect((error as InstanceType<typeof pool.TicketMemoryError>).detail).toContain('could not allocate memory');
    expect(computeTicket).toHaveBeenCalledTimes(2);
    expect(await live(8)).toEqual(Uint8Array.of(8));
  });

  it('does not retry other errors', async () => {
    noWorkers();
    computeTicket.mockRejectedValueOnce(new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded'));
    const error = await live(7).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(pool.TicketMemoryError);
    expect(computeTicket).toHaveBeenCalledOnce();
  });

  it('retries a ticket that ran out of memory after the worker crashed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    computeTicket.mockRejectedValueOnce(oom());
    const pack = live(7);
    worker().crash();
    expect(await pack).toEqual(Uint8Array.of(7));
    expect(computeTicket).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTicket, toHex } from '../engine';
import type { TicketRequest, TicketResponse } from '../workers/ticket.worker';
import {
  createTicketPool,
  isOutOfMemory,
  MAX_OOM_ATTEMPTS,
  poolSize,
  TICKETS_PER_WORKER,
  TicketMemoryError,
  type TicketPool,
} from './ticketPool';

vi.mock('../engine', async (importOriginal) => ({
  ...await importOriginal<typeof import('../engine')>(),
  computeTicket: vi.fn(),
}));

/** What Chrome on Android reported when verifying a long profile. */
const OOM = 'RangeError: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance';

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  static failAt: number | null = null;
  onmessage: ((event: MessageEvent<TicketResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: TicketRequest[] = [];
  failPosts = false;
  answered = 0;
  terminate = vi.fn();
  postMessage = vi.fn((request: TicketRequest) => {
    if (this.failPosts) throw new Error('postMessage failed');
    this.requests.push(request);
  });

  constructor() {
    if (ControlledWorker.instances.length === ControlledWorker.failAt) throw new Error('Worker unavailable');
    ControlledWorker.instances.push(this);
  }

  reply(response?: TicketResponse) {
    const request = this.requests[this.requests.length - 1];
    this.answered++;
    this.onmessage?.({ data: response ?? { id: request.id, ticket: Uint8Array.of(request.nonce) } } as MessageEvent<TicketResponse>);
  }

  /** Answer the latest request the way a worker does when Wasm has no memory left. */
  runOutOfMemory() {
    this.reply({ id: this.requests[this.requests.length - 1].id, error: OOM });
  }

  crash() {
    const event = { preventDefault: vi.fn() };
    this.onerror?.(event as unknown as ErrorEvent);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
}

const publicKey = Uint8Array.of(10, 11);
const pools: TicketPool[] = [];
const pool = (size = 2) => {
  const created = createTicketPool(size);
  pools.push(created);
  return created;
};
type Computation = { nonce: number; resolve: (ticket: Uint8Array) => void; reject: (error: Error) => void };
let computations: Computation[];
let active: number;
let maximumActive: number;
const finish = (index: number) => computations[index].resolve(Uint8Array.of(computations[index].nonce));
const terminated = (worker: ControlledWorker) => worker.terminate.mock.calls.length;
const running = () => ControlledWorker.instances.filter((worker) => terminated(worker) === 0);

beforeEach(() => {
  ControlledWorker.instances = [];
  ControlledWorker.failAt = null;
  computations = [];
  active = 0;
  maximumActive = 0;
  vi.stubGlobal('Worker', ControlledWorker);
  vi.mocked(computeTicket).mockReset();
  vi.mocked(computeTicket).mockImplementation((_setKey, _publicKey, nonce) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    return new Promise<Uint8Array>((resolve, reject) => {
      computations.push({
        nonce,
        resolve: (ticket) => { active--; resolve(ticket); },
        reject: (error) => { active--; reject(error); },
      });
    });
  });
});

afterEach(() => {
  for (const created of pools.splice(0)) created.close();
  vi.unstubAllGlobals();
  vi.mocked(computeTicket).mockReset();
});

describe('ticket pool scheduling and lifecycle', () => {
  it('uses each worker for one job and ignores responses for a different job', async () => {
    const created = pool();
    const requests = [0, 1, 2].map((nonce) => created.ticket('set@1', publicKey, nonce));
    const outcomes = Promise.all(requests);
    const [first, second] = ControlledWorker.instances;
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]).toEqual({ id: 0, setKey: 'set@1', publicKeyHex: toHex(publicKey), nonce: 0 });
    second.reply({ id: 99, ticket: Uint8Array.of(99) });
    expect(second.requests).toHaveLength(1);
    second.reply();
    expect(second.requests.map((request) => request.nonce)).toEqual([0, 2]);
    first.reply();
    second.reply();
    expect(await outcomes).toEqual([0, 1, 2].map((nonce) => Uint8Array.of(nonce)));
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('bounds many no-Worker requests to one fallback computation', async () => {
    vi.stubGlobal('Worker', undefined);
    const created = pool(8);
    const requests = Array.from({ length: 12 }, (_, nonce) => created.ticket('set@1', publicKey, nonce));
    const outcomes = Promise.all(requests);
    expect(computations).toHaveLength(1);
    expect(created.size).toBe(1);
    for (let i = 0; i < requests.length; i++) {
      finish(i);
      expect(await requests[i]).toEqual(Uint8Array.of(i));
    }
    expect(await outcomes).toHaveLength(12);
    expect(maximumActive).toBe(1);
    expect(vi.mocked(computeTicket).mock.calls).toEqual(requests.map((_, nonce) => ['set@1', publicKey, nonce]));
  });

  it('queues fallback work after a Worker constructor failure', async () => {
    ControlledWorker.failAt = 0;
    const created = pool();
    const first = created.ticket('set@1', publicKey, 0);
    const second = created.ticket('set@1', publicKey, 1);
    const outcomes = Promise.all([first, second]);
    expect(computations).toHaveLength(1);
    finish(0);
    await first;
    finish(1);
    expect(await outcomes).toEqual([Uint8Array.of(0), Uint8Array.of(1)]);
    expect(maximumActive).toBe(1);
  });

  it('keeps a successfully constructed worker when a later constructor fails', async () => {
    ControlledWorker.failAt = 1;
    const created = pool(3);
    const result = created.ticket('set@1', publicKey, 4);
    expect(created.size).toBe(1);
    ControlledWorker.instances[0].reply();
    expect(await result).toEqual(Uint8Array.of(4));
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('removes workers that fail to load before receiving a job', async () => {
    const created = pool();
    for (const worker of ControlledWorker.instances) worker.crash();
    const result = created.ticket('set@1', publicKey, 5);
    expect(computations).toHaveLength(1);
    finish(0);
    expect(await result).toEqual(Uint8Array.of(5));
    expect(ControlledWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('retries a crashed job on a surviving worker without starting fallback work', async () => {
    const created = pool();
    const requests = [0, 1, 2].map((nonce) => created.ticket('set@1', publicKey, nonce));
    const outcomes = Promise.all(requests);
    const [survivor, failed] = ControlledWorker.instances;
    failed.crash();
    survivor.reply();
    expect(survivor.requests.map((request) => request.nonce)).toEqual([1, 0]);
    survivor.reply();
    survivor.reply();
    expect(await outcomes).toEqual([0, 1, 2].map((nonce) => Uint8Array.of(nonce)));
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('serializes crashed and queued jobs when all workers fail', async () => {
    const created = pool();
    const requests = [0, 1, 2, 3].map((nonce) => created.ticket('set@1', publicKey, nonce));
    const outcomes = Promise.all(requests);
    const [first, second] = ControlledWorker.instances;
    const lateReply = second.onmessage!;
    second.crash();
    first.crash();
    expect(computations).toHaveLength(1);
    lateReply({ data: { id: 0, ticket: Uint8Array.of(99) } } as MessageEvent<TicketResponse>);
    for (let i = 0; i < requests.length; i++) {
      const nonce = computations[i].nonce;
      finish(i);
      await requests[nonce];
    }
    expect(await outcomes).toEqual([0, 1, 2, 3].map((nonce) => Uint8Array.of(nonce)));
    expect(maximumActive).toBe(1);
  });

  it('recovers a synchronous postMessage failure through the tracked fallback', async () => {
    const created = pool(1);
    ControlledWorker.instances[0].failPosts = true;
    const result = created.ticket('set@1', publicKey, 6);
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
    finish(0);
    expect(await result).toEqual(Uint8Array.of(6));
  });

  it('rejects worker computation errors and continues queued work', async () => {
    const created = pool(1);
    const first = created.ticket('set@1', publicKey, 0);
    const second = created.ticket('set@1', publicKey, 1);
    const outcomes = Promise.allSettled([first, second]);
    const worker = ControlledWorker.instances[0];
    worker.reply({ id: 0, error: 'invalid ticket input' });
    worker.reply();
    expect(await outcomes).toEqual([
      { status: 'rejected', reason: new Error('invalid ticket input') },
      { status: 'fulfilled', value: Uint8Array.of(1) },
    ]);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('continues the fallback queue after computation rejection', async () => {
    ControlledWorker.failAt = 0;
    const created = pool();
    const first = created.ticket('set@1', publicKey, 0);
    const second = created.ticket('set@1', publicKey, 1);
    const outcomes = Promise.allSettled([first, second]);
    computations[0].reject(new Error('compute failed'));
    await first.catch(() => undefined);
    finish(1);
    expect(await outcomes).toEqual([
      { status: 'rejected', reason: new Error('compute failed') },
      { status: 'fulfilled', value: Uint8Array.of(1) },
    ]);
    expect(maximumActive).toBe(1);
  });

  it('settles a synchronous fallback failure and accepts the next job', async () => {
    ControlledWorker.failAt = 0;
    vi.mocked(computeTicket).mockImplementationOnce(() => { throw new Error('synchronous failure'); });
    const created = pool();
    await expect(created.ticket('set@1', publicKey, 0)).rejects.toThrow('synchronous failure');
    const result = created.ticket('set@1', publicKey, 1);
    finish(0);
    expect(await result).toEqual(Uint8Array.of(1));
  });

  it('rejects active and queued fallback consumers on close and ignores late completion', async () => {
    vi.stubGlobal('Worker', undefined);
    const created = pool();
    const outcomes = Promise.allSettled([0, 1, 2].map((nonce) => created.ticket('set@1', publicKey, nonce)));
    created.close();
    created.close();
    expect(await outcomes).toEqual(Array.from({ length: 3 }, () => ({ status: 'rejected', reason: new Error('Ticket pool closed') })));
    await expect(created.ticket('set@1', publicKey, 3)).rejects.toThrow('Ticket pool closed');
    finish(0);
    await Promise.resolve();
    expect(computations).toHaveLength(1);
  });

  it('rejects running and queued worker consumers and ignores saved callbacks after close', async () => {
    const created = pool(1);
    const outcomes = Promise.allSettled([0, 1].map((nonce) => created.ticket('set@1', publicKey, nonce)));
    const worker = ControlledWorker.instances[0];
    const lateReply = worker.onmessage!;
    const lateError = worker.onerror!;
    created.close();
    created.close();
    lateReply({ data: { id: 0, ticket: Uint8Array.of(99) } } as MessageEvent<TicketResponse>);
    lateError({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    expect(await outcomes).toEqual(Array.from({ length: 2 }, () => ({ status: 'rejected', reason: new Error('Ticket pool closed') })));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(computeTicket).not.toHaveBeenCalled();
  });
});

describe('ticket pool memory', () => {
  it('retires a worker that ran out of memory and retries its ticket on a surviving worker', async () => {
    const created = pool();
    const requests = [0, 1].map((nonce) => created.ticket('set@1', publicKey, nonce));
    const [survivor, failed] = ControlledWorker.instances;
    failed.runOutOfMemory();
    expect(terminated(failed)).toBe(1);
    // The pool shrinks instead of starting a replacement while another worker is alive.
    expect(ControlledWorker.instances).toHaveLength(2);
    survivor.reply();
    expect(survivor.requests.map((request) => request.nonce)).toEqual([1, 0]);
    survivor.reply();
    expect(await Promise.all(requests)).toEqual([0, 1].map((nonce) => Uint8Array.of(nonce)));
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('starts a fresh worker when the last one runs out of memory', async () => {
    const created = pool(1);
    const result = created.ticket('set@1', publicKey, 3);
    const [failed] = ControlledWorker.instances;
    failed.runOutOfMemory();
    expect(terminated(failed)).toBe(1);
    const fresh = ControlledWorker.instances[1];
    expect(fresh.requests.map((request) => request.nonce)).toEqual([3]);
    fresh.reply();
    expect(await result).toEqual(Uint8Array.of(3));
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('gives up with a memory error after repeated failures, then keeps serving tickets', async () => {
    const created = pool(1);
    const outcome = created.ticket('set@1', publicKey, 3).catch((error: unknown) => error);
    for (let attempt = 0; attempt < MAX_OOM_ATTEMPTS; attempt++) ControlledWorker.instances[attempt].runOutOfMemory();
    const error = await outcome;
    expect(error).toBeInstanceOf(TicketMemoryError);
    expect((error as TicketMemoryError).message).toBe('This device ran out of memory. Close other tabs and try again.');
    expect((error as TicketMemoryError).detail).toBe(OOM);
    expect(ControlledWorker.instances).toHaveLength(MAX_OOM_ATTEMPTS + 1);
    expect(running()).toHaveLength(1);
    const next = created.ticket('set@1', publicKey, 4);
    running()[0].reply();
    expect(await next).toEqual(Uint8Array.of(4));
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('replaces each worker after a few tickets and never runs more workers than its size', async () => {
    const created = pool(2);
    const total = TICKETS_PER_WORKER * 3;
    const requests = Array.from({ length: total }, (_, nonce) => created.ticket('set@1', publicKey, nonce));
    for (let done = 0; done < total; done++) {
      expect(running().length).toBeLessThanOrEqual(2);
      running().find((worker) => worker.requests.length > worker.answered)!.reply();
    }
    expect(await Promise.all(requests)).toEqual(Array.from({ length: total }, (_, nonce) => Uint8Array.of(nonce)));
    expect(running()).toHaveLength(2);
    const retired = ControlledWorker.instances.filter((worker) => terminated(worker) > 0);
    expect(retired.length).toBeGreaterThanOrEqual(2);
    expect(retired.every((worker) => terminated(worker) === 1 && worker.requests.length === TICKETS_PER_WORKER)).toBe(true);
    expect(ControlledWorker.instances.every((worker) => worker.requests.length <= TICKETS_PER_WORKER)).toBe(true);
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('rejects cleanly and leaves no worker running when closed after a recycle and a retry', async () => {
    const created = pool(1);
    const requests = Array.from({ length: TICKETS_PER_WORKER + 2 }, (_, nonce) => created.ticket('set@1', publicKey, nonce));
    const outcomes = Promise.allSettled(requests);
    for (let i = 0; i < TICKETS_PER_WORKER; i++) ControlledWorker.instances[0].reply();
    // Recycled: a replacement took the next ticket, then ran out of memory and handed it on.
    expect(ControlledWorker.instances).toHaveLength(2);
    ControlledWorker.instances[1].runOutOfMemory();
    expect(ControlledWorker.instances).toHaveLength(3);
    const retry = ControlledWorker.instances[2];
    expect(retry.requests.map((request) => request.nonce)).toEqual([TICKETS_PER_WORKER]);
    const lateReply = retry.onmessage!;
    created.close();
    lateReply({ data: { id: retry.requests[0].id, ticket: Uint8Array.of(99) } } as MessageEvent<TicketResponse>);
    const settled = await outcomes;
    expect(settled.slice(0, TICKETS_PER_WORKER)).toEqual(
      Array.from({ length: TICKETS_PER_WORKER }, (_, nonce) => ({ status: 'fulfilled', value: Uint8Array.of(nonce) })),
    );
    expect(settled.slice(TICKETS_PER_WORKER)).toEqual(
      Array.from({ length: 2 }, () => ({ status: 'rejected', reason: new Error('Ticket pool closed') })),
    );
    expect(ControlledWorker.instances).toHaveLength(3);
    expect(ControlledWorker.instances.every((worker) => terminated(worker) === 1)).toBe(true);
    expect(computeTicket).not.toHaveBeenCalled();
  });

  it('reports a main-thread out-of-memory failure as a memory error', async () => {
    vi.stubGlobal('Worker', undefined);
    const created = pool();
    const result = created.ticket('set@1', publicKey, 0);
    computations[0].reject(new RangeError('WebAssembly.Memory(): could not allocate memory'));
    await expect(result).rejects.toBeInstanceOf(TicketMemoryError);
  });

  it('recognises the ways browsers report running out of memory, and nothing else', () => {
    for (const message of [
      OOM,
      'RangeError: WebAssembly.Memory(): could not allocate memory',
      'RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded',
      'RangeError: Array buffer allocation failed',
      'RangeError: Invalid typed array length: 4294967296',
      'RangeError: out of memory',
      'InternalError: out of memory',
      'Error: Out of memory',
    ]) expect(isOutOfMemory(message), message).toBe(true);
    for (const message of [
      'invalid ticket input',
      'Error: Invalid nonce',
      'RangeError: Maximum call stack size exceeded',
      'TypeError: Failed to fetch dynamically imported module',
    ]) expect(isOutOfMemory(message), message).toBe(false);
  });
});

describe('pool size', () => {
  const size = (deviceMemory: number | undefined, hardwareConcurrency: number) => {
    vi.stubGlobal('navigator', { deviceMemory, hardwareConcurrency });
    return poolSize();
  };

  it('stays small when the browser does not report memory', () => {
    expect(size(undefined, 16)).toBe(2);
    expect(size(undefined, 2)).toBe(1);
  });

  it('keeps the reported-memory tiers, one worker per spare core', () => {
    expect(size(8, 16)).toBe(8);
    expect(size(8, 4)).toBe(3);
    expect(size(4, 16)).toBe(4);
  });

  it('gives small devices 2 workers and phones at most 4', () => {
    expect(size(2, 8)).toBe(2);
    expect(size(0.5, 8)).toBe(2);
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8, userAgentData: { mobile: true } });
    expect(poolSize()).toBe(4);
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8, userAgentData: { mobile: false } });
    expect(poolSize()).toBe(7);
  });
});

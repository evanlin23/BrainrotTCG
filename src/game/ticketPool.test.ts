import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTicket, toHex } from '../engine';
import type { TicketRequest, TicketResponse } from '../workers/ticket.worker';
import { createTicketPool, poolSize, type TicketPool } from './ticketPool';

vi.mock('../engine', async (importOriginal) => ({
  ...await importOriginal<typeof import('../engine')>(),
  computeTicket: vi.fn(),
}));

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  static failAt: number | null = null;
  onmessage: ((event: MessageEvent<TicketResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: TicketRequest[] = [];
  failPosts = false;
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
    this.onmessage?.({ data: response ?? { id: request.id, ticket: Uint8Array.of(request.nonce) } } as MessageEvent<TicketResponse>);
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
});

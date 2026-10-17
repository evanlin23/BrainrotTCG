/**
 * Several ticket workers at once, for verifying a whole profile (hundreds of tickets). Each worker
 * needs 32 MiB, so the pool stays small. Separate from ticketMiner, which keeps one worker for
 * opening packs so that never waits behind a long verification.
 */
import { computeTicket, toHex } from '../engine';
import type { TicketRequest, TicketResponse } from '../workers/ticket.worker';

export interface TicketPool {
  ticket: (setKey: string, publicKey: Uint8Array, nonce: number) => Promise<Uint8Array>;
  /** Stop every worker; pending tickets reject. */
  close: () => void;
  size: number;
}

/**
 * Tickets a worker computes before the pool replaces it. Each ticket builds about three fresh Wasm
 * instances in hash-wasm (Argon2's 33 MiB memory and two BLAKE2b hashers). A dead instance keeps
 * its memory and address-space reservation until that worker's own garbage collector frees it, and
 * one worker never collects another's, so a long verification on a phone ran out of Wasm memory.
 * Ending a worker frees everything it held at once. Four tickets caps a worker's leftovers at about
 * a dozen instances, and starting a worker (tens of milliseconds) is small next to four Argon2 runs
 * (about a second on a phone).
 */
export const TICKETS_PER_WORKER = 4;

/** Tries per ticket, each on a different worker, while workers run out of memory. */
export const MAX_OOM_ATTEMPTS = 3;

const NO_MEMORY = /out of memory|(?:cannot|could not|couldn't|failed to|unable to) allocate|allocation failed/i;
const WASM_RANGE = /RangeError\b.*\b(?:WebAssembly|wasm|memory|buffer|typed array)/i;

/**
 * Whether an error's text means the browser had no memory to give, e.g. Chrome's "RangeError:
 * WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance". Workers
 * send errors as text, so this matches the text rather than the error's type.
 */
export const isOutOfMemory = (message: string) => NO_MEMORY.test(message) || WASM_RANGE.test(message);

/** A ticket that ran out of memory on fresh workers too. `detail` keeps the browser's own error. */
export class TicketMemoryError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super('This device ran out of memory. Close other tabs and try again.');
    this.name = 'TicketMemoryError';
    this.detail = detail;
  }
}

const toError = (error: unknown): Error => {
  if (error instanceof TicketMemoryError) return error;
  const text = String(error);
  if (isOutOfMemory(text)) return new TicketMemoryError(text);
  return error instanceof Error ? error : new Error(text);
};

/**
 * One worker per spare core, up to 8 where there's memory for it (32 MiB each), else 4. Browsers
 * that don't report memory (Safari, Firefox, so every iPhone) and devices under 4 GB get 2: the
 * phone may be a small one. Phones get at most 4 even with 8 GB, because Wasm memory comes out of
 * the tab's address space, which is far smaller on Android than on a desktop.
 */
export const poolSize = () => {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  const memory = nav.deviceMemory;
  const phone = nav.userAgentData?.mobile === true;
  const cap = memory === undefined || memory < 4 ? 2 : memory >= 8 && !phone ? 8 : 4;
  return Math.max(1, Math.min(cap, (nav.hardwareConcurrency || 2) - 1));
};

export const createTicketPool = (size = poolSize()): TicketPool => {
  type Job = {
    request: TicketRequest;
    publicKey: Uint8Array;
    resolve: (t: Uint8Array) => void;
    reject: (e: Error) => void;
    /** Workers that ran out of memory on this ticket. */
    outOfMemory: number;
  };
  const queue: Job[] = [];
  const busy = new Map<Worker, Job>();
  const idle: Worker[] = [];
  const workers: Worker[] = [];
  /** Tickets each live worker has answered, for recycling. */
  const served = new Map<Worker, number>();
  let fallback: Job | null = null;
  let closed = false;
  let nextId = 0;

  const retire = (worker: Worker) => {
    const index = workers.indexOf(worker);
    if (index === -1) return;
    workers.splice(index, 1);
    served.delete(worker);
    const idleIndex = idle.indexOf(worker);
    if (idleIndex !== -1) idle.splice(idleIndex, 1);
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    const job = busy.get(worker);
    busy.delete(worker);
    if (job) queue.unshift(job);
  };

  const pump = () => {
    while (!closed && idle.length > 0 && queue.length > 0) {
      const worker = idle.pop()!;
      const job = queue.shift()!;
      busy.set(worker, job);
      try {
        worker.postMessage(job.request);
      } catch {
        retire(worker);
      }
    }
    // Argon2 needs 32 MiB per job. Without workers, share one tracked slot rather than
    // starting every queued verification on the main thread at once.
    if (closed || workers.length > 0 || fallback || queue.length === 0) return;
    const job = queue.shift()!;
    fallback = job;
    void (async () => {
      try {
        const ticket = await computeTicket(job.request.setKey, job.publicKey, job.request.nonce);
        if (!closed) job.resolve(ticket);
      } catch (error) {
        if (!closed) job.reject(toError(error));
      } finally {
        // close() cannot abort a running computation, but its late completion must not
        // settle consumers or start another computation.
        if (fallback === job) {
          fallback = null;
          pump();
        }
      }
    })();
  };

  /** Start a worker and make it idle. False when the browser won't start one. */
  const spawn = (): boolean => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/ticket.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return false;
    }
    worker.onmessage = (event: MessageEvent<TicketResponse>) => {
      const job = busy.get(worker);
      if (closed || !job || job.request.id !== event.data.id) return;
      busy.delete(worker);
      const response = event.data;
      if ('error' in response && isOutOfMemory(response.error)) {
        // Ending the worker frees all its memory. Try the ticket again on another worker, but run
        // on fewer workers rather than replace this one, unless it was the last.
        retire(worker);
        if (++job.outOfMemory >= MAX_OOM_ATTEMPTS) job.reject(new TicketMemoryError(response.error));
        else queue.unshift(job);
        if (workers.length === 0) spawn();
        pump();
        return;
      }
      if ('ticket' in response) job.resolve(response.ticket);
      else job.reject(new Error(response.error));
      const count = (served.get(worker) ?? 0) + 1;
      if (count >= TICKETS_PER_WORKER) {
        // Swap in a fresh worker before its garbage piles up (see TICKETS_PER_WORKER).
        retire(worker);
        spawn();
      } else {
        served.set(worker, count);
        idle.push(worker);
      }
      pump();
    };
    // A failed worker's job rejoins the queue; remaining workers or the fallback take it.
    worker.onerror = (event) => {
      event.preventDefault();
      if (closed) return;
      retire(worker);
      pump();
    };
    workers.push(worker);
    served.set(worker, 0);
    idle.push(worker);
    return true;
  };

  for (let i = 0; i < size; i++) if (!spawn()) break;

  return {
    size: Math.max(1, workers.length),
    ticket: (setKey, publicKey, nonce) => {
      if (closed) return Promise.reject(new Error('Ticket pool closed'));
      return new Promise((resolve, reject) => {
        const request = { id: nextId++, setKey, publicKeyHex: toHex(publicKey), nonce };
        queue.push({ request, publicKey, resolve, reject, outOfMemory: 0 });
        pump();
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const worker of workers) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      }
      const stopped = new Error('Ticket pool closed');
      for (const job of [...queue.splice(0), ...busy.values()]) job.reject(stopped);
      fallback?.reject(stopped);
      fallback = null;
      busy.clear();
      idle.length = 0;
      workers.length = 0;
      served.clear();
    },
  };
};

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
 * One worker per spare core, up to 8 where there's memory for it (32 MiB each), else 4. Browsers
 * that don't report memory (Safari, Firefox, so every iPhone) get 2: the phone may be a small one.
 */
export const poolSize = () => {
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  const cap = memory === undefined ? 2 : memory >= 8 ? 8 : 4;
  return Math.max(1, Math.min(cap, (navigator.hardwareConcurrency || 2) - 1));
};

export const createTicketPool = (size = poolSize()): TicketPool => {
  type Job = { request: TicketRequest; publicKey: Uint8Array; resolve: (t: Uint8Array) => void; reject: (e: Error) => void };
  const queue: Job[] = [];
  const busy = new Map<Worker, Job>();
  const idle: Worker[] = [];
  const workers: Worker[] = [];
  let fallback: Job | null = null;
  let closed = false;
  let nextId = 0;

  const retire = (worker: Worker) => {
    const index = workers.indexOf(worker);
    if (index === -1) return;
    workers.splice(index, 1);
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
        if (!closed) job.reject(error instanceof Error ? error : new Error(String(error)));
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

  for (let i = 0; i < size; i++) {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/ticket.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      break;
    }
    worker.onmessage = (event: MessageEvent<TicketResponse>) => {
      const job = busy.get(worker);
      if (closed || !job || job.request.id !== event.data.id) return;
      busy.delete(worker);
      idle.push(worker);
      if ('ticket' in event.data) job.resolve(event.data.ticket);
      else job.reject(new Error(event.data.error));
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
    idle.push(worker);
  }

  return {
    size: Math.max(1, workers.length),
    ticket: (setKey, publicKey, nonce) => {
      if (closed) return Promise.reject(new Error('Ticket pool closed'));
      return new Promise((resolve, reject) => {
        queue.push({ request: { id: nextId++, setKey, publicKeyHex: toHex(publicKey), nonce }, publicKey, resolve, reject });
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
    },
  };
};

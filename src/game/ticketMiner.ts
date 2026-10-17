/**
 * Computes tickets in a Web Worker, one at a time (each needs 32 MiB), with a
 * small cache so the next pack can be mined while the current one is on screen.
 * Tickets for opening packs go first; optional ones (checking someone's pull) wait
 * their turn, take an optional slot (./admission) and aren't cached, so they can't
 * push out the next pack's ticket.
 */
import { computeTicket, toHex } from '../engine';
import type { TicketRequest, TicketResponse } from '../workers/ticket.worker';
import { holdLive, requestSlot, stopped } from './admission';
import { isOutOfMemory, TicketMemoryError } from './ticketPool';

type Pending = {
  resolve: (t: Uint8Array) => void;
  reject: (e: Error) => void;
  setKey: string;
  publicKey: Uint8Array;
  nonce: number;
  /** Already sent again after its worker ran out of memory. */
  retried?: boolean;
};

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

const getWorker = (): Worker | null => {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('../workers/ticket.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<TicketResponse>) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      if ('ticket' in event.data) job.resolve(event.data.ticket);
      else if (isOutOfMemory(event.data.error)) restart(job, event.data.error);
      else job.reject(new Error(event.data.error));
    };
    // If the worker fails to load or crashes, finish its jobs on the main thread instead of hanging.
    worker.onerror = (event) => {
      event.preventDefault();
      console.warn('Ticket worker failed; mining on the main thread', event.message);
      worker?.terminate();
      worker = null;
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) computeTicket(job.setKey, job.publicKey, job.nonce).then(job.resolve, job.reject);
    };
  } catch {
    worker = null; // no worker support: fall back to the main thread
  }
  return worker;
};

const send = (job: Pending) => {
  const w = getWorker();
  if (!w) {
    computeTicket(job.setKey, job.publicKey, job.nonce).then(job.resolve, job.reject);
    return;
  }
  const id = nextId++;
  pending.set(id, job);
  w.postMessage({ id, setKey: job.setKey, publicKeyHex: toHex(job.publicKey), nonce: job.nonce } satisfies TicketRequest);
};

/**
 * The worker ran out of Wasm memory. Ending it frees everything it held (see ticketPool's
 * TICKETS_PER_WORKER), so its jobs go to a fresh worker and the failed ticket gets one more try.
 */
const restart = (failed: Pending, error: string) => {
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }
  worker = undefined;
  const jobs = [...pending.values()];
  pending.clear();
  if (failed.retried) failed.reject(new TicketMemoryError(error));
  else jobs.unshift({ ...failed, retried: true });
  for (const job of jobs) {
    try {
      send(job);
    } catch (sendError) {
      job.reject(sendError instanceof Error ? sendError : new Error(String(sendError)));
    }
  }
};

const run = (setKey: string, publicKey: Uint8Array, nonce: number): Promise<Uint8Array> => {
  if (!getWorker()) return computeTicket(setKey, publicKey, nonce);
  return new Promise((resolve, reject) => send({ resolve, reject, setKey, publicKey, nonce }));
};

export type Lane = 'live' | 'optional';

interface Job {
  key: string;
  setKey: string;
  publicKey: Uint8Array;
  nonce: number;
  lane: Lane;
  /** Optional callers still waiting for it: once none are, it's dropped if it hasn't started. */
  callers: number;
  promise: Promise<Uint8Array>;
  resolve: (ticket: Uint8Array) => void;
  reject: (error: Error) => void;
}

/** Tickets for opening packs, kept so the next pack is ready. */
const cache = new Map<string, Promise<Uint8Array>>();
/** Optional tickets until they settle. */
const optional = new Map<string, Job>();
const waiting: Job[] = [];
let current: Job | null = null;
let cancelSlot: (() => void) | null = null;
let releaseLive: (() => void) | null = null;

const remember = (job: Job) => {
  cache.set(job.key, job.promise);
  job.promise.catch(() => {
    if (cache.get(job.key) === job.promise) cache.delete(job.key);
  });
  // Keep the cache small: tickets for other sets/nonces are cheap to recompute.
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
};

const start = (job: Job, release: (() => void) | null) => {
  current = job;
  new Promise<Uint8Array>((resolve) => resolve(run(job.setKey, job.publicKey, job.nonce)))
    .then(job.resolve, job.reject)
    .finally(() => {
      current = null;
      if (optional.get(job.key) === job) optional.delete(job.key);
      release?.();
      next();
    });
};

/** Start the next job: a live one if any is waiting, else an optional one once it gets a slot. */
const next = () => {
  if (!current) {
    const live = waiting.findIndex((job) => job.lane === 'live');
    if (live !== -1) {
      cancelSlot?.();
      cancelSlot = null;
      start(waiting.splice(live, 1)[0], null);
    } else if (waiting.length === 0) {
      cancelSlot?.();
      cancelSlot = null;
    } else if (!cancelSlot) {
      cancelSlot = requestSlot((release) => {
        cancelSlot = null;
        if (current || waiting.length === 0) {
          release();
          next();
        } else {
          start(waiting.shift()!, release);
        }
      });
    }
  }
  // While a pack's ticket waits or mines, no optional ticket starts anywhere else either.
  const live = current?.lane === 'live' || waiting.some((job) => job.lane === 'live');
  if (live && !releaseLive) releaseLive = holdLive();
  if (!live && releaseLive) {
    releaseLive();
    releaseLive = null;
  }
};

const drop = (job: Job) => {
  const index = waiting.indexOf(job);
  if (index === -1) return; // already mining: Argon2 can't be stopped part way
  waiting.splice(index, 1);
  optional.delete(job.key);
  job.reject(new Error('Stopped'));
  next();
};

const follow = (job: Job, signal?: AbortSignal): Promise<Uint8Array> => {
  job.callers++;
  if (!signal) return job.promise;
  return new Promise((resolve, reject) => {
    const stop = () => {
      reject(stopped(signal));
      if (--job.callers === 0 && job.lane === 'optional') drop(job);
    };
    signal.addEventListener('abort', stop, { once: true });
    job.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
};

/**
 * Get a ticket, mining it if needed. Jobs run one after another, live ones (opening a pack) first.
 * An optional job stops waiting when `signal` aborts; one already mining runs to the end.
 */
export const getTicket = (
  setKey: string,
  publicKey: Uint8Array,
  nonce: number,
  lane: Lane = 'live',
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const key = `${setKey}|${toHex(publicKey)}|${nonce}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (lane === 'optional' && signal?.aborted) return Promise.reject(stopped(signal));
  let job = optional.get(key);
  if (job && lane === 'live') {
    // A pack is being opened with it: it can't wait behind optional work any more.
    optional.delete(key);
    job.lane = 'live';
    remember(job);
    next();
    return job.promise;
  }
  if (!job) {
    let resolve!: Job['resolve'];
    let reject!: Job['reject'];
    const promise = new Promise<Uint8Array>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    job = { key, setKey, publicKey, nonce, lane, callers: 0, promise, resolve, reject };
    if (lane === 'live') remember(job);
    else optional.set(key, job);
    waiting.push(job);
    next();
  }
  return lane === 'optional' ? follow(job, signal) : job.promise;
};

/** Start mining a ticket in the background (e.g. the next pack while this one is on screen). */
export const prefetchTicket = (setKey: string, publicKey: Uint8Array, nonce: number): void => {
  void getTicket(setKey, publicKey, nonce).catch(() => undefined);
};

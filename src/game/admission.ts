/**
 * Foreground first: optional ticket work (re-opening your packs, checking someone's pulls or
 * profile) never makes opening a pack wait. A new optional ticket starts only while no pack is being
 * opened or swiped and the tab is visible, and at most `optionalLimit()` run at once across every
 * pool. Pausing holds back the next ticket only: an Argon2 run already going can't be stopped, so
 * it finishes first.
 */
import { poolSize } from './ticketPool';

type Start = (release: () => void) => void;

const waiting: { start: Start }[] = [];
let running = 0;
let liveHolds = 0;
let scheduled = false;
let watched: Document | null = null;

/** How many optional tickets may mine at once, across every pool (each needs 32 MiB). */
export const optionalLimit = (): number => poolSize();

const hidden = (): boolean => {
  if (typeof document === 'undefined') return false;
  if (watched !== document) {
    watched = document;
    document.addEventListener('visibilitychange', schedule);
  }
  return document.visibilityState === 'hidden';
};

// Slots are handed out from a microtask, so a caller is never re-entered from its own call.
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(grant);
}

function grant(): void {
  scheduled = false;
  while (waiting.length > 0 && liveHolds === 0 && running < optionalLimit() && !hidden()) {
    const { start } = waiting.shift()!;
    running++;
    let held = true;
    start(() => {
      if (!held) return;
      held = false;
      running--;
      schedule();
    });
  }
}

/** Hold while a pack is being opened or swiped: no optional ticket starts. Returns the release. */
export const holdLive = (): (() => void) => {
  liveHolds++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    liveHolds--;
    schedule();
  };
};

/**
 * Wait for a slot, first come first served. `start` gets it with a release to call once its ticket
 * settles. Returns a cancel for a request that hasn't started (a no-op once it has).
 */
export const requestSlot = (start: Start): (() => void) => {
  const request = { start };
  waiting.push(request);
  schedule();
  return () => {
    const index = waiting.indexOf(request);
    if (index !== -1) waiting.splice(index, 1);
  };
};

export const stopped = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('Stopped');

/**
 * Run `work` once a slot is free; the slot frees when it settles. If `signal` aborts before then,
 * it rejects without running. Once running, the work itself decides how to stop.
 */
export const admitOptional = <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(stopped(signal));
    let started = false;
    let cancel = () => {};
    const onAbort = () => {
      if (started) return;
      cancel();
      reject(stopped(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    cancel = requestSlot((release) => {
      started = true;
      signal?.removeEventListener('abort', onAbort);
      new Promise<T>((done) => done(work())).then(resolve, reject).finally(release);
    });
  });

/** For tests. */
export const resetAdmission = () => {
  waiting.length = 0;
  running = 0;
  liveHolds = 0;
};

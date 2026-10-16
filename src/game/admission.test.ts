import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Admission = typeof import('./admission');
let admission: Admission;

/** Let every queued microtask (slot grants, settled work) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Task {
  runs: number;
  promise: Promise<string>;
  finish: () => void;
  fail: (error: Error) => void;
}

/** Optional work the test finishes by hand. `runs` counts how often it was started. */
const task = (signal?: AbortSignal): Task => {
  let finish = () => {};
  let fail: (error: Error) => void = () => {};
  const t = { runs: 0 } as Task;
  t.promise = admission.admitOptional(() => {
    t.runs++;
    return new Promise<string>((resolve, reject) => {
      finish = () => resolve('done');
      fail = reject;
    });
  }, signal);
  t.promise.catch(() => undefined);
  t.finish = () => finish();
  t.fail = (error) => fail(error);
  return t;
};
const started = (tasks: Task[]) => tasks.map((t) => t.runs);

/** A device with `cores` cores and no memory report: the limit is min(2, cores - 1). */
const device = (cores: number) => vi.stubGlobal('navigator', { hardwareConcurrency: cores });

beforeEach(async () => {
  vi.resetModules();
  admission = await import('./admission');
  device(8);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('optional work admission', () => {
  it('runs at most the limit at once, first come first served', async () => {
    expect(admission.optionalLimit()).toBe(2);
    const tasks = Array.from({ length: 5 }, () => task());
    await flush();
    expect(started(tasks)).toEqual([1, 1, 0, 0, 0]);
    tasks[1].finish();
    await flush();
    expect(started(tasks)).toEqual([1, 1, 1, 0, 0]);
    tasks[0].finish();
    tasks[2].finish();
    await flush();
    expect(started(tasks)).toEqual([1, 1, 1, 1, 1]);
    tasks[3].finish();
    tasks[4].finish();
    expect(await Promise.all(tasks.map((t) => t.promise))).toEqual(Array(5).fill('done'));
  });

  it('starts nothing new while a pack is opened, and lets running work finish', async () => {
    device(2); // limit 1
    const running = task();
    await flush();
    const release = admission.holdLive();
    const held = task();
    await flush();
    expect(started([running, held])).toEqual([1, 0]);
    running.finish();
    await flush();
    expect(await running.promise).toBe('done');
    expect(held.runs).toBe(0);
    const second = admission.holdLive();
    release();
    await flush();
    expect(held.runs).toBe(0);
    second();
    second(); // releasing twice counts once
    await flush();
    expect(held.runs).toBe(1);
    held.finish();
    expect(await held.promise).toBe('done');
  });

  it('pauses while the tab is hidden and resumes each job once when shown', async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: 'hidden' as DocumentVisibilityState });
    vi.stubGlobal('document', page);
    const show = (state: DocumentVisibilityState) => {
      page.visibilityState = state;
      page.dispatchEvent(new Event('visibilitychange'));
    };
    const tasks = Array.from({ length: 3 }, () => task());
    await flush();
    expect(started(tasks)).toEqual([0, 0, 0]);
    show('visible');
    await flush();
    expect(started(tasks)).toEqual([1, 1, 0]);
    show('hidden');
    tasks[0].finish();
    await flush();
    expect(started(tasks)).toEqual([1, 1, 0]);
    show('visible');
    show('visible');
    await flush();
    expect(started(tasks)).toEqual([1, 1, 1]);
    tasks[1].finish();
    tasks[2].finish();
    await Promise.all(tasks.map((t) => t.promise));
    expect(started(tasks)).toEqual([1, 1, 1]);
  });

  it('drops a stopped job that has not started without using a slot', async () => {
    device(2); // limit 1
    const running = task();
    const stop = new AbortController();
    const stopped = task(stop.signal);
    const after = task();
    await flush();
    stop.abort(new Error('Left the page'));
    await expect(stopped.promise).rejects.toThrow('Left the page');
    running.finish();
    await flush();
    expect(started([running, stopped, after])).toEqual([1, 0, 1]);
    after.finish();
    await after.promise;
    const late = new AbortController();
    late.abort();
    await expect(admission.admitOptional(async () => 'never', late.signal)).rejects.toThrow();
  });

  it('frees the slot when work fails, so the next job runs', async () => {
    device(2); // limit 1
    const failing = task();
    const next = task();
    await flush();
    failing.fail(new Error('worker crashed'));
    await expect(failing.promise).rejects.toThrow('worker crashed');
    await flush();
    expect(next.runs).toBe(1);
    next.finish();
    expect(await next.promise).toBe('done');
    // Work that throws before returning a promise frees its slot too.
    await expect(admission.admitOptional(() => { throw new Error('no save'); })).rejects.toThrow('no save');
    const last = task();
    await flush();
    expect(last.runs).toBe(1);
  });
});

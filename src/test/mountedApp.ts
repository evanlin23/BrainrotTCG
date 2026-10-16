import type { act as reactAct, ComponentType } from 'react';
import type { Root } from 'react-dom/client';
import { expect, vi } from 'vitest';
import type { TicketRequest, TicketResponse } from '../workers/ticket.worker';

// framer-motion is a dependency, so vi.resetModules doesn't re-evaluate it, and its frame loop keeps
// the requestAnimationFrame it first saw. Hand it one that schedules on whichever fake clock is
// current, so a second mount in the same file still animates.
let fakeFrame: typeof requestAnimationFrame;
const onFakeFrame = (callback: FrameRequestCallback) => fakeFrame(callback);

/**
 * How the simulated worker answers one ticket request; undefined computes and delivers it at once.
 * delayMs delivers the real ticket that long later on the fake clock; error replies as a failed
 * computation does; crash fires the worker's error event, as a worker that fails to load does.
 */
export type TicketReply = { delayMs: number } | { error: string } | 'crash';

/** jsdom only: no resource loading, native media, canvas, Worker or IndexedDB claims. */
export async function mountedApp(storage: Record<string, string>,
  options: { tickets?: (request: TicketRequest) => TicketReply | undefined } = {}) {
  const errors: string[] = [];
  const jobs = new Set<Promise<unknown>>();
  const track = (job: Promise<unknown>) => {
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };
  const workers = new Set<TicketWorker>();
  const ticketRequests: TicketRequest[] = [];
  let root: Root | undefined;
  let act: typeof reactAct;
  let container: HTMLDivElement;
  let loadRoot: () => Promise<{ default: ComponentType }> = () => import('../App');

  vi.resetModules();
  history.replaceState(null, '', '/BrainrotTCG/');
  localStorage.clear();
  sessionStorage.clear();
  for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  fakeFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = onFakeFrame; // vi.useRealTimers() puts the real one back.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const blocked = (api: string) => () => {
    const error = `Unexpected external I/O: ${api}`;
    errors.push(error);
    throw new Error(error);
  };
  vi.stubGlobal('fetch', vi.fn(blocked('fetch')));
  vi.stubGlobal('WebSocket', class { constructor() { blocked('WebSocket')(); } });
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(blocked('XMLHttpRequest'));
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('open', blocked('window.open'));
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  if ('sendBeacon' in navigator) vi.spyOn(navigator, 'sendBeacon').mockImplementation(blocked('sendBeacon'));
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(blocked('form.submit'));
  vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(blocked('form.requestSubmit'));
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query, matches: false, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => true,
  }));
  for (const method of ['error', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(' ')));
  }

  // Same protocol as ticket.worker.ts, with the real Argon2 computation. Track prefetches too:
  // terminating the simulated worker prevents delivery; teardown awaits outstanding computation.
  class TicketWorker {
    onmessage: ((event: { data: TicketResponse }) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    closed = false;
    constructor() { workers.add(this); }
    postMessage(request: TicketRequest) {
      ticketRequests.push(request);
      const reply = options.tickets?.(request);
      const deliver = (data: TicketResponse) => { if (!this.closed) this.onmessage?.({ data }); };
      if (reply === 'crash' || (reply && 'error' in reply)) {
        track(Promise.resolve().then(() => {
          if (reply !== 'crash') deliver({ id: request.id, error: reply.error });
          else if (!this.closed) this.onerror?.(new ErrorEvent('error', { message: 'Simulated worker crash', cancelable: true }));
        }));
        return;
      }
      track(import('../engine').then(async ({ computeTicket, fromHex }) => {
        const ticket = await computeTicket(request.setKey, fromHex(request.publicKeyHex), request.nonce);
        if (reply) setTimeout(() => deliver({ id: request.id, ticket }), reply.delayMs);
        else deliver({ id: request.id, ticket });
      }).catch((error: unknown) => {
        errors.push(`Ticket worker: ${String(error)}`);
        deliver({ id: request.id, error: String(error) });
      }));
    }
    terminate() { this.closed = true; workers.delete(this); }
  }
  vi.stubGlobal('Worker', TicketWorker);

  async function unmount() {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    for (const worker of workers) worker.terminate();
    await Promise.all([...jobs]);
    // Let framer-motion's scheduled frame run first: if it is cleared, its loop stays flagged as
    // scheduled and never wakes for a later mount in the same file.
    vi.advanceTimersToNextFrame();
    vi.clearAllTimers();
    document.body.replaceChildren();
    document.body.className = '';
    document.documentElement.removeAttribute('data-card-back');
    document.documentElement.removeAttribute('data-pack-foil');
  }

  async function mount(load = loadRoot) {
    loadRoot = load;
    // All React imports must belong to this fresh graph, including act and the renderer.
    const React = await import('react');
    act = React.act;
    const { createRoot } = await import('react-dom/client');
    const { MotionConfig } = await import('framer-motion');
    // The adapter cannot decode/rasterize images. Preserve src and finish props above this boundary.
    const images = await import('../game/finishImage');
    vi.spyOn(images, 'holdFinishedCardImage').mockImplementation((src) => ({ image: Promise.resolve(src), release: () => {} }));
    // After a worker failure the miner computes on the main thread: await that real work too.
    const engine = await import('../engine');
    const compute = engine.computeTicket;
    vi.spyOn(engine, 'computeTicket').mockImplementation((...args) => {
      const job = compute(...args);
      track(job.catch(() => undefined));
      return job;
    });
    const { runMigrations } = await import('../utils/migrations');
    const { migratePullLog } = await import('../game/history');
    runMigrations();
    migratePullLog();
    const { default: App } = await loadRoot();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(React.createElement(React.StrictMode, null,
      React.createElement(MotionConfig, { reducedMotion: 'user' }, React.createElement(App)))));
  }

  return {
    mount,
    /** Every request posted to a simulated ticket worker, prefetches included. */
    ticketRequests,
    async reload() {
      await unmount();
      const saved = Object.fromEntries(Object.entries(localStorage));
      vi.resetModules();
      localStorage.clear();
      for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
      await mount();
    },
    async interact(action: () => void) { await act(async () => action()); },
    /** Removes and returns the console errors a test expects; dispose still fails on any others. */
    takeErrors(pattern: RegExp) {
      const taken = errors.filter((error) => pattern.test(error));
      const rest = errors.filter((error) => !pattern.test(error));
      errors.splice(0, errors.length, ...rest);
      return taken;
    },
    async until(description: string, assertion: () => void | Promise<void>) {
      let last: unknown;
      // Advance simulated animation time inside act, polling only the named observable outcome.
      // Await real ticket computation in the same act scope; never retry the interaction itself.
      for (let elapsed = 0; elapsed < 10_000; elapsed += 25) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(25);
          await vi.dynamicImportSettled();
          await Promise.all([...jobs]);
        });
        try { await assertion(); return; } catch (error) { last = error; }
      }
      throw new Error(`${description}: ${String(last)}; errors: ${errors.join('; ')}; DOM: ${document.body.innerHTML.slice(-3000)}`);
    },
    /** Advances simulated time for a fixed span, awaiting tickets as until does, so a test can show nothing happened. */
    async settle(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 25) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(25);
          await vi.dynamicImportSettled();
          await Promise.all([...jobs]);
        });
      }
    },
    async dispose() {
      try {
        await unmount();
        expect(errors, 'unexpected console errors or external I/O').toEqual([]);
      } finally {
        localStorage.clear();
        sessionStorage.clear();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    },
  };
}

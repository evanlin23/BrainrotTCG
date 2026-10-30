// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The toasts chunk is what App warms ahead of the first pack: evaluating this factory is that fetch.
const toasts = vi.hoisted(() => ({ fetches: 0, hold: false, resolve: () => {} }));
vi.mock('./components/pack/PackOpener', () => ({ default: () => null }));

let container: HTMLDivElement;
let root: Root;
let packArtSettled: () => void;

// Each test gets fresh modules: the sealed pack's art settles once per page load, and the toasts loader caches.
beforeEach(async () => {
  vi.resetModules();
  toasts.fetches = 0;
  toasts.hold = false;
  // Registered again for every fresh module graph: a vi.mock factory's result is cached across resetModules.
  vi.doMock('./components/achievements/AchievementToasts', async () => {
    toasts.fetches += 1;
    if (toasts.hold) await new Promise<void>((resolve) => { toasts.resolve = resolve; });
    return { default: () => null };
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.useFakeTimers();
  localStorage.clear();
  window.location.hash = '';
  ({ packArtSettled } = await import('./game/packArt'));
  const { default: App } = await import('./App');
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(() => {
  vi.doUnmock('./components/achievements/AchievementToasts');
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = '';
});

/** Let every timer the page has pending fire, and any chunk they fetch settle. */
const idle = async () => {
  await vi.runAllTimersAsync();
  await vi.dynamicImportSettled();
};

it('warms the toasts ahead of the first pack once the art has settled and the page is idle', async () => {
  expect(toasts.fetches).toBe(0);
  packArtSettled();
  await vi.advanceTimersByTimeAsync(0);
  expect(toasts.fetches).toBe(0);
  await idle();
  expect(toasts.fetches).toBe(1);
  await act(async () => root.unmount());
});

it('reports toast readiness only after the pending module has resolved', async () => {
  toasts.hold = true;
  packArtSettled();
  await vi.runAllTimersAsync();
  await vi.waitFor(() => expect(toasts.fetches).toBe(1));
  expect(container.querySelector('.app')?.hasAttribute('data-toasts-ready')).toBe(false);
  await act(async () => {
    toasts.resolve();
    await vi.dynamicImportSettled();
  });
  expect(container.querySelector('.app')?.getAttribute('data-toasts-ready')).toBe('true');
  await act(async () => root.unmount());
});

it('starts no warm-up after it unmounts before the sealed pack art settles', async () => {
  await act(async () => root.unmount());
  packArtSettled();
  await vi.advanceTimersByTimeAsync(0);
  await idle();
  expect(toasts.fetches).toBe(0);
});

it('cancels the pending idle wait when it unmounts after the art has settled', async () => {
  packArtSettled();
  await vi.advanceTimersByTimeAsync(0);
  await act(async () => root.unmount());
  await idle();
  expect(toasts.fetches).toBe(0);
});

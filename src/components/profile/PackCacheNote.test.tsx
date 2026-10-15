// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PackCacheNote from './PackCacheNote';

const cache = vi.hoisted(() => ({ state: 'failed', listeners: new Set<() => void>(), version: 0 }));
const hydrateMyPacks = vi.hoisted(() => vi.fn());
vi.mock('../../game/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/profiles')>()),
  myPackCacheState: () => cache.state,
  packCacheVersion: () => cache.version,
  onPackCacheChange: (listener: () => void) => {
    cache.listeners.add(listener);
    return () => cache.listeners.delete(listener);
  },
  hydrateMyPacks,
}));

const setState = (state: string) => {
  cache.state = state;
  cache.version += 1;
  for (const listener of cache.listeners) listener();
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  cache.state = 'failed';
  // Like the real reader: retrying flips the state to loading straight away.
  hydrateMyPacks.mockReset().mockImplementation(() => {
    setState('loading');
    return new Promise(() => {});
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('PackCacheNote', () => {
  it('keeps focus on the note when "Try again" goes away while the read runs', () => {
    act(() => root.render(<PackCacheNote what="your level and stats" />));
    const note = container.querySelector<HTMLElement>('.pulls-note')!;
    const retry = [...container.querySelectorAll('button')].find((el) => el.textContent === 'Try again')!;
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't read your saved packs");
    retry.focus();
    act(() => retry.click());
    expect(hydrateMyPacks).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('.pulls-note')).toBe(note);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Reading your saved packs');
    expect(document.activeElement).toBe(note);

    act(() => setState('failed'));
    expect(container.querySelector('.pulls-note')).toBe(note);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

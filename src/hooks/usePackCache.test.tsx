// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePackCacheVersion } from './usePackCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real cache only changes while saved packs load, so the hook is driven through a stand-in with the same two functions.
const cache = vi.hoisted(() => ({
  version: 0,
  listeners: new Set<() => void>(),
  subscribed: 0,
  unsubscribed: 0,
}));
vi.mock('../game/profiles', () => ({
  packCacheVersion: () => cache.version,
  onPackCacheChange: (listener: () => void) => {
    cache.listeners.add(listener);
    cache.subscribed++;
    return () => {
      cache.listeners.delete(listener);
      cache.unsubscribed++;
    };
  },
}));

let root: Root;
let seen: number[];

const Probe = () => {
  seen.push(usePackCacheVersion());
  return null;
};
/** What the cache does on a state change: bump the version, then tell the listeners. */
const change = (bump = true) =>
  act(() => {
    if (bump) cache.version++;
    cache.listeners.forEach((listener) => listener());
  });

beforeEach(() => {
  cache.version = 0;
  cache.listeners.clear();
  cache.subscribed = 0;
  cache.unsubscribed = 0;
  seen = [];
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
});

describe('usePackCacheVersion', () => {
  it('starts at the cache version it finds', () => {
    cache.version = 4;
    act(() => root.render(<Probe />));
    expect(seen).toEqual([4]);
  });

  it('subscribes once and renders with each new version', () => {
    act(() => root.render(<Probe />));
    expect(cache.subscribed).toBe(1);

    change();
    change();
    expect(seen).toEqual([0, 1, 2]);
    expect(cache.subscribed).toBe(1);
  });

  it('does not render again when the cache tells it nothing changed', () => {
    act(() => root.render(<Probe />));
    change(false);
    expect(seen).toEqual([0]);
  });

  it('picks up a version that changed between rendering and subscribing', () => {
    // A load finishing in a sibling's effect, which runs before this hook's subscription is made.
    const Mover = () => {
      useEffect(() => {
        cache.version = 9;
      }, []);
      return null;
    };
    act(() =>
      root.render(
        <>
          <Mover />
          <Probe />
        </>,
      ),
    );
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(9);
  });

  it('keeps every mounted consumer on the same version', () => {
    const Two = () => (
      <>
        <Probe />
        <Probe />
      </>
    );
    act(() => root.render(<Two />));
    expect(cache.listeners.size).toBe(2);
    change();
    expect(seen.slice(-2)).toEqual([1, 1]);
  });

  it('unsubscribes on unmount, with nothing left listening', () => {
    act(() => root.render(<Probe />));
    act(() => root.unmount());
    expect(cache.unsubscribed).toBe(1);
    expect(cache.listeners.size).toBe(0);
    root = createRoot(document.createElement('div'));
  });

  it('does not resubscribe when the component re-renders for another reason', () => {
    act(() => root.render(<Probe />));
    act(() => root.render(<Probe />));
    expect(cache.subscribed).toBe(1);
    expect(cache.unsubscribed).toBe(0);
  });
});

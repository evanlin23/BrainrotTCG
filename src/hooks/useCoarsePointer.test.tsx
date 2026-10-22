// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCoarsePointer } from './useCoarsePointer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUERY = '(pointer: coarse)';

let coarse = false;
let listeners: Set<() => void>;
let matchMedia: ReturnType<typeof vi.fn>;
let addEventListener: ReturnType<typeof vi.fn>;
let removeEventListener: ReturnType<typeof vi.fn>;
let root: Root;
let seen: boolean[];

const Probe = () => {
  seen.push(useCoarsePointer());
  return null;
};
const setCoarse = (value: boolean) =>
  act(() => {
    coarse = value;
    listeners.forEach((listener) => listener());
  });

beforeEach(() => {
  coarse = false;
  listeners = new Set();
  seen = [];
  addEventListener = vi.fn((_type: string, listener: () => void) => listeners.add(listener));
  removeEventListener = vi.fn((_type: string, listener: () => void) => listeners.delete(listener));
  matchMedia = vi.fn((query: string) => ({ matches: query === QUERY && coarse, addEventListener, removeEventListener }));
  vi.stubGlobal('matchMedia', matchMedia);
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('useCoarsePointer', () => {
  it.each([false, true])('reads the (pointer: coarse) query on mount: %s', (value) => {
    coarse = value;
    act(() => root.render(<Probe />));
    expect(seen[seen.length - 1]).toBe(value);
    expect(matchMedia).toHaveBeenCalledWith(QUERY);
  });

  it('listens for "change" on the query once, and follows it without a remount', () => {
    act(() => root.render(<Probe />));
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(listeners.size).toBe(1);

    setCoarse(true);
    expect(seen[seen.length - 1]).toBe(true);
    setCoarse(false);
    expect(seen[seen.length - 1]).toBe(false);
    expect(addEventListener).toHaveBeenCalledTimes(1);
  });

  it('does not render again when the query fires without changing the answer', () => {
    act(() => root.render(<Probe />));
    const renders = seen.length;
    setCoarse(false);
    expect(seen).toHaveLength(renders);
  });

  it('stops listening on unmount, with the same listener it added', () => {
    act(() => root.render(<Probe />));
    const added = addEventListener.mock.calls[0][1];
    act(() => root.unmount());

    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith('change', added);
    expect(listeners.size).toBe(0);

    // Re-create the root for afterEach's unmount.
    root = createRoot(document.createElement('div'));
  });

  it('gives each mounted component its own subscription', () => {
    const Two = () => (
      <>
        <Probe />
        <Probe />
      </>
    );
    act(() => root.render(<Two />));
    expect(listeners.size).toBe(2);
    setCoarse(true);
    expect(seen.slice(-2)).toEqual([true, true]);
  });

  it('answers false when rendering without a browser, whatever the query would say', () => {
    coarse = true;
    const html = renderToString(<Probe />);
    expect(html).toBe('');
    expect(seen).toEqual([false]);
  });
});

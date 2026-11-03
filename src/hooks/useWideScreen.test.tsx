// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWideScreen } from './useWideScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUERY = '(min-width: 900px)';

let wide = false;
let listeners: Set<() => void>;
let matchMedia: ReturnType<typeof vi.fn>;
let addEventListener: ReturnType<typeof vi.fn>;
let removeEventListener: ReturnType<typeof vi.fn>;
let root: Root;
let seen: boolean[];

const Probe = () => {
  seen.push(useWideScreen());
  return null;
};
const setWide = (value: boolean) =>
  act(() => {
    wide = value;
    listeners.forEach((listener) => listener());
  });

beforeEach(() => {
  wide = false;
  listeners = new Set();
  seen = [];
  addEventListener = vi.fn((_type: string, listener: () => void) => listeners.add(listener));
  removeEventListener = vi.fn((_type: string, listener: () => void) => listeners.delete(listener));
  // One object per query, as in a browser: whichever call the hook makes, it reaches the same list.
  const lists = new Map<string, { readonly matches: boolean; addEventListener: typeof addEventListener; removeEventListener: typeof removeEventListener }>();
  matchMedia = vi.fn((query: string) => {
    if (!lists.has(query)) lists.set(query, { get matches() { return query === QUERY && wide; }, addEventListener, removeEventListener });
    return lists.get(query)!;
  });
  vi.stubGlobal('matchMedia', matchMedia);
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('useWideScreen', () => {
  it.each([false, true])('reads the (min-width: 900px) query on mount: %s', (value) => {
    wide = value;
    act(() => root.render(<Probe />));
    expect(seen[seen.length - 1]).toBe(value);
    expect(matchMedia).toHaveBeenCalledWith(QUERY);
  });

  it('listens for "change" on the query once, and follows it without a remount', () => {
    act(() => root.render(<Probe />));
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(listeners.size).toBe(1);

    setWide(true);
    expect(seen[seen.length - 1]).toBe(true);
    setWide(false);
    expect(seen[seen.length - 1]).toBe(false);
    expect(addEventListener).toHaveBeenCalledTimes(1);
  });

  it('does not render again when the query fires without changing the answer', () => {
    act(() => root.render(<Probe />));
    const renders = seen.length;
    setWide(false);
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
    setWide(true);
    expect(seen.slice(-2)).toEqual([true, true]);
  });

  it('answers false when rendering without a browser, whatever the query would say', () => {
    wide = true;
    const html = renderToString(<Probe />);
    expect(html).toBe('');
    expect(seen).toEqual([false]);
  });
});

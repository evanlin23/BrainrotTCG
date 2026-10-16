// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let reduce = false;
const listeners = new Set<() => void>();
let root: Root;
let seen: boolean[];

const Probe = () => {
  seen.push(usePrefersReducedMotion());
  return null;
};
const setReduce = (value: boolean) => act(() => {
  reduce = value;
  listeners.forEach((listener) => listener());
});

beforeEach(() => {
  reduce = false;
  listeners.clear();
  seen = [];
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && reduce,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('usePrefersReducedMotion', () => {
  it('follows the setting when it changes, without a remount', () => {
    act(() => root.render(<Probe />));
    expect(seen[seen.length - 1]).toBe(false);
    setReduce(true);
    expect(seen[seen.length - 1]).toBe(true);
    setReduce(false);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it('reads it on mount, and stops listening on unmount', () => {
    reduce = true;
    act(() => root.render(<Probe />));
    expect(seen[seen.length - 1]).toBe(true);
    expect(listeners.size).toBe(1);
    act(() => root.unmount());
    expect(listeners.size).toBe(0);
    root = createRoot(document.createElement('div'));
  });
});

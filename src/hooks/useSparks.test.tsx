// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSparks } from './useSparks';

const LIFETIME_MS = 620;

type Sparks = ReturnType<typeof useSparks>;
let latest: Sparks;
const Probe = ({ enabled, onRender }: { enabled: boolean; onRender: (sparks: Sparks) => void }) => {
  onRender(useSparks(enabled));
  return null;
};
const record = (sparks: Sparks) => { latest = sparks; };

let reduced = false;
const motionListeners = new Set<() => void>();
const setReducedMotion = (value: boolean) => act(() => {
  reduced = value;
  motionListeners.forEach(listener => listener());
});

let root: Root | null = null;
const render = (enabled: boolean) => act(() => {
  root ??= createRoot(document.createElement('div'));
  root.render(<Probe enabled={enabled} onRender={record} />);
});
const emit = () => act(() => latest.emitSpark(40, 60));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  reduced = false;
  motionListeners.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query === '(prefers-reduced-motion: reduce)' && reduced; },
    addEventListener: (_type: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => motionListeners.delete(listener),
  }));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useSparks', () => {
  it('expires a burst after its lifetime and drops its timers', () => {
    render(true);
    const idle = latest.sparks;
    emit();
    expect(latest.sparks).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(3);

    act(() => vi.advanceTimersByTime(LIFETIME_MS));
    expect(latest.sparks).toHaveLength(0);
    expect(latest.sparks).toBe(idle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('schedules no timers and does no work with particles off or reduced motion', () => {
    const random = vi.spyOn(Math, 'random');
    render(false);
    const empty = latest.sparks;
    emit();
    render(false);
    expect(latest.sparks).toHaveLength(0);
    expect(latest.sparks).toBe(empty);

    render(true);
    setReducedMotion(true);
    emit();
    expect(latest.sparks).toBe(empty);
    expect(random).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears pending timers on unmount', () => {
    render(true);
    emit();
    expect(vi.getTimerCount()).toBe(3);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears pending timers and particles when disabled mid-burst, without reviving them', () => {
    render(true);
    emit();
    render(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(latest.sparks).toHaveLength(0);
    render(true);
    expect(latest.sparks).toHaveLength(0);

    emit();
    expect(vi.getTimerCount()).toBe(3);
    setReducedMotion(true);
    expect(vi.getTimerCount()).toBe(0);
    setReducedMotion(false);
    expect(latest.sparks).toHaveLength(0);
  });
});

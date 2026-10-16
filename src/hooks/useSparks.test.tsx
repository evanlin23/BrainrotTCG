// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSparks } from './useSparks';

const LIFETIME_MS = 620;

type Sparks = ReturnType<typeof useSparks>;
let latest: Sparks;
let renders = 0;
const Probe = ({ enabled, onRender }: { enabled: boolean; onRender: (sparks: Sparks) => void }) => {
  onRender(useSparks(enabled));
  return null;
};
const record = (sparks: Sparks) => { latest = sparks; renders += 1; };

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
  renders = 0;
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
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(LIFETIME_MS));
    expect(latest.sparks).toHaveLength(0);
    expect(latest.sparks).toBe(idle);
    expect(vi.getTimerCount()).toBe(0);
  });

  // One timer serves every burst on screen (#266), where each burst used to have its own.
  it('expires overlapping bursts with one timer, leaving a later burst in place', () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    render(true);
    const idle = latest.sparks;
    emit();
    const firstIds = latest.sparks.map(spark => spark.id);
    act(() => vi.advanceTimersByTime(100));
    emit();
    const secondIds = latest.sparks.slice(3).map(spark => spark.id);
    expect(latest.sparks).toHaveLength(6);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(LIFETIME_MS - 100));
    expect(latest.sparks.map(spark => spark.id)).toEqual(secondIds);
    expect(secondIds.some(id => firstIds.includes(id))).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(100));
    expect(latest.sparks).toBe(idle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires a swipe-long stream of bursts with one timer and a few batched updates (#266)', () => {
    render(true);
    const idle = latest.sparks;
    for (let burst = 0; burst < 60; burst += 1) {
      emit();
      expect(vi.getTimerCount()).toBe(1);
      expect(latest.sparks.length).toBeLessThanOrEqual(220);
      act(() => vi.advanceTimersByTime(10));
    }
    expect(latest.sparks).toHaveLength(180);

    // 60 bursts over 600ms leave in at most one update per 100ms, not one each.
    const before = renders;
    for (let elapsed = 0; elapsed < LIFETIME_MS + 100 && latest.sparks !== idle; elapsed += 10) {
      act(() => vi.advanceTimersByTime(10));
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    }
    expect(latest.sparks).toBe(idle);
    expect(renders - before).toBeLessThanOrEqual(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the expiry timer when cleared', () => {
    render(true);
    const idle = latest.sparks;
    emit();
    act(() => latest.clearSparks());
    expect(latest.sparks).toBe(idle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still expires a burst when the clock goes back', () => {
    render(true);
    const idle = latest.sparks;
    emit();
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    act(() => vi.advanceTimersByTime(LIFETIME_MS));
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
    expect(vi.getTimerCount()).toBe(1);
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
    expect(vi.getTimerCount()).toBe(1);
    setReducedMotion(true);
    expect(vi.getTimerCount()).toBe(0);
    setReducedMotion(false);
    expect(latest.sparks).toHaveLength(0);
  });
});

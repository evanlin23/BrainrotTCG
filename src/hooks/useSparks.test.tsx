// @vitest-environment jsdom
import { act, useEffect, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SPARKS, SPARK_LIFETIME_MS, SPARK_THROTTLE_MS } from './sparkField';
import { useSparks } from './useSparks';

type Sparks = ReturnType<typeof useSparks>;
let latest: Sparks;
let renders = 0;
const SparkCanvas = ({ canvasRef }: { canvasRef: Ref<HTMLCanvasElement> }) => <canvas ref={canvasRef} className="spark-layer" />;
const Probe = ({ enabled }: { enabled: boolean }) => {
  const sparks = useSparks(enabled);
  useEffect(() => {
    latest = sparks;
    renders += 1;
  });
  return <SparkCanvas canvasRef={sparks.sparkCanvasRef} />;
};

let reduced = false;
const motionListeners = new Set<() => void>();
const setReducedMotion = (value: boolean) => act(() => {
  reduced = value;
  motionListeners.forEach(listener => listener());
});

/** Frames the test steps by hand; `time` is what performance.now() reports. */
let time = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const runFrame = () => {
  const [id, callback] = [...frames.entries()][0] ?? [];
  if (id === undefined || !callback) return;
  frames.delete(id);
  callback(time);
};
const tick = (ms: number) => { time += ms; };

let drawImage: ReturnType<typeof vi.fn>;
let getContext: ReturnType<typeof vi.spyOn>;

let root: Root | null = null;
let container: HTMLElement;
const render = (enabled: boolean) => act(() => {
  root ??= createRoot(container);
  root.render(<Probe enabled={enabled} />);
});
const emit = () => act(() => latest.emitSpark(40, 60));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  renders = 0;
  reduced = false;
  time = 1000;
  frames = new Map();
  nextFrame = 1;
  motionListeners.clear();
  container = document.createElement('div');
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query === '(prefers-reduced-motion: reduce)' && reduced; },
    addEventListener: (_type: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => motionListeners.delete(listener),
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(nextFrame, callback); return nextFrame++; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  drawImage = vi.fn();
  const context = { globalAlpha: 1, setTransform: vi.fn(), clearRect: vi.fn(), drawImage, createRadialGradient: () => ({ addColorStop: vi.fn() }), fillRect: vi.fn(), fillStyle: '' };
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useSparks', () => {
  it('draws a burst on its canvas, then stops asking for frames once it has faded', () => {
    render(true);
    emit();
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(frames.size).toBe(1);

    tick(SPARK_LIFETIME_MS + 1);
    runFrame();
    expect(frames.size).toBe(0);
  });

  it('adds no element and no render for a swipe-long stream of bursts', () => {
    render(true);
    const rendersBefore = renders;
    const nodesBefore = container.querySelectorAll('*').length;
    let peakFrames = 0;
    for (let burst = 0; burst < 120; burst += 1) {
      emit();
      peakFrames = Math.max(peakFrames, frames.size);
      tick(SPARK_THROTTLE_MS + 1);
      runFrame();
    }
    expect(renders).toBe(rendersBefore);
    expect(container.querySelectorAll('*')).toHaveLength(nodesBefore);
    expect(peakFrames).toBe(1);
  });

  it('keeps the live sparks at the cap through a long held drag', () => {
    render(true);
    // Each frame redraws every live spark, and a draw is one spark: the most it ever draws is the cap.
    let mostDrawn = 0;
    for (let moves = 0; moves < 300; moves += 1) {
      drawImage.mockClear();
      emit();
      mostDrawn = Math.max(mostDrawn, drawImage.mock.calls.length);
      tick(SPARK_THROTTLE_MS + 1);
      runFrame();
    }
    expect(mostDrawn).toBeGreaterThan(0);
    expect(mostDrawn).toBeLessThanOrEqual(MAX_SPARKS);
  });

  it('cancels its pending frame when cleared', () => {
    render(true);
    emit();
    expect(frames.size).toBe(1);
    act(() => latest.clearSparks());
    expect(frames.size).toBe(0);
  });

  it('cancels its pending frame on unmount', () => {
    render(true);
    emit();
    expect(frames.size).toBe(1);
    act(() => root?.unmount());
    root = null;
    expect(frames.size).toBe(0);
  });

  it('asks for no context, frames or randomness with particles off or reduced motion', () => {
    const random = vi.spyOn(Math, 'random');
    render(false);
    emit();
    setReducedMotion(true);
    render(true);
    emit();
    expect(getContext).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(random).not.toHaveBeenCalled();
  });

  it('wipes mid-burst when disabled, and does not revive the burst when re-enabled', () => {
    render(true);
    emit();
    expect(frames.size).toBe(1);
    render(false);
    expect(frames.size).toBe(0);
    drawImage.mockClear();
    render(true);
    expect(frames.size).toBe(0);
    expect(drawImage).not.toHaveBeenCalled();

    tick(SPARK_THROTTLE_MS + 1);
    emit();
    expect(frames.size).toBe(1);
    setReducedMotion(true);
    expect(frames.size).toBe(0);
    drawImage.mockClear();
    setReducedMotion(false);
    expect(frames.size).toBe(0);
    expect(drawImage).not.toHaveBeenCalled();
  });
});

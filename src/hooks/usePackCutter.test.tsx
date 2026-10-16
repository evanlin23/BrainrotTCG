// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePackCutter } from './usePackCutter';

// A 320 x 573 pack, 100px right and 50px down the viewport. Its tear line sits at 19% of its
// height, and a stroke starts within 45.84px of it (8% of the height).
const rect = { left: 100, top: 50, width: 320, height: 573 };
const tearClientY = rect.top + 0.19 * rect.height;

type Cutter = ReturnType<typeof usePackCutter>;
type Point = { clientX: number; clientY: number };

/** A point `across` of the way over the pack, `below` px under its tear line. */
const at = (across: number, below = 0): Point => ({ clientX: rect.left + across * rect.width, clientY: tearClientY + below });

const pointer = (type: string, point: Point, extra: Partial<PointerEvent> = {}) =>
  ({ type, button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure: 0.5, target: null, ...point, ...extra }) as unknown as PointerEvent;

let root: Root;
let container: HTMLDivElement;
let cutter: Cutter;
let onCutComplete: ReturnType<typeof vi.fn<() => void>>;
let onMiss: ReturnType<typeof vi.fn<() => void>>;

const Probe = ({ hold }: { hold: (cutter: Cutter) => void }) => {
  const latest = usePackCutter({ onCutComplete, onMiss, isOpening: false, isPackCut: false, volume: 0, particlesEnabled: false });
  const { packRef } = latest;
  useEffect(() => hold(latest));
  return <div ref={packRef} />;
};

const down = (point: Point, extra?: Partial<PointerEvent>) => act(() => cutter.handlePointerDown(pointer('pointerdown', point, extra)));
const move = (point: Point, extra?: Partial<PointerEvent>) => act(() => cutter.handlePointerMove(pointer('pointermove', point, extra)));
const up = (point: Point, extra?: Partial<PointerEvent>) => act(() => cutter.handlePointerEnd(pointer('pointerup', point, extra)));

/** Presses at the first point, moves through the rest, and releases at the last. */
const swipe = (...points: Point[]) => {
  down(points[0]);
  for (const point of points.slice(1)) move(point);
  up(points[points.length - 1]);
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no matchMedia; the spark layer asks it about reduced motion.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  onCutComplete = vi.fn<() => void>();
  onMiss = vi.fn<() => void>();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Probe hold={(latest) => { cutter = latest; }} />));
  const pack = container.firstElementChild as HTMLDivElement;
  pack.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON() {} });
  Object.defineProperty(pack, 'clientWidth', { value: rect.width });
  Object.defineProperty(pack, 'clientHeight', { value: rect.height });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('usePackCutter short swipes (#312)', () => {
  it('opens on release after a 30% swipe along the tear line, not before', () => {
    down(at(0.35));
    move(at(0.5));
    move(at(0.65));
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.65));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('opens on release in either direction', () => {
    swipe(at(0.7), at(0.6), at(0.48));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open after a 19% swipe', () => {
    swipe(at(0.4), at(0.5), at(0.59));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('counts a swipe that goes over and comes back by everything it covered', () => {
    swipe(at(0.3), at(0.42), at(0.55), at(0.42), at(0.3));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open after a back-and-forth scribble that never spans 20%', () => {
    swipe(at(0.4), at(0.55), at(0.42), at(0.56), at(0.41), at(0.5));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('opens mid-drag once the stroke spans 45%, with no edge to reach', () => {
    down(at(0.3));
    move(at(0.5));
    expect(onCutComplete).not.toHaveBeenCalled();
    move(at(0.76));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
    up(at(0.76));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open after a mostly vertical drag, even one that drifts sideways', () => {
    swipe(at(0.4), at(0.5, 100), at(0.6, 200), at(0.65, 300));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('keeps counting a slanted swipe that drifts off the tear line', () => {
    // 60 and 90px below the line: past the 45.84px it takes to start a stroke.
    swipe(at(0.2), at(0.35, 30), at(0.45, 60), at(0.55, 90));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('opens on a fast flick with only a press and a release', () => {
    swipe(at(0.3), at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('counts the points a browser coalesced into one move', () => {
    down(at(0.3));
    move(at(0.8), { getCoalescedEvents: () => [at(0.45), at(0.6), at(0.8)] as unknown as PointerEvent[] });
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open on a tap on the tear line', () => {
    swipe(at(0.5), at(0.5));
    expect(onCutComplete).not.toHaveBeenCalled();
    expect(onMiss).not.toHaveBeenCalled();
  });

  it('does not open from a swipe across the art below the line, and nudges instead', () => {
    swipe(at(0.2, 200), at(0.5, 200), at(0.8, 200));
    expect(onCutComplete).not.toHaveBeenCalled();
    expect(onMiss).toHaveBeenCalledTimes(1);
  });

  it('never cuts from a press on the top bar', () => {
    const bar = document.createElement('div');
    bar.className = 'pack-top-bar';
    container.append(bar);
    down(at(0.2), { target: bar });
    move(at(0.5));
    move(at(0.9));
    up(at(0.9));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('does not open when the browser cancels the stroke', () => {
    down(at(0.3));
    move(at(0.6));
    act(() => cutter.handlePointerEnd(pointer('pointercancel', at(0.6))));
    expect(onCutComplete).not.toHaveBeenCalled();
  });
});

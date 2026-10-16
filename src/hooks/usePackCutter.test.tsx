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

/** A point `x` px right of the pack's left edge, on its tear line: for a pack narrowed with `sizePack`. */
const fromLeft = (x: number): Point => ({ clientX: rect.left + x, clientY: tearClientY });

/** One finger's event; pass `pointerId` and `isPrimary: false` for a second finger. */
const pointer = (type: string, point: Point, extra: Partial<PointerEvent> = {}) =>
  ({
    type, button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure: 0.5, target: null,
    pointerId: 1, pointerType: 'touch', isPrimary: true, ...point, ...extra,
  }) as unknown as PointerEvent;
const second = { pointerId: 2, isPrimary: false };
/** A mouse: the primary pointer of its own type, even while a finger is down. */
const mouse = { pointerId: 7, pointerType: 'mouse', isPrimary: true } as Partial<PointerEvent>;

let root: Root;
let container: HTMLDivElement;
let cutter: Cutter;
let onCutComplete: ReturnType<typeof vi.fn<() => void>>;
let onMiss: ReturnType<typeof vi.fn<() => void>>;

const Probe = ({ hold, disabled = false }: { hold: (cutter: Cutter) => void; disabled?: boolean }) => {
  const latest = usePackCutter({ onCutComplete, onMiss, isOpening: false, isPackCut: false, volume: 0, particlesEnabled: false, disabled });
  const { packRef } = latest;
  useEffect(() => hold(latest));
  return <div ref={packRef} />;
};

/** Renders the probe, or re-renders it with a sheet open over the pack (`disabled`). */
const render = (disabled = false) => act(() => root.render(<Probe hold={(latest) => { cutter = latest; }} disabled={disabled} />));

/** Gives the pack the on-screen box `rect`, or `rect` narrowed to `width` px from the same left edge. */
const sizePack = (width = rect.width) => {
  const pack = container.firstElementChild as HTMLDivElement;
  pack.getBoundingClientRect = () => ({ ...rect, width, x: rect.left, y: rect.top, right: rect.left + width, bottom: rect.top + rect.height, toJSON() {} });
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
  render();
  sizePack();
  const pack = container.firstElementChild as HTMLDivElement;
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

  it('opens on a fast flick with only a press and a release, with no move between', () => {
    down(at(0.3));
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('counts the points a browser coalesced into one move', () => {
    down(at(0.3));
    move(at(0.8), { getCoalescedEvents: () => [at(0.45), at(0.6), at(0.8)] as unknown as PointerEvent[] });
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('counts the points a browser coalesced into the release', () => {
    down(at(0.3));
    up(at(0.3), { getCoalescedEvents: () => [at(0.45), at(0.6)] as unknown as PointerEvent[] });
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('measures a stroke from where it reaches the tear line, not from a press just off it', () => {
    // 50px under the line is just past the band, so the press nudges; the stroke starts at 20%.
    swipe(at(0.1, 50), at(0.2), at(0.38));
    expect(onMiss).toHaveBeenCalledTimes(1);
    expect(onCutComplete).not.toHaveBeenCalled();
    swipe(at(0.1, 50), at(0.2), at(0.42));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('never cuts from a press beside the pack at tear height, dragged onto it', () => {
    swipe(at(-0.1), at(0.2), at(0.5), at(0.6));
    expect(onCutComplete).not.toHaveBeenCalled();
    expect(onMiss).not.toHaveBeenCalled();
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

  it('needs at least 32px on a pack too narrow for 20% to reach it', () => {
    // 20% of 120px is 24px, so the floor decides. 30px is 25% of the pack and still too short.
    sizePack(120);
    swipe(fromLeft(40), fromLeft(55), fromLeft(70));
    expect(onCutComplete).not.toHaveBeenCalled();
    down(fromLeft(40));
    move(fromLeft(56));
    move(fromLeft(72));
    expect(onCutComplete).not.toHaveBeenCalled();
    up(fromLeft(72));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open mid-drag on a 50% stroke that goes further down than across', () => {
    // 160px across is past the 144px (45%) that opens mid-drag, but it's 200px down.
    down(at(0.2));
    move(at(0.7, 200));
    expect(onCutComplete).not.toHaveBeenCalled();
    // The release measures the same stroke against the same guard, so it doesn't open either.
    up(at(0.7, 200));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('ignores points above or below the pack, so they cannot stretch a stroke to 20%', () => {
    // On the pack the stroke spans 10%. 115px over the tear line is 6px above the pack: counted, the
    // move to 80% would span 160px across and 115px up, enough to open even mid-drag. 470px under
    // the line is 5px below the pack.
    down(at(0.3));
    move(at(0.4));
    move(at(0.8, -115));
    move(at(0.9, 470));
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.8, -115));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('does not open on release once a sheet has opened over the pack mid-stroke', () => {
    down(at(0.3));
    move(at(0.6));
    render(true);
    expect(() => up(at(0.6))).not.toThrow();
    expect(onCutComplete).not.toHaveBeenCalled();
    // Nothing is left half-done: once the sheet closes, the next stroke opens as usual.
    render();
    swipe(at(0.3), at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open when the browser cancels the stroke', () => {
    down(at(0.3));
    move(at(0.6));
    act(() => cutter.handlePointerEnd(pointer('pointercancel', at(0.6))));
    expect(onCutComplete).not.toHaveBeenCalled();
  });
});

describe('usePackCutter with more than one finger', () => {
  it('does not open when a second finger lands far along the tear line', () => {
    down(at(0.2));
    down(at(0.7), second);
    up(at(0.7), second);
    up(at(0.2));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('does not open from a second finger swiping while the first holds still', () => {
    down(at(0.3));
    down(at(0.35), second);
    move(at(0.45), second);
    move(at(0.55), second);
    up(at(0.3));
    up(at(0.55), second);
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('does not open from a second finger tapping 30% away', () => {
    down(at(0.3));
    down(at(0.6), second);
    up(at(0.6), second);
    up(at(0.3));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('ignores a cancel from another finger', () => {
    down(at(0.3));
    down(at(0.6), second);
    act(() => cutter.handlePointerEnd(pointer('pointercancel', at(0.6), second)));
    move(at(0.45));
    up(at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('still opens from a one-finger stroke after another pointer has come and gone', () => {
    swipe(at(0.5, 200));
    down(at(0.3), { pointerId: 8 });
    down(at(0.6), { pointerId: 9, isPrimary: false });
    up(at(0.6), { pointerId: 9, isPrimary: false });
    move(at(0.55), { pointerId: 8 });
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.55), { pointerId: 8 });
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open from a mouse click during a touch stroke', () => {
    down(at(0.3));
    move(at(0.4));
    down(at(0.7), mouse);
    up(at(0.7), mouse);
    up(at(0.4));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  // Known bug, found while covering #312: a mouse is the primary pointer of its own type, so its
  // press reads as the touch's lost release and takes the stroke over (usePackCutter.ts:201-204).
  // The touch stroke then never opens. Flip this to `it` once the hook keeps the touch stroke.
  it.fails('keeps the touch stroke when a mouse clicks during it', () => {
    down(at(0.3));
    move(at(0.4));
    down(at(0.7), mouse);
    up(at(0.7), mouse);
    move(at(0.5));
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('starts afresh from a new first finger when the last one\'s release was lost', () => {
    down(at(0.8));
    down(at(0.3), { pointerId: 2 });
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.6), { pointerId: 2 });
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });
});

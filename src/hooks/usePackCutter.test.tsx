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

const Probe = ({ hold, disabled = false, particles = false }: { hold: (cutter: Cutter) => void; disabled?: boolean; particles?: boolean }) => {
  const latest = usePackCutter({ onCutComplete, onMiss, isOpening: false, isPackCut: false, volume: 0, particlesEnabled: particles, disabled });
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

  it('keeps the touch stroke when a mouse clicks during it', () => {
    down(at(0.3));
    move(at(0.4));
    down(at(0.7), mouse);
    up(at(0.7), mouse);
    move(at(0.5));
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open from a pen swiping during a touch stroke, nor let it block the touch', () => {
    const pen = { pointerId: 9, pointerType: 'pen', isPrimary: true } as Partial<PointerEvent>;
    down(at(0.3));
    move(at(0.35));
    // On its own, the pen's 50% swipe would open the pack mid-drag.
    down(at(0.4), pen);
    move(at(0.9), pen);
    up(at(0.9), pen);
    expect(onCutComplete).not.toHaveBeenCalled();
    move(at(0.5));
    up(at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('measures only the new stroke when a new touch presses after a lost touch release', () => {
    down(at(0.3));
    move(at(0.45));
    // That release never comes. Kept, the old stroke would make this move span 50% and open.
    down(at(0.6), { pointerId: 3 });
    move(at(0.8), { pointerId: 3 });
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.9), { pointerId: 3 });
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

describe('usePackCutter frame batching (#266)', () => {
  /** Frames requested and not yet run or cancelled. */
  let frames: Map<number, FrameRequestCallback>;
  /** Commits of the probe since the count was last reset. */
  let commits: number;

  /** Runs the frames requested so far, as the browser's next frame would. */
  const runFrame = () => act(() => {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback(Date.now());
  });

  /** Re-renders the probe counting its commits, with sparks on or off. */
  const renderCounting = (particles: boolean) => act(() => root.render(
    <Probe hold={(latest) => { cutter = latest; commits += 1; }} particles={particles} />,
  ));

  /** Cut-line x of each drawn point, as a percentage of the pack's width. */
  const drawnX = () => cutter.cutPoints.map((point) => Math.round(point.x));
  const coalesced = (...points: Point[]) => ({ getCoalescedEvents: () => points as unknown as PointerEvent[] });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame); });
    commits = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('draws the moves between two frames in one update, keeping every point', () => {
    renderCounting(false);
    down(at(0.3));
    expect(drawnX()).toEqual([30]);
    commits = 0;
    move(at(0.32));
    move(at(0.36), coalesced(at(0.34), at(0.36)));
    move(at(0.38));
    expect(commits).toBe(0);
    expect(drawnX()).toEqual([30]);
    expect(frames.size).toBe(1);

    runFrame();
    expect(commits).toBe(1);
    expect(drawnX()).toEqual([30, 32, 34, 36, 38]);
    expect(frames.size).toBe(0);
  });

  it('draws one spark burst a frame, at the latest point', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no spark jitter
    renderCounting(true);
    down(at(0.3));
    const burst = cutter.sparks.length;
    expect(burst).toBeGreaterThan(0);
    vi.advanceTimersByTime(16);
    commits = 0;
    move(at(0.32));
    move(at(0.34));
    move(at(0.36));
    expect(cutter.sparks).toHaveLength(burst);

    runFrame();
    expect(commits).toBe(1);
    expect(cutter.sparks).toHaveLength(2 * burst);
    expect(cutter.sparks[burst].x).toBeCloseTo(0.36 * rect.width);
  });

  it('decides the cut from points no frame has drawn yet', () => {
    renderCounting(false);
    down(at(0.3));
    move(at(0.42));
    move(at(0.55));
    move(at(0.4));
    expect(drawnX()).toEqual([30]);
    up(at(0.4));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('opens mid-drag on the move that reaches 45%, and drops its frame', () => {
    renderCounting(true);
    down(at(0.2));
    move(at(0.4));
    expect(frames.size).toBe(1);
    move(at(0.66));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(cutter.cutPoints).toEqual([]);
    expect(cutter.sparks).toHaveLength(0);
  });

  it('measures the pack once per press, and again after a resize or a scroll', () => {
    const pack = container.firstElementChild as HTMLDivElement;
    const measure = vi.spyOn(pack, 'getBoundingClientRect');
    down(at(0.3));
    move(at(0.32));
    move(at(0.34));
    expect(measure).toHaveBeenCalledTimes(1);

    act(() => { window.dispatchEvent(new Event('resize')); });
    move(at(0.36));
    move(at(0.38));
    expect(measure).toHaveBeenCalledTimes(2);

    // Scrolling any element can move the pack; scroll events don't bubble, so this is caught early.
    act(() => { document.body.dispatchEvent(new Event('scroll')); });
    up(at(0.4));
    expect(measure).toHaveBeenCalledTimes(3);

    down(at(0.3));
    expect(measure).toHaveBeenCalledTimes(4);
  });

  const exits: [string, () => void][] = [
    ['a release', () => up(at(0.33))],
    ['a cancel', () => act(() => cutter.handlePointerEnd(pointer('pointercancel', at(0.33))))],
    ['blur or a hidden page', () => act(() => cutter.endCutAttempt())],
    ['a reset', () => act(() => cutter.resetCutState())],
    ['unmount', () => {
      act(() => root.unmount());
      root = createRoot(container);
    }],
  ];

  it.each(exits)('cancels its frame and spark timer on %s', (_exit, end) => {
    renderCounting(true);
    down(at(0.3));
    vi.advanceTimersByTime(16);
    move(at(0.33));
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    end();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('stops listening for resizes and scrolls on unmount', () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    act(() => root.unmount());
    root = createRoot(container);
    expect(removed.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['resize', 'scroll']));
  });
});

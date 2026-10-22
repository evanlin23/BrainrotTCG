// @vitest-environment jsdom
import { act, useEffect, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAIRY_DUST_SRC, WOOSH_SRC, soundGain } from '../constants/audio';
import { usePackCutter } from './usePackCutter';

// A 320 x 573 pack, 100px right and 50px down the viewport. Its tear line sits at 19% of its
// height, and a stroke starts anywhere from the pack's top down to 191px (a third of its height,
// 82px under the tear line). A release opens it from 12% of the width (38.4px), a drag from 30%, and
// a stroke may cover up to 1.5 times as far up or down as across (#626).
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
let onSeamTap: ReturnType<typeof vi.fn<() => void>>;
let onShortSwipe: ReturnType<typeof vi.fn<() => void>>;

interface ProbeProps {
  hold: (cutter: Cutter) => void;
  disabled?: boolean;
  isOpening?: boolean;
  isPackCut?: boolean;
  particles?: boolean;
  volume?: number;
}

const Probe = ({ hold, disabled = false, isOpening = false, isPackCut = false, particles = false, volume = 0 }: ProbeProps) => {
  const latest = usePackCutter({ onCutComplete, onMiss, onSeamTap, onShortSwipe, isOpening, isPackCut, volume, particlesEnabled: particles, disabled });
  const { packRef } = latest;
  useEffect(() => hold(latest));
  return <div ref={packRef} />;
};

/** Renders the probe, or re-renders it with a sheet open over the pack (`disabled`). */
const render = (disabled = false, volume = 0) => act(() => root.render(<Probe hold={(latest) => { cutter = latest; }} disabled={disabled} volume={volume} />));

/** Gives the pack the on-screen box `rect`, or `rect` resized to `width` x `height` px from the same top left corner. */
const sizePack = (width = rect.width, height = rect.height) => {
  const pack = container.firstElementChild as HTMLDivElement;
  pack.getBoundingClientRect = () => ({ ...rect, width, height, x: rect.left, y: rect.top, right: rect.left + width, bottom: rect.top + height, toJSON() {} });
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

/** Mounts the probe on a pack with the box `rect`. */
const mount = () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  render();
  sizePack();
  const pack = container.firstElementChild as HTMLDivElement;
  Object.defineProperty(pack, 'clientWidth', { value: rect.width });
  Object.defineProperty(pack, 'clientHeight', { value: rect.height });
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no matchMedia; the spark layer asks it about reduced motion.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  onCutComplete = vi.fn<() => void>();
  onMiss = vi.fn<() => void>();
  onSeamTap = vi.fn<() => void>();
  onShortSwipe = vi.fn<() => void>();
  mount();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('usePackCutter short swipes (#312)', () => {
  it('opens on release after a 25% swipe along the tear line, not before', () => {
    down(at(0.35));
    move(at(0.5));
    move(at(0.6));
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('opens on release in either direction', () => {
    swipe(at(0.7), at(0.6), at(0.48));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('opens on release after a 13% swipe, past the 12% it takes (#626)', () => {
    swipe(at(0.4), at(0.47), at(0.53));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open after an 11% swipe', () => {
    swipe(at(0.4), at(0.47), at(0.51));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('counts a swipe that goes over and comes back by everything it covered', () => {
    swipe(at(0.3), at(0.42), at(0.55), at(0.42), at(0.3));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open after a back-and-forth scribble that never spans 12%', () => {
    swipe(at(0.4), at(0.47), at(0.41), at(0.48), at(0.4), at(0.45));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('opens mid-drag once the stroke spans 30%, with no edge to reach', () => {
    down(at(0.3));
    move(at(0.5));
    expect(onCutComplete).not.toHaveBeenCalled();
    move(at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
    up(at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open after a mostly vertical drag, even one that drifts sideways', () => {
    swipe(at(0.4), at(0.5, 100), at(0.6, 200), at(0.65, 300));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('does not open a stroke that goes across, far down, then across again, mid-drag or on release (#626)', () => {
    // 15px across settles it as a swipe; 300px down is then 20 times as far down as across, and the
    // 112px across that follows (35%, past the 30% a drag needs) is still under 1.5 times that drift.
    const press = at(0.3);
    down(press);
    move({ clientX: press.clientX + 15, clientY: press.clientY });
    move({ clientX: press.clientX + 15, clientY: press.clientY + 300 });
    move({ clientX: press.clientX + 112, clientY: press.clientY + 300 });
    expect(onCutComplete).not.toHaveBeenCalled();
    up({ clientX: press.clientX + 112, clientY: press.clientY + 300 });
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('keeps counting a slanted swipe that drifts off the tear line', () => {
    // 60 and 90px below the line: past the 82px it takes to start a stroke.
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

  it('never cuts from a press just below the start band, dragged up into it and across', () => {
    // 90px under the line is just past the 82px band, so the press nudges and can't cut (#267, #626).
    swipe(at(0.1, 90), at(0.2), at(0.9));
    expect(onMiss).toHaveBeenCalledTimes(1);
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('never cuts after a clear scroll down from the seam, 40px down and under 10px across', () => {
    // 40px down is still inside the band, and 60% across would open mid-drag (#267).
    down(at(0.3));
    move(at(0.305, 10));
    move(at(0.31, 20));
    move(at(0.315, 30));
    move(at(0.325, 40));
    move(at(0.9, 40));
    up(at(0.9, 40));
    expect(onCutComplete).not.toHaveBeenCalled();
    expect(cutter.isPressing).toBe(false);
  });

  it('never cuts from a press on the seam that sets off clearly up, then swipes across', () => {
    down(at(0.3));
    move(at(0.32, -36));
    move(at(0.9, -36));
    up(at(0.9, -36));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('never cuts on a release whose coalesced points go clearly down before going across', () => {
    down(at(0.3));
    up(at(0.9, 40), { getCoalescedEvents: () => [at(0.3, 40), at(0.9, 40)] as unknown as PointerEvent[] });
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it.each([8, 10, -10])('opens when a thumb settles %ipx up or down on the seam, then swipes across', (settle) => {
    // The settle passes the 10px slop without deciding anything; the swipe then leads (#267).
    down(at(0.3));
    move(at(0.3, settle / 2));
    move(at(0.3, settle));
    move(at(0.4, settle));
    move(at(0.55, settle));
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.55, settle));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('opens mid-drag when a thumb settles 10px down on the seam, then swipes 30% across', () => {
    down(at(0.3));
    move(at(0.3, 10));
    move(at(0.5, 10));
    expect(onCutComplete).not.toHaveBeenCalled();
    move(at(0.8, 10));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('reads the direction only past the slop, so a wobble before a swipe still opens', () => {
    // 6px down is a finger settling, not a scroll.
    down(at(0.3));
    move(at(0.3, 6));
    move(at(0.55, 6));
    expect(onCutComplete).not.toHaveBeenCalled();
    up(at(0.55, 6));
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

  it('never cuts from a press outside the stage, where a scrolled-away seam can map to the app header', () => {
    // A desktop stage scrolls and clips the pack, so the pack's measured box can run under the header.
    container.classList.add('pack-display');
    const header = document.createElement('header');
    document.body.append(header);
    down(at(0.2), { target: header });
    move(at(0.5));
    move(at(0.9));
    up(at(0.9));
    expect(onCutComplete).not.toHaveBeenCalled();
    header.remove();
  });

  it('still cuts from a press inside the stage', () => {
    container.classList.add('pack-display');
    const pack = container.firstElementChild as HTMLDivElement;
    down(at(0.2), { target: pack });
    move(at(0.5));
    move(at(0.9));
    up(at(0.9));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('needs at least 32px on a pack too narrow for 12% to reach it', () => {
    // 12% of 120px is 14.4px, so the floor decides. 30px is 25% of the pack and still too short.
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

  it.each([270, 330])('does not open mid-drag on a 50%% stroke that goes %ipx down, over 1.5 times as far as across', (below) => {
    // 160px across is past the 96px (30%) that opens mid-drag, but it's more than 240px down.
    down(at(0.2));
    move(at(0.7, below));
    expect(onCutComplete).not.toHaveBeenCalled();
    // The release measures the same stroke against the same guard, so it doesn't open either.
    up(at(0.7, below));
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
    move(at(0.55));
    render(true);
    expect(() => up(at(0.55))).not.toThrow();
    expect(onCutComplete).not.toHaveBeenCalled();
    // Nothing is left half-done: once the sheet closes, the next stroke opens as usual.
    render();
    swipe(at(0.3), at(0.6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('does not open when the browser cancels the stroke', () => {
    down(at(0.3));
    move(at(0.55));
    act(() => cutter.handlePointerEnd(pointer('pointercancel', at(0.55))));
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
    // The press only lights the seam (one commit); its moves wait for the frame.
    commits = 0;
    // A press draws nothing until it goes across: 6.4px is still inside the slop (#267).
    move(at(0.32));
    expect(frames.size).toBe(0);
    move(at(0.36), coalesced(at(0.34), at(0.36)));
    move(at(0.38));
    expect(commits).toBe(0);
    expect(drawnX()).toEqual([]);
    expect(cutter.isCutting).toBe(false);
    expect(frames.size).toBe(1);

    runFrame();
    expect(commits).toBe(1);
    expect(drawnX()).toEqual([30, 32, 34, 36, 38]);
    expect(cutter.isCutting).toBe(true);
    expect(frames.size).toBe(0);
  });

  it('commits a frame\'s drawing inside that frame, so it paints in the same frame', () => {
    renderCounting(true);
    down(at(0.3));
    move(at(0.34));
    move(at(0.36));
    commits = 0;
    // The browser runs the frame outside act: an ordinary update there waits for React's scheduler,
    // which commits after the frame has painted, so the cut would show a frame late.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    try {
      const [callback] = frames.values();
      frames.clear();
      callback(Date.now());
      expect(commits).toBe(1);
      expect(drawnX()).toEqual([30, 34, 36]);
      expect(cutter.isCutting).toBe(true);
      expect(cutter.sparks.length).toBeGreaterThan(0);
    } finally {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    }
  });

  it('opens once for a swipe, its release, the Open pack button and a second swipe, all before the pack re-renders as cut', () => {
    renderCounting(true);
    down(at(0.2));
    move(at(0.4));
    move(at(0.66));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
    move(at(0.8));
    up(at(0.8));
    act(() => cutter.completeCut());
    swipe(at(0.2), at(0.5), at(0.8));
    up(at(0.8));
    runFrame();
    expect(onCutComplete).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(cutter.cutPoints).toEqual([]);
    expect(cutter.sparks).toHaveLength(0);
  });

  it('draws one spark burst a frame, at the latest point', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no spark jitter
    renderCounting(true);
    down(at(0.3));
    expect(cutter.sparks).toHaveLength(0);
    move(at(0.32));
    move(at(0.34));
    move(at(0.36));
    expect(cutter.sparks).toHaveLength(0);
    runFrame();
    const burst = cutter.sparks.length;
    expect(burst).toBeGreaterThan(0);
    expect(cutter.sparks[0].x).toBeCloseTo(0.36 * rect.width);

    vi.advanceTimersByTime(16);
    commits = 0;
    move(at(0.38));
    move(at(0.4));
    move(at(0.42));
    expect(cutter.sparks).toHaveLength(burst);

    runFrame();
    expect(commits).toBe(1);
    expect(cutter.sparks).toHaveLength(2 * burst);
    expect(cutter.sparks[burst].x).toBeCloseTo(0.42 * rect.width);
  });

  it('draws nothing for a press on the seam that goes clearly down', () => {
    renderCounting(true);
    down(at(0.3));
    move(at(0.31, 4));
    move(at(0.32, 40));
    move(at(0.6, 40));
    expect(frames.size).toBe(0);
    runFrame();
    expect(cutter.cutPoints).toEqual([]);
    expect(cutter.isCutting).toBe(false);
    expect(cutter.isPressing).toBe(false);
    expect(cutter.sparks).toHaveLength(0);
    up(at(0.6, 40));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('lights the seam on a press without cutting, then draws once a settled thumb goes across', () => {
    renderCounting(false);
    down(at(0.3));
    expect(cutter.isPressing).toBe(true);
    expect(cutter.isCutting).toBe(false);
    move(at(0.3, 9));
    expect(frames.size).toBe(0);
    // 19.2px across leads the 9px settle.
    move(at(0.36, 9));
    expect(frames.size).toBe(1);
    runFrame();
    expect(cutter.isCutting).toBe(true);
    expect(drawnX()).toEqual([30, 30, 36]);
    up(at(0.36, 9));
    expect(cutter.isPressing).toBe(false);
    expect(cutter.isCutting).toBe(false);
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('does not light the seam for a press below the start band', () => {
    down(at(0.3, 100));
    expect(cutter.isPressing).toBe(false);
    expect(onMiss).toHaveBeenCalledTimes(1);
    up(at(0.3, 100));
  });

  it('draws nothing for a press below the start band, dragged onto the seam and across', () => {
    renderCounting(true);
    down(at(0.3, 100));
    move(at(0.3));
    move(at(0.4));
    move(at(0.5));
    expect(frames.size).toBe(0);
    runFrame();
    expect(cutter.cutPoints).toEqual([]);
    expect(cutter.isCutting).toBe(false);
    expect(cutter.sparks).toHaveLength(0);
    expect(onMiss).toHaveBeenCalledTimes(1);
  });

  it.each(['disabled', 'isOpening', 'isPackCut'] as const)('draws nothing in a frame that lands after %s', (closed) => {
    renderCounting(true);
    down(at(0.3));
    move(at(0.34));
    move(at(0.36));
    expect(frames.size).toBe(1);
    act(() => root.render(
      <Probe hold={(latest) => { cutter = latest; }} particles {...{ [closed]: true }} />,
    ));
    runFrame();
    expect(cutter.cutPoints).toEqual([]);
    expect(cutter.isCutting).toBe(false);
    expect(cutter.sparks).toHaveLength(0);
  });

  it('decides the cut from points no frame has drawn yet', () => {
    renderCounting(false);
    down(at(0.3));
    move(at(0.42));
    move(at(0.55));
    move(at(0.4));
    expect(drawnX()).toEqual([]);
    up(at(0.4));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('opens mid-drag on the move that reaches 30%, and drops its frame', () => {
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
    ['a release', () => up(at(0.36))],
    ['a cancel', () => act(() => cutter.handlePointerEnd(pointer('pointercancel', at(0.36))))],
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
    move(at(0.34));
    // This frame's sparks start the expiry timer; the next move asks for another frame.
    runFrame();
    move(at(0.36));
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    end();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('drops a queued frame as the tree is removed, so none can run flushSync after the unmount', () => {
    // A layout cleanup runs while the tree is removed, parents before the siblings after them. A passive
    // one waits until later, and a frame could run in between, so look from a sibling's layout cleanup.
    const queuedAtRemoval: number[] = [];
    const Witness = () => {
      useLayoutEffect(() => () => { queuedAtRemoval.push(frames.size); }, []);
      return null;
    };
    act(() => root.render(
      <>
        <Probe hold={(latest) => { cutter = latest; }} particles />
        <Witness />
      </>,
    ));
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    down(at(0.3));
    move(at(0.34));
    move(at(0.36));
    expect(frames.size).toBe(1);
    const [queued] = frames.keys();

    act(() => root.unmount());
    root = createRoot(container);
    expect(queuedAtRemoval).toEqual([0]);
    expect(cancel).toHaveBeenCalledWith(queued);
    expect(frames.size).toBe(0);
  });

  it('stops listening for resizes and scrolls on unmount', () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    act(() => root.unmount());
    root = createRoot(container);
    expect(removed.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['resize', 'scroll']));
  });

  it('measures again after a pinch zoom or a keyboard moves the visual viewport, and stops listening on unmount', () => {
    const viewport = new EventTarget();
    vi.stubGlobal('visualViewport', viewport);
    act(() => root.unmount());
    container.remove();
    mount();
    const pack = container.firstElementChild as HTMLDivElement;
    const measure = vi.spyOn(pack, 'getBoundingClientRect');
    down(at(0.3));
    move(at(0.32));
    expect(measure).toHaveBeenCalledTimes(1);

    act(() => { viewport.dispatchEvent(new Event('resize')); });
    move(at(0.34));
    expect(measure).toHaveBeenCalledTimes(2);

    act(() => { viewport.dispatchEvent(new Event('scroll')); });
    move(at(0.36));
    expect(measure).toHaveBeenCalledTimes(3);
    up(at(0.36));

    const removed = vi.spyOn(viewport, 'removeEventListener');
    act(() => root.unmount());
    root = createRoot(container);
    expect(removed.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['resize', 'scroll']));
  });
});

describe('usePackCutter direction thresholds (#485)', () => {
  /** Frames requested and not yet run or cancelled. */
  let frames: Map<number, FrameRequestCallback>;
  const runFrame = () => act(() => {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback(0);
  });
  /** A point `dx` px across and `dy` px down from a press on the tear line, 30% over the pack. */
  const from = (dx: number, dy: number): Point => ({ clientX: at(0.3).clientX + dx, clientY: tearClientY + dy });

  beforeEach(() => {
    frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame); });
  });

  it('opens from a press that goes 30px down before it goes across', () => {
    down(from(0, 0));
    move(from(0, 15));
    move(from(0, 30));
    // 30px is short of the 32px that makes a press a scroll, so the seam stays lit.
    expect(cutter.isPressing).toBe(true);
    move(from(32, 30));
    move(from(80, 30));
    up(from(80, 30));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('stops a press that goes 32px straight down, so a swipe after it cannot open', () => {
    down(from(0, 0));
    move(from(0, 16));
    move(from(0, 32));
    expect(cutter.isPressing).toBe(false);
    move(from(120, 32));
    up(from(120, 32));
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it('leaves a press 28px down and 12px across undecided: nothing draws, and it can still go across', () => {
    down(from(0, 0));
    move(from(12, 28));
    expect(frames.size).toBe(0);
    runFrame();
    expect(cutter.cutPoints).toEqual([]);
    expect(cutter.isCutting).toBe(false);
    expect(cutter.isPressing).toBe(true);
    move(from(70, 28));
    expect(frames.size).toBe(1);
    up(from(70, 28));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('stops a press only once it goes twice as far down as across', () => {
    // 40px down and 25px across is less than twice as far down: still undecided.
    down(from(0, 0));
    move(from(25, 40));
    expect(cutter.isPressing).toBe(true);
    move(from(90, 40));
    up(from(90, 40));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
    // 32px down and 15px across is more than twice as far down: a scroll.
    down(at(0.3));
    move(from(15, 32));
    expect(cutter.isPressing).toBe(false);
  });

  it('counts a press as going across once it goes as far across as down', () => {
    down(from(0, 0));
    move(from(20, 20));
    expect(frames.size).toBe(1);
    runFrame();
    expect(cutter.isCutting).toBe(true);
  });

  it('still opens a short swipe along the seam, wobble and all', () => {
    // 13% of the pack, just past the 12% a release needs.
    swipe(at(0.4), at(0.47, 4), at(0.53, 6));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });

  it('still opens a short swipe over and back', () => {
    swipe(at(0.4), at(0.52, -3), at(0.62), at(0.5, 3), at(0.41));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
  });
});

describe('usePackCutter forgiving swipes (#626)', () => {
  /** A point `across` of the way over the pack, `y` px below the pack's top. */
  const atY = (across: number, y: number): Point => ({ clientX: rect.left + across * rect.width, clientY: rect.top + y });

  describe('where a press can start', () => {
    it.each([-100, -60, 0, 40, 80])('opens from a press %ipx from the tear line, swiped straight across', (below) => {
      swipe(at(0.2, below), at(0.35, below), at(0.5, below), at(0.6, below));
      expect(onCutComplete).toHaveBeenCalledTimes(1);
      expect(onMiss).not.toHaveBeenCalled();
    });

    it.each([
      // [pack height, last y that starts a cut, first y that is a miss]
      [573, 189, 193], // a third of the pack is 191px
      [900, 295, 305], // a third is 300px, past 80px under the tear line (251px)
      [300, 135, 140], // a third is only 100px: 80px under the tear line (137px) reaches lower
    ])('starts a cut anywhere in the top third or 80px under the tear line, on a %ipx pack', (height, inside, outside) => {
      sizePack(rect.width, height);
      swipe(atY(0.2, inside), atY(0.4, inside), atY(0.6, inside));
      expect(onCutComplete).toHaveBeenCalledTimes(1);
      expect(onMiss).not.toHaveBeenCalled();
      swipe(atY(0.2, outside), atY(0.4, outside), atY(0.6, outside));
      expect(onCutComplete).toHaveBeenCalledTimes(1);
      expect(onMiss).toHaveBeenCalledTimes(1);
    });

    it('opens from a short swipe that starts off the seam', () => {
      swipe(at(0.4, 70), at(0.47, 70), at(0.53, 70));
      expect(onCutComplete).toHaveBeenCalledTimes(1);
    });

    it('opens from a short diagonal that starts off the seam and rises onto it', () => {
      // 80px across (25%) is past the 12% a release needs, short of the 30% that opens mid-drag.
      down(at(0.3, 70));
      move(at(0.42, 35));
      move(at(0.55));
      expect(onCutComplete).not.toHaveBeenCalled();
      up(at(0.55));
      expect(onCutComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('how far a swipe may drift', () => {
    it.each([1, 1.4])('opens on a diagonal that goes %f px down for each px across', (slope) => {
      swipe(at(0.2), at(0.3, 32 * slope), at(0.45, 80 * slope), at(0.6, 128 * slope));
      expect(onCutComplete).toHaveBeenCalledTimes(1);
    });

    it('opens on a diagonal that starts low in the band and rises well past the seam', () => {
      swipe(at(0.2, 80), at(0.35, 40), at(0.5), at(0.6, -30));
      expect(onCutComplete).toHaveBeenCalledTimes(1);
    });

    it('opens on an arc that wanders 120px up and down while it goes 40% across', () => {
      swipe(at(0.2), at(0.3, 60), at(0.4, 100), at(0.5, 40), at(0.6, -20));
      expect(onCutComplete).toHaveBeenCalledTimes(1);
    });

    it.each([1.6, 1.8, 2.5])('does not open on a diagonal that goes %f px down for each px across', (slope) => {
      swipe(at(0.2), at(0.3, 32 * slope), at(0.45, 80 * slope), at(0.6, 128 * slope));
      expect(onCutComplete).not.toHaveBeenCalled();
    });

    it('draws the cut along the seam however high or low the finger is', () => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame += 1; frames.set(nextFrame, callback); return nextFrame; });
      vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame); });
      down(at(0.2, 70));
      move(at(0.28, 45));
      move(at(0.34, 20));
      act(() => { for (const callback of [...frames.values()]) callback(0); });
      expect(cutter.isCutting).toBe(true);
      expect(cutter.cutPoints.length).toBeGreaterThan(1);
      for (const point of cutter.cutPoints) expect(point.y).toBeCloseTo(19);
    });
  });

  describe('what still never opens the pack', () => {
    it.each([
      ['from low in the band', 70, [110, 170, 250]],
      ['from the top of the pack', -90, [-40, 60, 150]],
    ])('a drag down the pack %s is a scroll', (_, start, below) => {
      down(at(0.5, start));
      below.forEach((y, step) => move(at(0.5 + 0.005 * (step + 1), y)));
      expect(cutter.isPressing).toBe(false);
      up(at(0.52, below[below.length - 1]));
      expect(onCutComplete).not.toHaveBeenCalled();
      expect(onMiss).not.toHaveBeenCalled();
      expect(onSeamTap).not.toHaveBeenCalled();
    });

    it('a sideways sweep after a scroll does not open it', () => {
      down(at(0.3, 70));
      move(at(0.31, 120));
      expect(cutter.isPressing).toBe(false);
      move(at(0.9, 120));
      up(at(0.9, 120));
      expect(onCutComplete).not.toHaveBeenCalled();
    });

    it('a tap at the low edge of the band only shows the swipe', () => {
      swipe(at(0.5, 80), at(0.5, 80));
      expect(onSeamTap).toHaveBeenCalledTimes(1);
      expect(onMiss).not.toHaveBeenCalled();
      expect(onCutComplete).not.toHaveBeenCalled();
    });

    it('a tap with a jittering finger only shows the swipe', () => {
      swipe(at(0.5, 20), at(0.51, 24), at(0.49, 18), at(0.5, 22));
      expect(onSeamTap).toHaveBeenCalledTimes(1);
      expect(onCutComplete).not.toHaveBeenCalled();
    });

    it('a tap below the band is a miss, and shows where to swipe', () => {
      swipe(at(0.5, 90), at(0.5, 90));
      expect(onMiss).toHaveBeenCalledTimes(1);
      expect(onSeamTap).not.toHaveBeenCalled();
      expect(onCutComplete).not.toHaveBeenCalled();
    });
  });
});

describe('usePackCutter seam taps (#485)', () => {
  it('shows the swipe for a tap on the seam, without counting it as a miss', () => {
    swipe(at(0.5), at(0.5));
    expect(onSeamTap).toHaveBeenCalledTimes(1);
    expect(onMiss).not.toHaveBeenCalled();
    expect(onCutComplete).not.toHaveBeenCalled();
  });

  it.each([
    ['a swipe that opens', () => swipe(at(0.3), at(0.5), at(0.65))],
    ['a swipe too short to open', () => swipe(at(0.4), at(0.47), at(0.51))],
    ['a scroll down from the seam', () => swipe(at(0.5), at(0.5, 20), at(0.5, 40))],
    ['a press below the start band', () => swipe(at(0.5, 200), at(0.5, 200))],
    ['a cancelled press', () => {
      down(at(0.5));
      act(() => cutter.handlePointerEnd(pointer('pointercancel', at(0.5))));
    }],
  ])('does not show it for %s', (_, gesture) => {
    gesture();
    expect(onSeamTap).not.toHaveBeenCalled();
  });

  it('does not show it while a sheet is open over the pack', () => {
    render(true);
    swipe(at(0.5), at(0.5));
    expect(onSeamTap).not.toHaveBeenCalled();
  });
});

describe('usePackCutter swipes let go short (#803)', () => {
  it.each([
    ['a swipe under the release cut', () => swipe(at(0.4), at(0.45), at(0.49))],
    ['a swipe that wobbles back before the release', () => swipe(at(0.4), at(0.46), at(0.41))],
  ])('says so for %s, and opens nothing', (_, gesture) => {
    gesture();
    expect(onShortSwipe).toHaveBeenCalledTimes(1);
    expect(onCutComplete).not.toHaveBeenCalled();
    expect(onSeamTap).not.toHaveBeenCalled();
    expect(onMiss).not.toHaveBeenCalled();
  });

  it.each([
    ['a swipe that opens', () => swipe(at(0.3), at(0.5), at(0.65))],
    ['a tap on the seam', () => swipe(at(0.5), at(0.5))],
    ['a scroll down from the seam', () => swipe(at(0.5), at(0.5, 20), at(0.5, 40))],
    ['a press below the start band', () => swipe(at(0.5, 200), at(0.5, 200))],
    ['a cancelled press', () => {
      down(at(0.4));
      move(at(0.45));
      act(() => cutter.handlePointerEnd(pointer('pointercancel', at(0.45))));
    }],
  ])('stays quiet for %s', (_, gesture) => {
    gesture();
    expect(onShortSwipe).not.toHaveBeenCalled();
  });

  it('stays quiet while a sheet is open over the pack', () => {
    render(true);
    swipe(at(0.4), at(0.45), at(0.49));
    expect(onShortSwipe).not.toHaveBeenCalled();
  });
});

describe('usePackCutter sound gains', () => {
  it('plays the fairy dust and the woosh at their gain on the effects level', () => {
    const played: { src: string; volume: number }[] = [];
    vi.stubGlobal('Audio', class {
      volume = 1;
      currentTime = 0;
      onended: (() => void) | null = null;
      constructor(public src: string) {}
      pause() {}
      play() { played.push({ src: this.src, volume: this.volume }); return Promise.resolve(); }
    });
    render(false, 0.5);
    down(at(0.3));
    move(at(0.45));
    const fairy = played.find((p) => p.src === FAIRY_DUST_SRC)!;
    expect(fairy).toBeDefined();
    expect(fairy.volume).toBeCloseTo(0.5 * soundGain(FAIRY_DUST_SRC));
    move(at(0.65));
    up(at(0.65));
    expect(onCutComplete).toHaveBeenCalledTimes(1);
    const woosh = played.find((p) => p.src === WOOSH_SRC)!;
    expect(woosh).toBeDefined();
    expect(woosh.volume).toBeCloseTo(0.5 * soundGain(WOOSH_SRC));
  });
});

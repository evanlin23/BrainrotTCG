// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAG_CLICK_MS, SIDEWAYS_DEAD_ZONE_PX, touchAxis, useCardSwipe, useSidewaysFlickGuard } from './useRevealGestures';

let root: Root | null = null;
const render = (node: React.ReactNode) => act(() => {
  root ??= createRoot(document.createElement('div'));
  root.render(node);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe('a flipped card\'s swipe and tap', () => {
  let swipe: ReturnType<typeof useCardSwipe>;
  let next = vi.fn();
  const Probe = ({ id, locked = false }: { id: number; locked?: boolean }) => {
    swipe = useCardSwipe(id, locked, next);
    return null;
  };
  const fling = (x: number, vx = 0) => swipe.onDragEnd(null, { offset: { x }, velocity: { x: vx } });

  beforeEach(() => {
    next = vi.fn();
    vi.useFakeTimers({ toFake: ['performance'] });
  });

  it('moves on for a far or fast fling, and not for a short slow drag', () => {
    render(<Probe id={1} />);
    fling(40);
    expect(next).not.toHaveBeenCalled();
    fling(120);
    fling(20, 900);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('ignores the click a drag ends with on the same card', () => {
    render(<Probe id={1} />);
    fling(40);
    swipe.onTap();
    expect(next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DRAG_CLICK_MS + 1);
    swipe.onTap();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('takes a tap on the card a swipe dealt at once', () => {
    render(<Probe id={1} />);
    fling(120);
    render(<Probe id={2} />);
    swipe.onTap();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('does nothing while a big pull lands', () => {
    render(<Probe id={1} locked />);
    fling(120);
    swipe.onTap();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('the sideways flick guard', () => {
  it('waits out a small dead zone, then decides the way once', () => {
    expect(touchAxis(SIDEWAYS_DEAD_ZONE_PX - 1, 0)).toBeUndefined();
    expect(touchAxis(3, 2)).toBeUndefined();
    expect(touchAxis(SIDEWAYS_DEAD_ZONE_PX, 0)).toBe('sideways');
    expect(touchAxis(4, -9)).toBe('vertical');
  });

  const Stage = () => {
    const ref = useRef<HTMLDivElement | null>(null);
    useSidewaysFlickGuard(ref, '.card');
    return <div ref={ref} id="stage"><button type="button" className="card" /></div>;
  };
  const touchOn = (target: Element, type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
    target.dispatchEvent(event);
    return event;
  };

  /** jsdom lays nothing out, so an element with more to show than fits is faked. */
  const overflowing = (el: HTMLElement, overflowY: string) => {
    el.style.overflowY = overflowY;
    Object.defineProperty(el, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  };

  it('cancels a sideways move on the card, but not a wobble before a scroll', () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    render(<Stage />);
    // The reveal area around the stage scrolls, as it does with large text on a short phone.
    overflowing(host, 'auto');
    const card = host.querySelector('.card')!;

    touchOn(card, 'touchstart', 100, 100);
    // iOS stops a scroll for the whole touch if its first move is cancelled.
    expect(touchOn(card, 'touchmove', 104, 101).defaultPrevented).toBe(false);
    expect(touchOn(card, 'touchmove', 104, 130).defaultPrevented).toBe(false);
    // The scroll was decided up and down; a later sideways drift still scrolls.
    expect(touchOn(card, 'touchmove', 160, 132).defaultPrevented).toBe(false);

    touchOn(card, 'touchstart', 100, 100);
    expect(touchOn(card, 'touchmove', 120, 104).defaultPrevented).toBe(true);
    expect(touchOn(card, 'touchmove', 121, 140).defaultPrevented).toBe(true);
    host.remove();
  });

  it('cancels a sideways move still inside the dead zone when nothing around it scrolls', () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    render(<Stage />);
    // The stage clips its own overflow; only a scrolling element counts.
    overflowing(host.querySelector<HTMLElement>('#stage')!, 'clip');
    const card = host.querySelector('.card')!;

    touchOn(card, 'touchstart', 100, 100);
    expect(touchOn(card, 'touchmove', 105, 101).defaultPrevented).toBe(true);
    // Still undecided: a move that turns up and down inside the zone is left to scroll.
    expect(touchOn(card, 'touchmove', 102, 105).defaultPrevented).toBe(false);
    // Leaving the zone up and down decides the scroll; a later sideways drift still scrolls.
    expect(touchOn(card, 'touchmove', 103, 120).defaultPrevented).toBe(false);
    expect(touchOn(card, 'touchmove', 150, 121).defaultPrevented).toBe(false);
    host.remove();
  });

  it('removes both listeners when the reveal unmounts', () => {
    const add = vi.spyOn(HTMLDivElement.prototype, 'addEventListener');
    const remove = vi.spyOn(HTMLDivElement.prototype, 'removeEventListener');
    render(<Stage />);
    // React's root listens for every event too; only the stage's own listeners are the guard's.
    const added = add.mock.calls.filter(([type], i) => (add.mock.contexts[i] as Element).id === 'stage' && type.startsWith('touch'));
    expect(added.map(([type]) => type)).toEqual(['touchstart', 'touchmove']);
    act(() => root?.unmount());
    root = null;
    for (const [type, listener] of added) {
      expect(remove.mock.calls.some(([t, l], i) => t === type && l === listener && (remove.mock.contexts[i] as Element).id === 'stage')).toBe(true);
    }
    add.mockRestore();
    remove.mockRestore();
  });
});

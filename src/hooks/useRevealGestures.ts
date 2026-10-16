import { useEffect, useRef, type RefObject } from 'react';

/** How far (px) or how fast (px/s) a flipped card has to be flung to move on. */
export const SWIPE_DISTANCE = 80;
export const SWIPE_SPEED = 500;
/** A click this soon (ms) after a drag on the same card is the drag's own click, not a tap. */
export const DRAG_CLICK_MS = 300;
/** A touch has to travel this far (px) before it counts as sideways or as up and down. */
export const SIDEWAYS_DEAD_ZONE_PX = 8;

type Axis = 'sideways' | 'vertical' | undefined;

/** Which way a touch is going once it leaves the dead zone; undefined while it's still in it. */
export const touchAxis = (dx: number, dy: number): Axis => {
  if (Math.hypot(dx, dy) < SIDEWAYS_DEAD_ZONE_PX) return undefined;
  return Math.abs(dx) > Math.abs(dy) ? 'sideways' : 'vertical';
};

/**
 * A flipped card moves on when flung far or fast enough, or when tapped. A mouse drag ends with a click
 * on the card it dragged; that click isn't a tap, so it mustn't advance again. Only that card's click:
 * a swipe deals the next card at once, and a tap on it is a real tap.
 */
export const useCardSwipe = (cardId: number | string | undefined, locked: boolean, onNext: () => void) => {
  const dragged = useRef<{ id?: number | string; at: number }>({ at: 0 });
  const onDragEnd = (_: unknown, info: { offset: { x: number }; velocity: { x: number } }) => {
    dragged.current = { id: cardId, at: performance.now() };
    if (locked) return;
    if (Math.abs(info.offset.x) > SWIPE_DISTANCE || Math.abs(info.velocity.x) > SWIPE_SPEED) onNext();
  };
  const onTap = () => {
    const justDragged = dragged.current.id === cardId && performance.now() - dragged.current.at <= DRAG_CLICK_MS;
    if (!locked && !justDragged) onNext();
  };
  return { onDragEnd, onTap };
};

/**
 * A sideways flick on the card is the card's own gesture, never the page's. The card lets the page pan
 * only up and down (touch-action: pan-y), but Chromium still starts a fling from a sideways flick and
 * then eats the next tap as the one that stops it: no click, so a tap on the card right after a flick
 * did nothing (#504). Cancelling the sideways touchmoves keeps the flick from becoming a scroll at all.
 *
 * The way is decided once, when the touch leaves a small dead zone, so a thumb that wobbles sideways as
 * it starts a scroll still scrolls. The swipe itself runs on pointer events, which this leaves alone; two
 * fingers still zoom. React's touch listeners are passive, so these are the DOM's own.
 */
export const useSidewaysFlickGuard = (stageRef: RefObject<HTMLElement | null>, cardSelector: string) => {
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let start: { x: number; y: number } | null = null;
    let axis: Axis;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      start = touch && (event.target as Element).closest(cardSelector) ? { x: touch.clientX, y: touch.clientY } : null;
      axis = undefined;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (!start || !touch) return;
      axis ??= touchAxis(touch.clientX - start.x, touch.clientY - start.y);
      if (axis === 'sideways' && event.cancelable) event.preventDefault();
    };
    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchmove', onTouchMove);
    };
  }, [stageRef, cardSelector]);
};

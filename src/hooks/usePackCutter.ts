import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useSparks } from './useSparks';
import { mapPackPointer, type PackLayout, type PackRect } from './packCutCoordinates';
import { FAIRY_DUST_SRC, WOOSH_SRC, soundVolume } from '../constants/audio';

// Pack cutting constants
const TEAR_LINE_RATIO = 0.19;
/** A stroke spanning this much of the pack's width opens it while it's still moving. */
const DRAG_CUT_RATIO = 0.45;
/** A stroke spanning this much opens the pack when it's released: a short swipe is enough (#312). */
const RELEASE_CUT_RATIO = 0.2;
/** Nor less than this, in CSS pixels, however small the pack. */
const MIN_CUT_PX = 32;
const MAX_CUT_POINTS = 64;
/**
 * How far, in CSS pixels, a press on the seam must move across before it can count as a swipe. Under
 * this it's a tap or a wobble (#267).
 */
const GESTURE_SLOP_PX = 10;
/**
 * A press that has moved this far up or down, and at least twice as far as across, is a scroll or a
 * drag down the art and never cuts. A thumb that settles a few pixels before swiping stays undecided,
 * so it still opens (#267).
 */
const VERTICAL_REJECT_PX = MIN_CUT_PX;
const DRAWN_CUT_OFFSET_RATIO = 0.000;
const CUT_LINE_RATIO = TEAR_LINE_RATIO + DRAWN_CUT_OFFSET_RATIO;

export interface CutPoint {
  x: number;
  y: number;
}

/** A stroke that started on the seam, in pack bounding-box pixels. */
interface CutStroke {
  /** Its extent so far, from where the press landed. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /**
   * It has gone at least GESTURE_SLOP_PX across, and as far across as up or down: a swipe along the
   * seam. Until then it neither draws nor cuts.
   */
  across: boolean;
}

/**
 * Whether a stroke has cut far enough. Its span is everything it covered across (in either
 * direction, so over and back counts in full), and must reach `ratio` of the pack's width and
 * MIN_CUT_PX, and be at least its span up or down, so a mostly vertical drag or a scroll never
 * opens the pack. This only decides when the pack opens; what's in it comes from the ticket, which
 * never sees the gesture.
 */
const strokeCuts = (stroke: CutStroke, packWidth: number, ratio: number) => {
  const across = stroke.maxX - stroke.minX;
  return stroke.across && across >= Math.max(MIN_CUT_PX, packWidth * ratio) && across >= stroke.maxY - stroke.minY;
};

/** The event's points in order, including any the browser coalesced into it, so a fast flick counts. */
const pointsOf = (event: PointerEvent): { clientX: number; clientY: number }[] => {
  const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
  return coalesced.length > 0 ? coalesced : [event];
};

/** The pack's box and layout size as measured at a press, reused for that press's moves. */
interface PackMeasure {
  pack: HTMLElement;
  rect: PackRect;
  layout: PackLayout;
}

interface UsePackCutterOptions {
  onCutComplete: () => void;
  isOpening: boolean;
  isPackCut: boolean;
  /** Sound effects volume, 0 (silent) to 1. */
  volume?: number;
  /** Disable particle creation as well as rendering. */
  particlesEnabled?: boolean;
  /** A sheet is open over the pack: drags belong to it, even after it closes mid-drag. */
  disabled?: boolean;
  /** A press on the pack away from the tear line (a tap, or a swipe across the art): time for a nudge. */
  onMiss?: () => void;
  /** A press on the tear line let go without swiping across (a tap): time to show the swipe. */
  onSeamTap?: () => void;
}

export const usePackCutter = ({ onCutComplete, isOpening, isPackCut, volume = 1, particlesEnabled = true, disabled = false, onMiss, onSeamTap }: UsePackCutterOptions) => {
  const [isCutting, setIsCutting] = useState(false);
  /** A press landed on the seam and hasn't been released or ruled out: the seam lights up under it. */
  const [isPressing, setIsPressing] = useState(false);
  const [cutPoints, setCutPoints] = useState<CutPoint[]>([]);

  const { sparks, emitSpark, clearSparks } = useSparks(particlesEnabled);

  const packRef = useRef<HTMLDivElement>(null);
  /** The stroke from a press on the seam, or null. */
  const strokeRef = useRef<CutStroke | null>(null);
  const cutCompletedRef = useRef(false);
  const isPointerDownRef = useRef(false);
  /**
   * The pointer whose press this is. Every other pointer is ignored until it's released, so a second
   * finger can't stretch the first one's stroke.
   */
  const ownerRef = useRef<number | null>(null);
  /** The owner's pointerType. Only read while there is an owner. */
  const ownerTypeRef = useRef<string | null>(null);
  /**
   * This press started over something else (an open sheet), beside the pack or off the seam, or set off
   * up or down, so it can't cut until it's released.
   */
  const blockedRef = useRef(false);
  const fairyDustRef = useRef<HTMLAudioElement | null>(null);
  /**
   * The pack as measured at this press. Moves reuse it instead of forcing a layout read each time
   * (#266); a press, a resize or a scroll measures again.
   */
  const measureRef = useRef<PackMeasure | null>(null);
  /**
   * Moves only extend the stroke (which decides the cut) right away. The points they add to the cut
   * line and the spark at the latest one wait here for the next animation frame, which draws them in
   * one batched update however many moves arrived since the last (#266). The press's own point waits
   * too, and nothing draws until the stroke is known to go across (#267).
   */
  const frameRef = useRef<number | null>(null);
  const pendingCutsRef = useRef<CutPoint[]>([]);
  const pendingSparkRef = useRef<CutPoint | null>(null);
  const emitSparkRef = useRef(emitSpark);
  /** Whether the pack takes a cut now, as of the last render, for a frame to check before it draws. */
  const closedRef = useRef(disabled || isOpening || isPackCut);
  useLayoutEffect(() => {
    emitSparkRef.current = emitSpark;
    closedRef.current = disabled || isOpening || isPackCut;
  }, [emitSpark, disabled, isOpening, isPackCut]);

  /** Drop a frame that hasn't drawn yet, and what it would have drawn. */
  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    pendingCutsRef.current = [];
    pendingSparkRef.current = null;
  }, []);

  const drawFrame = useCallback(() => {
    frameRef.current = null;
    const cuts = pendingCutsRef.current;
    const spark = pendingSparkRef.current;
    pendingCutsRef.current = [];
    pendingSparkRef.current = null;
    // A sheet, the opening or the cut can arrive between the move and its frame: then it draws nothing.
    if (cutCompletedRef.current || closedRef.current || !strokeRef.current?.across || cuts.length === 0) return;
    setIsCutting(true);
    setCutPoints((prev) => {
      const next = prev.concat(cuts);
      return next.length > MAX_CUT_POINTS ? next.slice(next.length - MAX_CUT_POINTS) : next;
    });
    if (spark) emitSparkRef.current(spark.x, spark.y);
  }, []);

  // A resize or a scroll can move the pack under a press: measure it again at the next point. So can
  // a pinch zoom or an on-screen keyboard, which move only the visual viewport. Unmounting drops a
  // frame that hasn't drawn.
  useEffect(() => {
    const remeasure = () => { measureRef.current = null; };
    const viewport = window.visualViewport;
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, { capture: true, passive: true });
    viewport?.addEventListener('resize', remeasure);
    viewport?.addEventListener('scroll', remeasure, { passive: true });
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, { capture: true });
      viewport?.removeEventListener('resize', remeasure);
      viewport?.removeEventListener('scroll', remeasure);
      cancelFrame();
    };
  }, [cancelFrame]);

  const resetCutState = useCallback(() => {
    cancelFrame();
    measureRef.current = null;
    setIsCutting(false);
    setIsPressing(false);
    setCutPoints([]);
    clearSparks();
    strokeRef.current = null;
    cutCompletedRef.current = false;
  }, [clearSparks, cancelFrame]);

  const measurePack = useCallback((): PackMeasure | null => {
    const pack = packRef.current;
    if (!pack) return null;
    if (measureRef.current?.pack !== pack) {
      const { left, top, width, height } = pack.getBoundingClientRect();
      measureRef.current = {
        pack,
        rect: { left, top, width, height },
        layout: { clientWidth: pack.clientWidth, clientHeight: pack.clientHeight },
      };
    }
    return measureRef.current;
  }, []);

  const getLocalPoint = useCallback((clientX: number, clientY: number) => {
    const measure = measurePack();
    if (!measure) return null;
    const { rect, layout } = measure;
    return {
      ...mapPackPointer(clientX, clientY, rect, layout, CUT_LINE_RATIO),
      tearY: rect.height * TEAR_LINE_RATIO,
      tolerance: Math.min(52, Math.max(26, rect.height * 0.08)),
    };
  }, [measurePack]);

  const completeCut = useCallback(() => {
    if (cutCompletedRef.current) return;

    cancelFrame();
    cutCompletedRef.current = true;
    setIsCutting(false);
    setIsPressing(false);
    setCutPoints([]);
    clearSparks();

    // Play woosh sound
    if (volume > 0) {
      const woosh = new Audio(WOOSH_SRC);
      woosh.volume = soundVolume(WOOSH_SRC, volume);
      woosh.onended = () => { woosh.src = ''; };
      woosh.play().catch(() => { });
    }

    onCutComplete();
  }, [onCutComplete, clearSparks, cancelFrame, volume]);

  /**
   * Follow one pointer position of a press that landed on the seam. Its direction stays undecided
   * until it's clear (#267): once it has gone GESTURE_SLOP_PX across and as far across as up or down,
   * it's a swipe; once it has gone VERTICAL_REJECT_PX up or down and twice as far as across, it's a
   * scroll or a drag down the art, and the press can't cut until it's released. A small settle up or
   * down before swiping decides neither. Any point over the pack's height counts (x past an edge
   * counts as that edge), so a slanted swipe still cuts and drifting off the line doesn't end it. A
   * release point is only measured (`draw` false): the cut line and sparks end with the press. Points
   * count toward the cut at once; the next frame draws them, once the stroke goes across.
   */
  const trackPoint = useCallback((clientX: number, clientY: number, draw = true) => {
    const stroke = strokeRef.current;
    if (!stroke || cutCompletedRef.current || isOpening || isPackCut) return;

    const point = getLocalPoint(clientX, clientY);
    if (!point) return;
    const { clampedX, cut, spark } = point;

    if (!stroke.across) {
      // Read from everything the press has covered, this point included even past the pack's top or
      // bottom, so a settle and a swipe add up rather than the first few pixels deciding.
      const spanX = Math.max(stroke.maxX, clampedX) - Math.min(stroke.minX, clampedX);
      const spanY = Math.max(stroke.maxY, point.y) - Math.min(stroke.minY, point.y);
      if (spanY >= VERTICAL_REJECT_PX && spanY >= 2 * spanX) {
        // Clearly up or down: nothing has drawn, so there's nothing to clear but what was waiting.
        cancelFrame();
        strokeRef.current = null;
        blockedRef.current = true;
        setIsPressing(false);
        return;
      }
      if (spanX >= GESTURE_SLOP_PX && spanX >= spanY) {
        stroke.across = true;
        // Play fairy dust sound when cutting starts
        if (draw && volume > 0) {
          if (fairyDustRef.current) {
            fairyDustRef.current.pause();
            fairyDustRef.current.currentTime = 0;
          }
          fairyDustRef.current = new Audio(FAIRY_DUST_SRC);
          fairyDustRef.current.volume = soundVolume(FAIRY_DUST_SRC, volume);
          fairyDustRef.current.play().catch(() => { });
        }
      }
    }

    if (point.y < 0 || point.y > point.height) return;

    stroke.minX = Math.min(stroke.minX, clampedX);
    stroke.maxX = Math.max(stroke.maxX, clampedX);
    stroke.minY = Math.min(stroke.minY, point.y);
    stroke.maxY = Math.max(stroke.maxY, point.y);
    if (!draw) return;

    if (strokeCuts(stroke, point.width, DRAG_CUT_RATIO)) {
      completeCut();
      return;
    }

    const pending = pendingCutsRef.current;
    pending.push(cut);
    if (pending.length > MAX_CUT_POINTS) pending.shift();
    pendingSparkRef.current = spark;
    if (stroke.across && frameRef.current === null) frameRef.current = requestAnimationFrame(drawFrame);
  }, [isOpening, isPackCut, getLocalPoint, cancelFrame, completeCut, drawFrame, volume]);

  const endCutAttempt = useCallback(() => {
    cancelFrame();
    measureRef.current = null;
    setIsCutting(false);
    setIsPressing(false);
    isPointerDownRef.current = false;
    ownerRef.current = null;
    clearSparks();

    // Stop fairy dust sound
    if (fairyDustRef.current) {
      fairyDustRef.current.pause();
      fairyDustRef.current = null;
    }

    strokeRef.current = null;
    if (!cutCompletedRef.current) {
      setCutPoints([]);
    }
  }, [clearSparks, cancelFrame]);

  const handlePointerDown = useCallback((event: PointerEvent) => {
    if (event.button !== 0) return;
    if (ownerRef.current !== null) {
      // Another finger, or another kind of pointer (a mouse is primary even while a finger is down),
      // while one is down: not part of this stroke.
      if (event.pointerId !== ownerRef.current
        && (event.isPrimary === false || event.pointerType !== ownerTypeRef.current)) return;
      // Otherwise the owner's release was lost (a mouse can't press twice, and a primary touch means
      // no other is down), so this press starts afresh. A lost release followed by another kind of
      // pointer waits for the same kind to press again, or for the window to lose focus.
      endCutAttempt();
    }
    ownerRef.current = event.pointerId;
    ownerTypeRef.current = event.pointerType;
    blockedRef.current = false;
    // The pack's top bar (its X) can sit over the tear line on a phone, and the Open pack and Try again
    // buttons under the pack can meet its art: pressing them never cuts.
    if (disabled || (event.target as Element | null)?.closest?.('[role="dialog"], .sheet-backdrop, .pack-top-bar, .pack-actions')) {
      blockedRef.current = true;
      return;
    }
    measureRef.current = null;
    const point = getLocalPoint(event.clientX, event.clientY);
    // A press beside the pack, dragged onto it, doesn't cut either.
    if (!point || point.x < 0 || point.x > point.width || point.y < 0 || point.y > point.height) {
      blockedRef.current = true;
      return;
    }
    isPointerDownRef.current = true;
    if (isOpening || isPackCut) return;
    // Only a press on the seam can cut. One on the art (a tap, or a swipe or scroll from there) gets a
    // nudge, even if it's dragged onto the seam later (#267).
    if (Math.abs(point.y - point.tearY) > point.tolerance) {
      blockedRef.current = true;
      onMiss?.();
      return;
    }
    if (cutCompletedRef.current) return;
    // Nothing draws until the stroke is known to go across; its first point waits for that frame.
    strokeRef.current = {
      minX: point.clampedX,
      maxX: point.clampedX,
      minY: point.y,
      maxY: point.y,
      across: false,
    };
    pendingCutsRef.current = [point.cut];
    pendingSparkRef.current = null;
    setIsPressing(true);
  }, [endCutAttempt, disabled, getLocalPoint, isOpening, isPackCut, onMiss]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    if (blockedRef.current || disabled || cutCompletedRef.current || isOpening || isPackCut) return;
    if (!isPointerDownRef.current || event.pointerId !== ownerRef.current) return;
    for (const { clientX, clientY } of pointsOf(event)) trackPoint(clientX, clientY);
  }, [trackPoint, disabled, isOpening, isPackCut]);

  /**
   * On release, a stroke that started on the seam, went across and is wide enough finishes the cut.
   * The release's points are read for direction too, so a flick with no moves before it is judged
   * like any other swipe.
   */
  const handlePointerEnd = useCallback((event?: PointerEvent) => {
    if (event && ownerRef.current !== null && event.pointerId !== ownerRef.current) return;
    blockedRef.current = false;
    ownerRef.current = null;
    if (!isPointerDownRef.current && !strokeRef.current) return;
    if (event?.type === 'pointerup' && strokeRef.current && !disabled && !isOpening && !isPackCut) {
      // The release point (and any coalesced into it) counts, so a flick with no moves still cuts.
      for (const { clientX, clientY } of [...pointsOf(event), event]) trackPoint(clientX, clientY, false);
      const width = measurePack()?.rect.width;
      const stroke = strokeRef.current;
      if (width !== undefined && stroke && strokeCuts(stroke, width, RELEASE_CUT_RATIO)) completeCut();
      // A tap on the seam (it never went across, nor up or down far enough to be a scroll) cuts
      // nothing, so the pack shows the swipe instead (#485).
      else if (stroke && !stroke.across) onSeamTap?.();
    }
    endCutAttempt();
  }, [disabled, isOpening, isPackCut, trackPoint, measurePack, completeCut, endCutAttempt, onSeamTap]);

  const cleanup = useCallback(() => {
    if (fairyDustRef.current) {
      fairyDustRef.current.pause();
      fairyDustRef.current.src = '';
      fairyDustRef.current = null;
    }
    // useSparks owns its unmount cleanup; don't update particle state from this teardown.
  }, []);

  return {
    packRef,
    isCutting,
    isPressing,
    cutPoints,
    sparks,
    resetCutState,
    completeCut,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    endCutAttempt,
    cleanup,
  };
};

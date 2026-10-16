import { useState, useCallback, useRef } from 'react';
import { useSparks } from './useSparks';
import { mapPackPointer } from './packCutCoordinates';
import { FAIRY_DUST_SRC, WOOSH_SRC } from '../constants/audio';

// Pack cutting constants
const TEAR_LINE_RATIO = 0.19;
/** A stroke spanning this much of the pack's width opens it while it's still moving. */
const DRAG_CUT_RATIO = 0.45;
/** A stroke spanning this much opens the pack when it's released: a short swipe is enough (#312). */
const RELEASE_CUT_RATIO = 0.2;
/** Nor less than this, in CSS pixels, however small the pack. */
const MIN_CUT_PX = 32;
const MAX_CUT_POINTS = 64;
const DRAWN_CUT_OFFSET_RATIO = 0.000;
const CUT_LINE_RATIO = TEAR_LINE_RATIO + DRAWN_CUT_OFFSET_RATIO;

export interface CutPoint {
  x: number;
  y: number;
}

/** The extent, in pack bounding-box pixels, of a stroke that started on the tear line. */
interface CutStroke {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
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
  return across >= Math.max(MIN_CUT_PX, packWidth * ratio) && across >= stroke.maxY - stroke.minY;
};

/** The event's points in order, including any the browser coalesced into it, so a fast flick counts. */
const pointsOf = (event: PointerEvent): { clientX: number; clientY: number }[] => {
  const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
  return coalesced.length > 0 ? coalesced : [event];
};

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
}

export const usePackCutter = ({ onCutComplete, isOpening, isPackCut, volume = 1, particlesEnabled = true, disabled = false, onMiss }: UsePackCutterOptions) => {
  const [isCutting, setIsCutting] = useState(false);
  const [cutPoints, setCutPoints] = useState<CutPoint[]>([]);

  const { sparks, emitSpark, clearSparks } = useSparks(particlesEnabled);

  const packRef = useRef<HTMLDivElement>(null);
  /** The stroke on the tear line so far, or null until a press reaches it. */
  const strokeRef = useRef<CutStroke | null>(null);
  const cutCompletedRef = useRef(false);
  const isPointerDownRef = useRef(false);
  /**
   * The pointer whose press this is. Every other pointer is ignored until it's released, so a second
   * finger can't stretch the first one's stroke.
   */
  const ownerRef = useRef<number | null>(null);
  /**
   * This press started over something else (an open sheet) or beside the pack, so it can't cut until
   * it's released.
   */
  const blockedRef = useRef(false);
  const fairyDustRef = useRef<HTMLAudioElement | null>(null);

  const resetCutState = useCallback(() => {
    setIsCutting(false);
    setCutPoints([]);
    clearSparks();
    strokeRef.current = null;
    cutCompletedRef.current = false;
  }, [clearSparks]);

  const getLocalPoint = useCallback((clientX: number, clientY: number) => {
    const pack = packRef.current;
    if (!pack) return null;
    const rect = pack.getBoundingClientRect();
    return {
      ...mapPackPointer(clientX, clientY, rect, pack, CUT_LINE_RATIO),
      tearY: rect.height * TEAR_LINE_RATIO,
      tolerance: Math.min(52, Math.max(26, rect.height * 0.08)),
    };
  }, []);

  const completeCut = useCallback(() => {
    if (cutCompletedRef.current) return;

    cutCompletedRef.current = true;
    setIsCutting(false);
    setCutPoints([]);
    clearSparks();

    // Play woosh sound
    if (volume > 0) {
      const woosh = new Audio(WOOSH_SRC);
      woosh.volume = volume;
      woosh.onended = () => { woosh.src = ''; };
      woosh.play().catch(() => { });
    }

    onCutComplete();
  }, [onCutComplete, clearSparks, volume]);

  /**
   * Follow one pointer position. A stroke starts where a press reaches the tear line; after that,
   * any point over the pack's height counts (x past an edge counts as that edge), so a slanted swipe
   * still cuts and drifting off the line doesn't end it. A release point is only measured (`draw`
   * false): the cut line and sparks end with the press.
   */
  const trackPoint = useCallback((clientX: number, clientY: number, draw = true) => {
    if (cutCompletedRef.current || isOpening || isPackCut) return;

    const point = getLocalPoint(clientX, clientY);
    if (!point) return;

    const offLine = Math.abs(point.y - point.tearY);
    const { clampedX, cut, spark } = point;
    const stroke = strokeRef.current;

    if (!stroke) {
      if (offLine > point.tolerance || !draw) return;
      strokeRef.current = { minX: clampedX, maxX: clampedX, minY: point.y, maxY: point.y };
      setIsCutting(true);
      setCutPoints([cut]);
      emitSpark(spark.x, spark.y);

      // Play fairy dust sound when cutting starts
      if (volume > 0) {
        if (fairyDustRef.current) {
          fairyDustRef.current.pause();
          fairyDustRef.current.currentTime = 0;
        }
        fairyDustRef.current = new Audio(FAIRY_DUST_SRC);
        fairyDustRef.current.volume = volume;
        fairyDustRef.current.play().catch(() => { });
      }
      return;
    }

    if (point.y < 0 || point.y > point.height) return;

    stroke.minX = Math.min(stroke.minX, clampedX);
    stroke.maxX = Math.max(stroke.maxX, clampedX);
    stroke.minY = Math.min(stroke.minY, point.y);
    stroke.maxY = Math.max(stroke.maxY, point.y);
    if (!draw) return;

    setCutPoints((prev) => {
      const next = [...prev, cut];
      return next.length > MAX_CUT_POINTS ? next.slice(next.length - MAX_CUT_POINTS) : next;
    });
    emitSpark(spark.x, spark.y);

    if (strokeCuts(stroke, point.width, DRAG_CUT_RATIO)) {
      completeCut();
    }
  }, [isOpening, isPackCut, getLocalPoint, emitSpark, completeCut, volume]);

  const endCutAttempt = useCallback(() => {
    setIsCutting(false);
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
  }, [clearSparks]);

  const handlePointerDown = useCallback((event: PointerEvent) => {
    if (event.button !== 0) return;
    if (ownerRef.current !== null) {
      // Another finger while one is down: not part of this stroke.
      if (event.pointerId !== ownerRef.current && event.isPrimary === false) return;
      // Otherwise the owner's release was lost (a mouse can't press twice, and a primary touch means
      // no other is down), so this press starts afresh.
      endCutAttempt();
    }
    ownerRef.current = event.pointerId;
    blockedRef.current = false;
    // The pack's top bar (its X) can sit over the tear line on a phone: pressing it never cuts.
    if (disabled || (event.target as Element | null)?.closest?.('[role="dialog"], .sheet-backdrop, .pack-top-bar')) {
      blockedRef.current = true;
      return;
    }
    const point = getLocalPoint(event.clientX, event.clientY);
    // A press beside the pack, dragged onto it, doesn't cut either.
    if (!point || point.x < 0 || point.x > point.width || point.y < 0 || point.y > point.height) {
      blockedRef.current = true;
      return;
    }
    isPointerDownRef.current = true;
    if (Math.abs(point.y - point.tearY) > point.tolerance && !isOpening && !isPackCut) onMiss?.();
    trackPoint(event.clientX, event.clientY);
  }, [trackPoint, endCutAttempt, disabled, getLocalPoint, isOpening, isPackCut, onMiss]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    if (blockedRef.current || disabled || cutCompletedRef.current || isOpening || isPackCut) return;
    if (!isPointerDownRef.current || event.pointerId !== ownerRef.current) return;
    for (const { clientX, clientY } of pointsOf(event)) trackPoint(clientX, clientY);
  }, [trackPoint, disabled, isOpening, isPackCut]);

  /** On release, a stroke that started on the tear line and is wide enough finishes the cut. */
  const handlePointerEnd = useCallback((event?: PointerEvent) => {
    if (event && ownerRef.current !== null && event.pointerId !== ownerRef.current) return;
    blockedRef.current = false;
    ownerRef.current = null;
    if (!isPointerDownRef.current && !strokeRef.current) return;
    if (event?.type === 'pointerup' && strokeRef.current && !disabled && !isOpening && !isPackCut) {
      // The release point (and any coalesced into it) counts, so a flick with no moves still cuts.
      for (const { clientX, clientY } of [...pointsOf(event), event]) trackPoint(clientX, clientY, false);
      const pack = packRef.current;
      const stroke = strokeRef.current;
      if (pack && stroke && strokeCuts(stroke, pack.getBoundingClientRect().width, RELEASE_CUT_RATIO)) completeCut();
    }
    endCutAttempt();
  }, [disabled, isOpening, isPackCut, trackPoint, completeCut, endCutAttempt]);

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

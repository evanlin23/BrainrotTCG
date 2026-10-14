import { useState, useCallback, useRef } from 'react';
import { useSparks } from './useSparks';
import { FAIRY_DUST_SRC, WOOSH_SRC } from '../constants/audio';

// Pack cutting constants
const TEAR_LINE_RATIO = 0.19;
const REQUIRED_CUT_RATIO = 0.72;
const MAX_CUT_POINTS = 64;
const DRAWN_CUT_OFFSET_RATIO = 0.000;

export interface CutPoint {
  x: number;
  y: number;
}

interface CutSpan {
  minX: number;
  maxX: number;
}

const EMPTY_CUT_SPAN: CutSpan = {
  minX: Number.POSITIVE_INFINITY,
  maxX: Number.NEGATIVE_INFINITY,
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
  const cutSpanRef = useRef<CutSpan>({ ...EMPTY_CUT_SPAN });
  const cutCompletedRef = useRef(false);
  const isPointerDownRef = useRef(false);
  /** This press started over something else (an open sheet), so it can't cut until it's released. */
  const blockedRef = useRef(false);
  const fairyDustRef = useRef<HTMLAudioElement | null>(null);

  const resetCutState = useCallback(() => {
    setIsCutting(false);
    setCutPoints([]);
    clearSparks();
    cutSpanRef.current = { ...EMPTY_CUT_SPAN };
    cutCompletedRef.current = false;
  }, [clearSparks]);

  const getLocalPoint = useCallback((clientX: number, clientY: number) => {
    const rect = packRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
      top: rect.top,
      width: rect.width,
      height: rect.height,
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

  const beginOrContinueCut = useCallback((clientX: number, clientY: number) => {
    if (cutCompletedRef.current || isOpening || isPackCut) return;

    const point = getLocalPoint(clientX, clientY);
    if (!point) return;

    const nearTearLine = Math.abs(point.y - point.tearY) <= point.tolerance;
    if (!nearTearLine) {
      return;
    }

    const clampedX = Math.min(point.width, Math.max(0, point.x));
    const xPercent = (clampedX / point.width) * 100;
    const yPercent = (TEAR_LINE_RATIO + DRAWN_CUT_OFFSET_RATIO) * 100;
    const sparkY = point.top + (point.height * yPercent) / 100;

    if (!isCutting) {
      setIsCutting(true);
      setCutPoints([{ x: xPercent, y: yPercent }]);
      cutSpanRef.current = { minX: clampedX, maxX: clampedX };
      emitSpark(clientX, sparkY);

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

    setCutPoints((prev) => {
      const next = [...prev, { x: xPercent, y: yPercent }];
      return next.length > MAX_CUT_POINTS ? next.slice(next.length - MAX_CUT_POINTS) : next;
    });
    emitSpark(clientX, sparkY);

    const span = cutSpanRef.current;
    span.minX = Math.min(span.minX, clampedX);
    span.maxX = Math.max(span.maxX, clampedX);
    cutSpanRef.current = span;

    const coveredDistance = Math.max(0, span.maxX - span.minX);

    const touchedLeft = span.minX <= point.width * 0.18;
    const touchedRight = span.maxX >= point.width * 0.82;

    if (touchedLeft && touchedRight && coveredDistance >= point.width * REQUIRED_CUT_RATIO) {
      completeCut();
    }
  }, [isCutting, isOpening, isPackCut, getLocalPoint, emitSpark, completeCut, volume]);

  const endCutAttempt = useCallback(() => {
    setIsCutting(false);
    isPointerDownRef.current = false;
    clearSparks();

    // Stop fairy dust sound
    if (fairyDustRef.current) {
      fairyDustRef.current.pause();
      fairyDustRef.current = null;
    }

    if (!cutCompletedRef.current) {
      setCutPoints([]);
      cutSpanRef.current = { ...EMPTY_CUT_SPAN };
    }
  }, [clearSparks]);

  const handlePointerDown = useCallback((event: PointerEvent) => {
    if (event.button !== 0) return;
    if (disabled || (event.target as Element | null)?.closest?.('[role="dialog"], .sheet-backdrop')) {
      blockedRef.current = true;
      return;
    }
    isPointerDownRef.current = true;
    const point = getLocalPoint(event.clientX, event.clientY);
    const onPack = !!point && point.x >= 0 && point.x <= point.width && point.y >= 0 && point.y <= point.height;
    if (onPack && Math.abs(point.y - point.tearY) > point.tolerance && !isOpening && !isPackCut) onMiss?.();
    beginOrContinueCut(event.clientX, event.clientY);
  }, [beginOrContinueCut, disabled, getLocalPoint, isOpening, isPackCut, onMiss]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    if (blockedRef.current || disabled || cutCompletedRef.current || isOpening || isPackCut) return;
    const isPressed = isPointerDownRef.current || event.buttons === 1 || event.pressure > 0;
    if (!isPressed) return;
    beginOrContinueCut(event.clientX, event.clientY);
  }, [beginOrContinueCut, disabled, isOpening, isPackCut]);

  const handlePointerEnd = useCallback(() => {
    blockedRef.current = false;
    if (!isPointerDownRef.current && !isCutting) return;
    endCutAttempt();
  }, [isCutting, endCutAttempt]);

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

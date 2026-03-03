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
}

export const usePackCutter = ({ onCutComplete, isOpening, isPackCut }: UsePackCutterOptions) => {
  const [isCutting, setIsCutting] = useState(false);
  const [cutPoints, setCutPoints] = useState<CutPoint[]>([]);

  const { sparks, emitSpark, clearSparks } = useSparks();

  const packRef = useRef<HTMLDivElement>(null);
  const cutSpanRef = useRef<CutSpan>({ ...EMPTY_CUT_SPAN });
  const cutCompletedRef = useRef(false);
  const isPointerDownRef = useRef(false);
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
    const woosh = new Audio(WOOSH_SRC);
    woosh.onended = () => { woosh.src = ''; };
    woosh.play().catch(() => { });

    onCutComplete();
  }, [onCutComplete, clearSparks]);

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
      if (fairyDustRef.current) {
        fairyDustRef.current.pause();
        fairyDustRef.current.currentTime = 0;
      }
      fairyDustRef.current = new Audio(FAIRY_DUST_SRC);
      fairyDustRef.current.play().catch(() => { });
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
  }, [isCutting, isOpening, isPackCut, getLocalPoint, emitSpark, completeCut]);

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
    isPointerDownRef.current = true;
    beginOrContinueCut(event.clientX, event.clientY);
  }, [beginOrContinueCut]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    if (cutCompletedRef.current || isOpening || isPackCut) return;
    const isPressed = isPointerDownRef.current || event.buttons === 1 || event.pressure > 0;
    if (!isPressed) return;
    beginOrContinueCut(event.clientX, event.clientY);
  }, [beginOrContinueCut, isOpening, isPackCut]);

  const handlePointerEnd = useCallback(() => {
    if (!isPointerDownRef.current && !isCutting) return;
    endCutAttempt();
  }, [isCutting, endCutAttempt]);

  const cleanup = useCallback(() => {
    if (fairyDustRef.current) {
      fairyDustRef.current.pause();
      fairyDustRef.current.src = '';
      fairyDustRef.current = null;
    }
    clearSparks();
  }, [clearSparks]);

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

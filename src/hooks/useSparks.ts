import { useCallback, useLayoutEffect, useRef } from 'react';
import { createSparkField, type SparkField } from './sparkField';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * Spark work follows the particle setting and the current motion preference: with particles off or
 * motion reduced (the Motion setting or the device's, watched live), no field exists, emitSpark does
 * nothing and no frame is ever requested. The sparks are drawn on the canvas that `sparkCanvasRef` is
 * attached to (sparkField.ts), so a swipe never re-renders for them.
 */
export const useSparks = (enabled = true) => {
  const reducedMotion = usePrefersReducedMotion();
  const active = enabled && !reducedMotion;
  const activeRef = useRef(active);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fieldRef = useRef<{ canvas: HTMLCanvasElement; field: SparkField; stopWatching: () => void } | null>(null);

  const detach = useCallback(() => {
    const current = fieldRef.current;
    fieldRef.current = null;
    current?.stopWatching();
    current?.field.dispose();
  }, []);

  // A field exists while there is a canvas to draw on and particles are on. Layout pixels follow the
  // canvas's own box (which no ancestor scale or rotation changes), so a spark lands where the cut does.
  const attach = useCallback(() => {
    const canvas = canvasRef.current;
    if (!activeRef.current || !canvas) {
      detach();
      return;
    }
    if (fieldRef.current?.canvas === canvas) return;
    detach();
    const glow = getComputedStyle(canvas).getPropertyValue('--spark-glow').trim();
    const field = createSparkField(canvas, { glow });
    // The canvas is a band around the seam (PackOpener.css), so it moves when the pack's size does as
    // well as when its own does: watch both. A callback runs after layout, so reading the box is free.
    const measure = () => field.resize(canvas.clientWidth, canvas.clientHeight, canvas.offsetLeft, canvas.offsetTop);
    let stopWatching = () => {};
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(canvas);
      if (canvas.parentElement) observer.observe(canvas.parentElement);
      stopWatching = () => observer.disconnect();
    } else {
      measure();
    }
    fieldRef.current = { canvas, field, stopWatching };
  }, [detach]);

  /** For the canvas in the pack: sparks draw on it for as long as it is mounted. */
  const sparkCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    attach();
  }, [attach]);

  // Changing the preference or unmounting ends the field, its pending frame included.
  useLayoutEffect(() => {
    activeRef.current = active;
    attach();
    return detach;
  }, [active, attach, detach]);

  /** Throw a burst of sparks from a point in the pack's layout pixels. */
  const emitSpark = useCallback((x: number, y: number) => {
    fieldRef.current?.field.emit(x, y);
  }, []);

  const clearSparks = useCallback(() => {
    fieldRef.current?.field.clear();
  }, []);

  return { sparkCanvasRef, emitSpark, clearSparks };
};

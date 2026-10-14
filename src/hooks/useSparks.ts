import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react';

export interface Spark {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  size: number;
  hue: number;
}

const MAX_SPARKS = 220;
const SPARK_LIFETIME_MS = 620;
const SPARK_THROTTLE_MS = 9;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const subscribeReducedMotion = (onChange: () => void) => {
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};

/** Spark work follows the particle setting and the device's current motion preference. */
export const useSparks = (enabled = true) => {
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
  const active = enabled && !reducedMotion;
  const [sparks, setSparks] = useState<Spark[]>([]);
  const sparkIdRef = useRef(0);
  const sparkTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastSparkAtRef = useRef(0);

  const cancelSparkTimers = useCallback(() => {
    sparkTimeoutsRef.current.forEach(timer => window.clearTimeout(timer));
    sparkTimeoutsRef.current = [];
    lastSparkAtRef.current = 0;
  }, []);

  // Changing the preference or unmounting owns timer cancellation, without updating unmounted state.
  useEffect(() => cancelSparkTimers, [active, cancelSparkTimers]);

  // Discard the old particles immediately so re-enabling never revives an expired burst.
  if (!active && sparks.length > 0) setSparks([]);

  const clearSparks = useCallback(() => {
    cancelSparkTimers();
    setSparks(prev => prev.length > 0 ? [] : prev);
  }, [cancelSparkTimers]);

  /**
   * Emit spark particles at the given position
   */
  const emitSpark = useCallback((clientX: number, clientY: number) => {
    if (!active) return;
    const now = Date.now();
    if (now - lastSparkAtRef.current < SPARK_THROTTLE_MS) return;
    lastSparkAtRef.current = now;

    const burstCount = 3;
    const newSparks: Spark[] = Array.from({ length: burstCount }, () => {
      const id = sparkIdRef.current++;
      return {
        id,
        x: clientX + (Math.random() * 16 - 8),
        y: clientY + (Math.random() * 4 - 2),
        dx: Math.random() * 56 - 28,
        dy: -(Math.random() * 36 + 10),
        size: Math.round(Math.random() * 8 + 9),
        hue: Math.round(Math.random() * 24 + 38),
      };
    });

    setSparks(prev => {
      const next = [...prev, ...newSparks];
      return next.length > MAX_SPARKS ? next.slice(next.length - MAX_SPARKS) : next;
    });

    // A burst shares one lifetime, so expire its contiguous IDs in one update.
    const firstId = newSparks[0].id;
    const lastId = newSparks[newSparks.length - 1].id;
    const timeout = window.setTimeout(() => {
      setSparks(prev => prev.filter(item => item.id < firstId || item.id > lastId));
      sparkTimeoutsRef.current = sparkTimeoutsRef.current.filter(item => item !== timeout);
    }, SPARK_LIFETIME_MS);
    sparkTimeoutsRef.current.push(timeout);
  }, [active]);

  return {
    sparks: active ? sparks : [],
    emitSpark,
    clearSparks,
  };
};

import { useState, useCallback, useRef } from 'react';

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

/**
 * Hook for managing spark particle effects
 */
export const useSparks = () => {
  const [sparks, setSparks] = useState<Spark[]>([]);
  const sparkIdRef = useRef(0);
  const sparkTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastSparkAtRef = useRef(0);

  /**
   * Clear all sparks and their timeouts
   */
  const clearSparks = useCallback(() => {
    sparkTimeoutsRef.current.forEach(timer => window.clearTimeout(timer));
    sparkTimeoutsRef.current = [];
    setSparks([]);
  }, []);

  /**
   * Emit spark particles at the given position
   */
  const emitSpark = useCallback((clientX: number, clientY: number) => {
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

    // Schedule removal of each spark
    newSparks.forEach(spark => {
      const timeout = window.setTimeout(() => {
        setSparks(prev => prev.filter(item => item.id !== spark.id));
        sparkTimeoutsRef.current = sparkTimeoutsRef.current.filter(item => item !== timeout);
      }, SPARK_LIFETIME_MS);
      sparkTimeoutsRef.current.push(timeout);
    });
  }, []);

  return {
    sparks,
    emitSpark,
    clearSparks,
  };
};

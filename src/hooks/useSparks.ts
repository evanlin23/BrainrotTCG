import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react';
import { REDUCED_MOTION_QUERY } from '../utils/motion';

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
/** How long a spark lives; PackCuttingUI hands it to the CSS as --spark-life. */
export const SPARK_LIFETIME_MS = 620;
const SPARK_THROTTLE_MS = 9;
/**
 * Expired bursts leave together, at most once this often, so a swipe re-renders for expiry a few
 * times a second instead of once per burst (#266). A spark can outstay its lifetime by up to this
 * long, after its animation has already faded it out (`forwards`, ending at opacity 0).
 */
const SPARK_EXPIRY_BATCH_MS = 100;
/** The one empty state, so a disabled or idle pack keeps the same array between renders. */
const EMPTY_SPARKS: readonly Spark[] = [];

const subscribeReducedMotion = (onChange: () => void) => {
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};

/**
 * Spark work follows the particle setting and the device's current motion preference: with
 * particles off or `prefers-reduced-motion: reduce` (watched live), emitSpark does nothing, the
 * pending removal timer is cancelled and the hook returns EMPTY_SPARKS.
 */
export const useSparks = (enabled = true) => {
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
  const active = enabled && !reducedMotion;
  const [sparks, setSparks] = useState<readonly Spark[]>(EMPTY_SPARKS);
  const sparkIdRef = useRef(0);
  /** Bursts on screen, oldest first: each one's last spark ID and when it expires. */
  const burstsRef = useRef<{ lastId: number; expiresAt: number }[]>([]);
  /** The one expiry timer, pending while any burst is on screen. */
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSparkAtRef = useRef(0);

  const cancelSparkTimers = useCallback(() => {
    if (expiryTimerRef.current !== null) window.clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = null;
    burstsRef.current = [];
    lastSparkAtRef.current = 0;
  }, []);

  /**
   * Remove every burst that has expired in one update (IDs only grow, and every burst lives as long,
   * so they expire oldest first), then wait for the next one, but at least SPARK_EXPIRY_BATCH_MS.
   */
  const startExpiryTimer = useCallback((delay: number) => {
    const expire = () => {
      const now = Date.now();
      const bursts = burstsRef.current;
      let cutoff: number | null = null;
      // A burst due later than a lifetime away means the clock went back: it's expired too.
      while (bursts.length > 0 && (bursts[0].expiresAt <= now || bursts[0].expiresAt - now > SPARK_LIFETIME_MS)) {
        cutoff = bursts[0].lastId;
        bursts.shift();
      }
      if (cutoff !== null) {
        const lastExpired = cutoff;
        setSparks(prev => {
          const next = prev.filter(item => item.id > lastExpired);
          return next.length > 0 ? next : EMPTY_SPARKS;
        });
      }
      expiryTimerRef.current = bursts.length > 0
        ? window.setTimeout(expire, Math.max(bursts[0].expiresAt - now, SPARK_EXPIRY_BATCH_MS))
        : null;
    };
    expiryTimerRef.current = window.setTimeout(expire, delay);
  }, []);

  // Changing the preference or unmounting owns timer cancellation, without updating unmounted state.
  useEffect(() => cancelSparkTimers, [active, cancelSparkTimers]);

  // Discard the old particles immediately so re-enabling never revives an expired burst.
  if (!active && sparks.length > 0) setSparks(EMPTY_SPARKS);

  const clearSparks = useCallback(() => {
    cancelSparkTimers();
    setSparks(prev => prev.length > 0 ? EMPTY_SPARKS : prev);
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

    // One timer serves every burst on screen: the oldest's, or this one's if there's none.
    burstsRef.current.push({ lastId: newSparks[newSparks.length - 1].id, expiresAt: now + SPARK_LIFETIME_MS });
    if (expiryTimerRef.current === null) startExpiryTimer(SPARK_LIFETIME_MS);
  }, [active, startExpiryTimer]);

  return {
    sparks: active ? sparks : EMPTY_SPARKS,
    emitSpark,
    clearSparks,
  };
};

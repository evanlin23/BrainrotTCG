import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How long (ms) after a stage appears its secondary actions ignore clicks. A player who keeps clicking
 * where the last stage's button was lands on this one the moment it appears (#627).
 */
export const STAGE_CLICK_GUARD_MS = 400;

/**
 * Wraps a stage's secondary actions so a click in its first `ms` does nothing. The stage is guarded from
 * its first render (a ref, so a click before any effect has run is ignored too), and a click after the
 * window acts as usual, so a deliberate one is never lost. `settling` mirrors the window for the page
 * to read (data-settling).
 */
export const useStageClickGuard = (ms = STAGE_CLICK_GUARD_MS) => {
  const settlingRef = useRef(true);
  const [settling, setSettling] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      settlingRef.current = false;
      setSettling(false);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [ms]);
  const guard = useCallback(
    <Args extends unknown[]>(action: (...args: Args) => void) =>
      (...args: Args) => {
        if (!settlingRef.current) action(...args);
      },
    [],
  );
  return { guard, settling };
};

import { useCallback, useEffect, useRef, useState } from 'react';
import { markOpenCueUnderstood, OPEN_CUE_MAX_PLAYS, readOpenCuePlays, recordOpenCuePlay } from '../game/openCue';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * The new player's cue on the sealed pack (DESIGN.md Flow 2): a finger and a partial tear play along the
 * seam, at most OPEN_CUE_MAX_PLAYS times on this device, and stop at the first touch. Under reduced motion
 * it is a still mark instead. `enabled` is false once a pack is saved, so a returning player never sees it.
 * Each play is counted as it starts, so reloading mid-play still uses one up.
 */
export const useOpenCue = (enabled: boolean) => {
  const reducedMotion = usePrefersReducedMotion();
  const [showing, setShowing] = useState(() => enabled && readOpenCuePlays() < OPEN_CUE_MAX_PLAYS);
  const counted = useRef(false);
  const cueOn = showing && enabled;
  useEffect(() => {
    if (!cueOn || counted.current) return;
    counted.current = true;
    recordOpenCuePlay();
  }, [cueOn]);
  /** The play ran to its end. */
  const end = useCallback(() => setShowing(false), []);
  /** The pack was touched: the cue stops now and is done for good. */
  const touch = useCallback(() => {
    if (!cueOn) return;
    markOpenCueUnderstood();
    setShowing(false);
  }, [cueOn]);
  return { cue: cueOn ? (reducedMotion ? 'still' : 'play') as 'still' | 'play' : null, end, touch };
};

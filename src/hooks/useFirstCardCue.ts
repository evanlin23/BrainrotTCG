import { useCallback, useEffect, useRef, useState } from 'react';
import { FIRST_CARD_CUE_MAX_PLAYS, readFirstCardCuePlays, recordFirstCardCuePlay } from '../game/firstCardCue';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * The cue on the first card of a player's first pack (DESIGN.md Flow 3): the back lifts toward the viewer, as
 * if to flip, once on this device, and stops at the first input. Under reduced motion it is the caption
 * alone ('still'). `enabled` is true only while that card is face down in a first pack. The play is
 * counted as it starts, so reloading mid-play still uses it up.
 */
export const useFirstCardCue = (enabled: boolean) => {
  const reducedMotion = usePrefersReducedMotion();
  const [showing, setShowing] = useState(() => enabled && readFirstCardCuePlays() < FIRST_CARD_CUE_MAX_PLAYS);
  const counted = useRef(false);
  // The card was flipped or left: the cue is over, and never comes back on a later card.
  if (showing && !enabled) setShowing(false);
  const cueOn = showing && enabled;
  useEffect(() => {
    if (!cueOn || counted.current) return;
    counted.current = true;
    recordFirstCardCuePlay();
  }, [cueOn]);
  /** The play ran to its end, or the card was touched. */
  const end = useCallback(() => setShowing(false), []);
  return { cue: cueOn ? (reducedMotion ? 'still' : 'play') as 'still' | 'play' : null, end };
};

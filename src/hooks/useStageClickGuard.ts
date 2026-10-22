import { useEffect, useState, type SyntheticEvent } from 'react';

/**
 * How long (ms) after a stage appears its secondary actions ignore clicks. A player who keeps clicking
 * where the last stage's button was lands on this one the moment it appears (#627).
 */
export const STAGE_CLICK_GUARD_MS = 400;

/** Marks the stage's one deliberate move, which the guard never holds. */
export const STAGE_PRIMARY_ATTR = 'data-stage-primary';

/**
 * Holds a stage's clicks for its first `ms`: put `blockClicks` on the stage's container as `onClickCapture`
 * and a click on anything inside it (a card, a link, a button that opens a dialog or publishes) never
 * reaches that thing's own handler, except on an element marked `data-stage-primary`. The stage is guarded
 * from its first render (the state starts true, so a click before any effect has run is ignored too), and
 * a click after the window acts as usual, so a deliberate one is never lost. `settling` mirrors the window
 * for the page to read (data-settling); the handler and that attribute change in the same commit, so a
 * page that waits for the attribute to clear never sees a click still held.
 */
export const useStageClickGuard = (ms = STAGE_CLICK_GUARD_MS) => {
  const [settling, setSettling] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettling(false), ms);
    return () => window.clearTimeout(timer);
  }, [ms]);
  const blockClicks = (event: SyntheticEvent) => {
    if (!settling || (event.target as Element).closest(`[${STAGE_PRIMARY_ATTR}]`)) return;
    event.stopPropagation();
    event.preventDefault();
  };
  return { blockClicks, settling };
};

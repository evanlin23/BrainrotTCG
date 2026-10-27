import { useEffect, useRef, MutableRefObject } from 'react';
import { STAGE_CLICK_GUARD_MS } from './useStageClickGuard';

interface UseKeyboardControlsOptions {
  isOpening: boolean;
  showSummary: boolean;
  disabled: boolean;
  onCloseSummary: () => void;
  /** Open the pack on screen (the keyboard's version of the swipe), when focus is on it. */
  onOpenPack: () => void;
  handleInteractionRef: MutableRefObject<() => void>;
  /** A pack is on screen, at any stage from the tear to the summary: Escape leaves it. */
  inPack?: boolean;
  /** Back to the packs screen, as the pack's X does (Escape). */
  onLeave?: () => void;
}

/** Fields that take typing keep their keys. Any contenteditable value but "false" makes one ("" is "true"). */
const TEXT_FIELD = 'input, select, textarea, [contenteditable]:not([contenteditable="false"])';

/** The sealed pack, the one control that opens it (PackCuttingUI): its keys work only with focus on it. */
const PACK_CONTROL = '[data-pack-open]';

/** A held Space waits this long before it repeats, so a press held a moment still does one thing. */
const HOLD_DELAY_MS = 400;
/** Then it moves on a card this often. */
const HOLD_REPEAT_MS = 150;

/** A sheet open over the pack, whose buttons need these keys. */
const sheetOpen = () => document.querySelector('[role="dialog"][aria-modal="true"]') !== null;

/**
 * Space or Enter does the next thing: open the pack (only with focus on it, so typing or pressing keys
 * elsewhere never tears one), flip, next card, next pack. Holding Space runs through the cards. Escape leaves a pack at any stage. With Ctrl, Cmd or Alt held, none of these
 * keys do anything. The listeners are added once and read the latest state from a ref, so a
 * re-render can't cancel a held Space.
 */
export const useKeyboardControls = (options: UseKeyboardControlsOptions) => {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const spaceHeldRef = useRef(false);
  const spaceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summarySettledRef = useRef(!options.showSummary);

  useEffect(() => {
    const stopHold = () => {
      spaceHeldRef.current = false;
      if (spaceTimerRef.current) {
        clearTimeout(spaceTimerRef.current);
        spaceTimerRef.current = null;
      }
    };

    const repeatAfter = (ms: number) => {
      spaceTimerRef.current = setTimeout(() => {
        // A sheet opened over the pack, or the pack turned disabled, ends the hold: a press would be ignored now too.
        if (latest.current.disabled || sheetOpen()) {
          stopHold();
          return;
        }
        latest.current.handleInteractionRef.current();
        if (spaceHeldRef.current) repeatAfter(HOLD_REPEAT_MS);
      }, ms);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const { isOpening, showSummary, disabled, onCloseSummary, onOpenPack, handleInteractionRef, inPack, onLeave } = latest.current;
      // Ignore if disabled, or if a sheet is open over the pack (its buttons need these keys), or if
      // focus is on a control that Space or Enter already activates. A reveal card is a button that
      // opts in (data-pack-keys), so a held Space keeps moving on; preventing the key stops its click.
      if (disabled) return;
      if (sheetOpen()) return;
      // Ctrl, Cmd and Alt combos belong to the browser and the system (Ctrl+Enter, Alt+Space), never the pack.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // Escape belongs to whatever is on top: a sheet closes itself first, and a text field keeps it.
      if (e.key === 'Escape') {
        if (!inPack || !onLeave || e.defaultPrevented || e.repeat) return;
        if (target?.closest(TEXT_FIELD)) return;
        e.preventDefault();
        onLeave();
        return;
      }
      const isKey = e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter';
      if (isKey && target?.closest(`button:not([data-pack-keys]), a, ${TEXT_FIELD}`)) return;

      if (!isKey) return;
      // A sealed pack opens only from the pack itself; anywhere else the key is the page's own.
      if (!showSummary && !isOpening && !target?.closest(PACK_CONTROL)) return;
      e.preventDefault();
      if (e.repeat) return;

      if (showSummary) {
        if (!summarySettledRef.current) return;
        onCloseSummary();
      } else if (!isOpening) {
        onOpenPack();
      } else if (e.code !== 'Space') {
        handleInteractionRef.current();
      } else if (!spaceHeldRef.current) {
        // Held Space keeps going, once it has been held past a tap.
        spaceHeldRef.current = true;
        handleInteractionRef.current();
        repeatAfter(HOLD_DELAY_MS);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') stopHold();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', stopHold);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', stopHold);
      stopHold();
    };
  }, []);

  // The summary stops a held Space and guards against stuck keys for STAGE_CLICK_GUARD_MS.
  useEffect(() => {
    if (options.showSummary) {
      summarySettledRef.current = false;
      if (spaceTimerRef.current) {
        clearTimeout(spaceTimerRef.current);
        spaceTimerRef.current = null;
        spaceHeldRef.current = false;
      }
      const timer = setTimeout(() => {
        summarySettledRef.current = true;
      }, STAGE_CLICK_GUARD_MS);
      return () => clearTimeout(timer);
    }
    summarySettledRef.current = true;
  }, [options.showSummary]);
};

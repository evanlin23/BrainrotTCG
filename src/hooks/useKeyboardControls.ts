import { useEffect, useRef, MutableRefObject } from 'react';

interface UseKeyboardControlsOptions {
  isOpening: boolean;
  showSummary: boolean;
  disabled: boolean;
  onCloseSummary: () => void;
  /** Open the pack on screen (the keyboard's version of the swipe). */
  onOpenPack: () => void;
  handleInteractionRef: MutableRefObject<() => void>;
  /** Close the reveal, as its close button does (Escape). */
  onLeave?: () => void;
}

/** Fields that take typing keep their keys. Any contenteditable value but "false" makes one ("" is "true"). */
const TEXT_FIELD = 'input, select, textarea, [contenteditable]:not([contenteditable="false"])';

/**
 * Space or Enter does the next thing: open the pack, flip, next card, next pack. Holding Space runs
 * through the cards. Escape closes a reveal. With Ctrl, Cmd or Alt held, none of these keys do anything. The listeners are added once and read the latest state from a ref, so a
 * re-render can't cancel a held Space.
 */
export const useKeyboardControls = (options: UseKeyboardControlsOptions) => {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const spaceHeldRef = useRef(false);
  const spaceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const stopHold = () => {
      spaceHeldRef.current = false;
      if (spaceIntervalRef.current) {
        clearInterval(spaceIntervalRef.current);
        spaceIntervalRef.current = null;
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const { isOpening, showSummary, disabled, onCloseSummary, onOpenPack, handleInteractionRef, onLeave } = latest.current;
      // Ignore if disabled, or if a sheet is open over the pack (its buttons need these keys), or if
      // focus is on a control that Space or Enter already activates.
      if (disabled) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      // Ctrl, Cmd and Alt combos belong to the browser and the system (Ctrl+Enter, Alt+Space), never the pack.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // Escape belongs to whatever is on top: a sheet closes itself first, and a text field keeps it.
      if (e.key === 'Escape') {
        if (!isOpening || showSummary || !onLeave || e.defaultPrevented || e.repeat) return;
        if (target?.closest(TEXT_FIELD)) return;
        e.preventDefault();
        onLeave();
        return;
      }
      const isKey = e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter';
      if (isKey && target?.closest(`button, a, ${TEXT_FIELD}`)) return;

      if (!isKey) return;
      e.preventDefault();
      if (e.repeat) return;

      if (showSummary) {
        onCloseSummary();
      } else if (!isOpening) {
        onOpenPack();
      } else if (e.code !== 'Space') {
        handleInteractionRef.current();
      } else if (!spaceHeldRef.current) {
        // Held Space keeps going, a card every 150ms.
        spaceHeldRef.current = true;
        handleInteractionRef.current();
        spaceIntervalRef.current = setInterval(() => latest.current.handleInteractionRef.current(), 150);
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

  // The summary stops a held Space.
  useEffect(() => {
    if (options.showSummary && spaceIntervalRef.current) {
      clearInterval(spaceIntervalRef.current);
      spaceIntervalRef.current = null;
      spaceHeldRef.current = false;
    }
  }, [options.showSummary]);
};

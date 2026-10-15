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

/**
 * Space or Enter does the next thing: open the pack, flip, next card, next pack. Holding Space runs
 * through the cards. Escape closes a reveal. The listeners are added once and read the latest state from a ref, so a
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
      const target = e.target as HTMLElement | null;
      // Escape belongs to whatever is on top: a sheet closes itself first, and a text field keeps it.
      if (e.key === 'Escape') {
        if (!isOpening || showSummary || !onLeave || e.defaultPrevented || e.repeat) return;
        if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
        e.preventDefault();
        onLeave();
        return;
      }
      const isKey = e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter';
      if (isKey && target?.closest('button, a, input, select, textarea, [contenteditable="true"]')) return;

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

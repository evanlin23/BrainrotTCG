import { useEffect, useRef, MutableRefObject } from 'react';

interface UseKeyboardControlsOptions {
  isOpening: boolean;
  showSummary: boolean;
  disabled: boolean;
  onCloseSummary: () => void;
  onToggleAutoMode: () => void;
  handleInteractionRef: MutableRefObject<() => void>;
}

export const useKeyboardControls = ({
  isOpening,
  showSummary,
  disabled,
  onCloseSummary,
  onToggleAutoMode,
  handleInteractionRef,
}: UseKeyboardControlsOptions) => {
  const spaceHeldRef = useRef(false);
  const spaceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if disabled
      if (disabled) return;

      // Secret key 'a' - toggle auto mode
      if (e.code === 'KeyA' && !e.repeat) {
        e.preventDefault();
        onToggleAutoMode();
        return;
      }

      // Space - for flipping/advancing cards and moving to next pack
      if (e.code === 'Space') {
        e.preventDefault();

        if (showSummary && !e.repeat) {
          // Close summary and move to next pack (only on fresh press)
          onCloseSummary();
        } else if (isOpening && !showSummary && !e.repeat && !spaceHeldRef.current) {
          // Start holding space - begin interval to advance cards
          spaceHeldRef.current = true;
          handleInteractionRef.current(); // Immediate first action
          spaceIntervalRef.current = setInterval(() => {
            handleInteractionRef.current();
          }, 150); // Advance every 150ms while held
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
        if (spaceIntervalRef.current) {
          clearInterval(spaceIntervalRef.current);
          spaceIntervalRef.current = null;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Stop space interval when summary appears
    if (showSummary && spaceIntervalRef.current) {
      clearInterval(spaceIntervalRef.current);
      spaceIntervalRef.current = null;
      spaceHeldRef.current = false;
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (spaceIntervalRef.current) {
        clearInterval(spaceIntervalRef.current);
        spaceIntervalRef.current = null;
      }
    };
  }, [isOpening, showSummary, disabled, onCloseSummary, onToggleAutoMode, handleInteractionRef]);
};

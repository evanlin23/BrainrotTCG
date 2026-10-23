import type { MotionProps } from 'framer-motion';

/** How far below its place the stage starts on a return, and how long it takes to settle there. */
const RISE_PX = 24;
const RISE_SECONDS = 0.18;

/**
 * How the sealed pack's stage comes in. The first arrival on the packs screen in a page load is the full
 * fall from above the screen. Every return (Back from the summary, Next pack, the X, Escape) is a short
 * rise from a little below its place, so the stage never passes over the header or its Settings gear
 * on the way, and with reduced motion it is simply there.
 */
export const stageEntrance = (landed: boolean, reducedMotion: boolean): Pick<MotionProps, 'initial' | 'transition'> => {
  if (!landed) {
    return {
      initial: { y: '-100vh', opacity: 0, rotate: -10 },
      transition: { type: 'spring', stiffness: 80, damping: 12, mass: 1 },
    };
  }
  if (reducedMotion) return { initial: false };
  return {
    initial: { y: RISE_PX, opacity: 0 },
    transition: { duration: RISE_SECONDS, ease: 'easeOut' },
  };
};

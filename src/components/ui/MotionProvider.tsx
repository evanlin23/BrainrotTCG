import type { ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/** Every framer-motion animation follows the Motion setting and the device's reduced-motion setting, live. */
export default function MotionProvider({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();
  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>{children}</MotionConfig>;
}

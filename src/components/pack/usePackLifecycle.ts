import { useCallback, useRef, useState } from 'react';
import { SEALED, transition, type PackEvent, type PackStage, type PackTransition } from './packLifecycle';

/**
 * A pack's stage (see packLifecycle). `send` applies an event to the latest stage, not the last render's,
 * so a second Escape before React renders (or a ticket landing between two renders) sees what the first did.
 * It returns the transition, and the caller does what that stage change needs: record the pack, put the
 * pack back, start the ticket.
 */
export const usePackLifecycle = () => {
  const latest = useRef<PackStage>(SEALED);
  const [stage, setStage] = useState<PackStage>(SEALED);
  const send = useCallback((event: PackEvent): PackTransition => {
    const result = transition(latest.current, event);
    latest.current = result.stage;
    setStage(result.stage);
    return result;
  }, []);
  return [stage, send] as const;
};

import { useState, useSyncExternalStore } from 'react';
import { onSubmissionChange, submissionStatus, submitToHallOfFame } from '../../game/share';

export type SubmitState = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * A pull's Hall of Fame send as one control sees it. Sending and sent are shared by every control on
 * the page (the share sheet and the summary's line), so a pull goes out once however it was sent;
 * failed belongs to the control whose send failed.
 */
export const useHallOfFameSubmit = (proof: string, id: string, score?: number) => {
  const status = useSyncExternalStore(onSubmissionChange, () => (id ? submissionStatus(id) : 'idle'));
  const [failed, setFailed] = useState(false);
  const submit = async () => {
    setFailed(false);
    let sent = false;
    try {
      sent = await submitToHallOfFame(proof, id, score);
    } catch {
      // counts as failed
    }
    setFailed(!sent);
    return sent;
  };
  const state: SubmitState = status === 'idle' && failed ? 'failed' : status;
  return [state, submit] as const;
};

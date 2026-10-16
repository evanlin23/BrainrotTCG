import { useSyncExternalStore } from 'react';
import { Check } from 'lucide-react';
import { pullId } from '../../engine';
import { isHallOfFameWorthy, type HistoryEntry } from '../../game/history';
import { getPlayer } from '../../game/player';
import { onSubmissionChange, submissionStatus } from '../../game/share';

const Status = ({ entry }: { entry: HistoryEntry }) => {
  const id = pullId({ setId: entry.setId, setVersion: entry.setVersion, publicKey: getPlayer().publicKey, nonce: entry.nonce });
  const status = useSyncExternalStore(onSubmissionChange, () => submissionStatus(id));
  return (
    <span className={`pull-row-sent${status === 'sent' ? ' pull-row-sent--done' : ''}`} title={status === 'sent' ? 'Sent from this device' : undefined}>
      {status === 'sent' && <Check aria-hidden="true" />}
      {status === 'sent' ? 'Submitted' : status === 'sending' ? 'Sending…' : 'Not submitted'}
    </span>
  );
};

/**
 * Whether this device has sent a Rankings-worthy pack to the Hall of Fame inbox. Only for this player's own packs
 * (other players on this device sign with other keys), and only on your own profile: it is per device, so it says
 * nothing about other devices or other players' packs; no network. Nothing for a pack that can't qualify.
 */
const SubmittedBadge = ({ entry }: { entry: HistoryEntry }) =>
  isHallOfFameWorthy(entry) && entry.key === getPlayer().publicKeyHex.slice(0, 16) ? <Status entry={entry} /> : null;

export default SubmittedBadge;

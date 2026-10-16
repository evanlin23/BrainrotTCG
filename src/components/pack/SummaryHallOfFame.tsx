import { useEffect, useMemo, useRef, useState } from 'react';
import { dailyRank, decodeProof, pullId, qualifiesForHallOfFame, utcDay, wouldJoinHallOfFame, type PackScore } from '../../engine';
import { loadHallOfFame, type HallOfFameEntry } from '../../game/hallOfFameList';
import { canShare, proofFor, type PullRef } from '../../game/pulls';
import { submitToHallOfFame, wasSubmitted } from '../../game/share';

type SubmitState = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * The results screen's Hall of Fame line: one tap sends a pull that would make the list, the same
 * way the share sheet's Submit does (docs/DESIGN.md, one-screen summary rule). Nothing shows for a
 * pull that wouldn't make it, is listed already, or can't be signed on this device; nor until the
 * list has loaded (if it can't load, anything that qualifies, as in the share sheet).
 */
const SummaryHallOfFame = ({ pack, score }: { pack: PullRef; score: PackScore }) => {
  const qualifies = qualifiesForHallOfFame(score);
  const proof = useMemo(() => (qualifies && canShare(pack) ? proofFor(pack) : ''), [qualifies, pack]);
  const id = useMemo(() => (proof ? pullId(decodeProof(proof)) : ''), [proof]);
  const [list, setList] = useState<HallOfFameEntry[] | null | undefined>(undefined);
  useEffect(() => {
    if (proof) loadHallOfFame().then(setList);
  }, [proof]);
  const [state, setState] = useState<SubmitState>(() => (id && wasSubmitted(id) ? 'sent' : 'idle'));
  const [rank, setRank] = useState<number | null>(null);
  const lineRef = useRef<HTMLParagraphElement>(null);

  if (!proof || list === undefined) return null;
  const pull = { id, setId: pack.setId, score };
  const listed = !!list?.some((e) => e.id === id);
  if (listed || (state === 'idle' && list && !wouldJoinHallOfFame(pull, list, utcDay(new Date().toISOString())))) return null;

  const submit = async () => {
    // The button goes away while it sends: keep keyboard focus on the line.
    lineRef.current?.focus({ preventScroll: true });
    setState('sending');
    let sent = false;
    try {
      sent = await submitToHallOfFame(proof, id, score.score);
    } catch {
      // counts as failed
    }
    if (sent && list) setRank(dailyRank(pull, list, new Date().toISOString()));
    setState(sent ? 'sent' : 'failed');
  };

  const text =
    state === 'sent'
      ? rank
        ? `Submitted · #${rank} today`
        : 'Submitted'
      : state === 'sending'
        ? 'Submitting…'
        : state === 'failed'
          ? "Couldn't submit"
          : "Makes today's Rankings";

  return (
    <p className="summary-hof" ref={lineRef} tabIndex={-1}>
      <span aria-hidden="true">🏆</span>
      <span role="status">{text}</span>
      {(state === 'idle' || state === 'failed') && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="btn btn--secondary btn--sm summary-hof-submit" onClick={submit}>
            {state === 'failed' ? 'Retry' : 'Submit'}
            {state === 'idle' && <span className="sr-only"> to the Hall of Fame</span>}
          </button>
        </>
      )}
    </p>
  );
};

export default SummaryHallOfFame;

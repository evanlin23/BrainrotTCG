import { useEffect, useMemo, useRef, useState } from 'react';
import { allTimeRank, dailyRank, decodeProof, pullId, qualifiesForHallOfFame, utcDay, wouldJoinHallOfFame, type PackScore } from '../../engine';
import { loadHallOfFame, loadPending, type HallOfFameEntry } from '../../game/hallOfFameList';
import { canShare, proofFor, type PullRef } from '../../game/pulls';
import { useHallOfFameSubmit } from '../share/useHallOfFameSubmit';

/**
 * The results screen's Hall of Fame line: one tap sends a pull that would make the list, the same
 * way the share sheet's Submit does, and a send from either shows in both (docs/DESIGN.md, one-screen
 * summary rule). It ranks against what the Rankings page shows: the published list plus the pending
 * sends it re-checks from the relays. Nothing shows for a pull that wouldn't make it, is listed
 * already, or can't be signed on this device (if the list can't load, anything that qualifies, as in
 * the share sheet). A pull that qualifies keeps the line's height from the first paint, whatever it
 * ends up saying, so the cards below never move.
 */
const SummaryHallOfFame = ({ pack, score }: { pack: PullRef; score: PackScore }) => {
  const qualifies = qualifiesForHallOfFame(score);
  const proof = useMemo(() => (qualifies && canShare(pack) ? proofFor(pack) : ''), [qualifies, pack]);
  const id = useMemo(() => (proof ? pullId(decodeProof(proof)) : ''), [proof]);
  const [published, setPublished] = useState<HallOfFameEntry[] | null | undefined>(undefined);
  const [pending, setPending] = useState<HallOfFameEntry[]>([]);
  useEffect(() => {
    if (!proof) return;
    const controller = new AbortController();
    loadHallOfFame().then((list) => {
      if (controller.signal.aborted) return;
      setPublished(list);
      if (list) {
        loadPending(list, (entry) => {
          if (!controller.signal.aborted) setPending((prev) => [...prev, entry]);
        }, controller.signal).catch(() => {});
      }
    });
    return () => controller.abort();
  }, [proof]);
  const list = useMemo(() => (published ? [...published, ...pending] : published), [published, pending]);
  const [state, submit] = useHallOfFameSubmit(proof, id, score.score);
  const pull = useMemo(() => ({ id, setId: pack.setId, score }), [id, pack.setId, score]);
  // Where it places is read as the send goes out (from here or the share sheet), so "#n today" is
  // where it lands among what Rankings shows then. A pull sent on an earlier visit just says Submitted.
  const [placed, setPlaced] = useState<{ daily: number | null; allTime: number | null } | null>(null);
  const [seenUnsent, setSeenUnsent] = useState(false);
  if (proof && state !== 'sent') {
    if (!seenUnsent) setSeenUnsent(true);
    if (placed) setPlaced(null);
  } else if (proof && seenUnsent && list && !placed) {
    const at = new Date().toISOString();
    setPlaced({ daily: dailyRank(pull, list, at), allTime: allTimeRank(pull, list, at) });
  }
  const lineRef = useRef<HTMLParagraphElement>(null);

  if (!proof) return null;
  const now = new Date().toISOString();
  const listed = !!list?.some((e) => e.id === id);
  const hidden = list === undefined || listed || (state === 'idle' && list && !wouldJoinHallOfFame(pull, list, utcDay(now)));
  // Keeps the line's room while the list loads, and after, so a line that won't show doesn't pull the cards up.
  if (hidden) return <p className="summary-hof" aria-hidden="true" />;

  const send = () => {
    // The button goes away while it sends: keep keyboard focus on the line.
    lineRef.current?.focus({ preventScroll: true });
    void submit();
  };
  // Today's top 50 or only the all-time list (if the list can't load, today's board is a guess).
  const today = !list || dailyRank(pull, list, now) !== null;
  const text =
    state === 'sent'
      ? placed?.daily
        ? `Submitted · #${placed.daily} today`
        : placed?.allTime
          ? `Submitted · #${placed.allTime} all-time`
          : 'Submitted'
      : state === 'sending'
        ? 'Submitting…'
        : state === 'failed'
          ? "Couldn't submit"
          : today
            ? "Makes today's Rankings"
            : 'Makes the Hall of Fame';

  return (
    <p className="summary-hof" ref={lineRef} tabIndex={-1}>
      <span aria-hidden="true">🏆</span>
      <span role="status">{text}</span>
      {(state === 'idle' || state === 'failed') && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="btn btn--secondary btn--sm summary-hof-submit" onClick={send}>
            {state === 'failed' ? 'Retry' : 'Submit'}
            {state === 'idle' && <span className="sr-only"> to the Hall of Fame</span>}
          </button>
        </>
      )}
    </p>
  );
};

export default SummaryHallOfFame;

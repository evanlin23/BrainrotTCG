import { useEffect, useMemo, useRef, useState } from 'react';
import { allTimeRank, dailyRank, decodeProof, pullId, qualifiesForHallOfFame, utcDay, wouldJoinHallOfFame, type PackScore } from '../../engine';
import { loadHallOfFame, loadPending, type HallOfFameEntry } from '../../game/hallOfFameList';
import { canShare, proofFor, type PullRef } from '../../game/pulls';
import { useHallOfFameSubmit } from '../share/useHallOfFameSubmit';
import NotQualifyingNote from '../ui/NotQualifyingNote';
import { NOT_BEATING_FLOOR_LEAD } from '../ui/rankingsRule';

/**
 * The results screen's Hall of Fame line: one tap sends a pull that would make the list, the same
 * way the share sheet's Submit does, and a send from either shows in both (docs/DESIGN.md, one-screen
 * summary rule). It ranks against what the Rankings page shows: the published list plus the pending
 * sends it re-checks from the relays. A pull that doesn't qualify says why there is no Submit, in the
 * Rankings page's words (#1004). Once the list has loaded, a pull that qualifies but cannot beat the
 * lowest listed score says so (#1072). Nothing else shows for a pull that is listed already, or can't
 * be signed on this device. If the list can't load, neutral wording offers Submit for anything that
 * qualifies. A pull that qualifies keeps the line's height from the first paint, whatever it ends up
 * saying, so the cards below never move.
 */
const SummaryHallOfFame = ({ pack, score, onOpenRankingsHelp }: { pack: PullRef; score: PackScore; onOpenRankingsHelp?: () => void }) => {
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

  if (!qualifies) {
    return (
      <p className="summary-hof summary-hof--why">
        {/* One flex item, so the sentence stays whole around its link. */}
        <span>
          <NotQualifyingNote onOpenHelp={onOpenRankingsHelp} />
        </span>
      </p>
    );
  }
  if (!proof) return null;
  const now = new Date().toISOString();
  const listed = !!list?.some((e) => e.id === id);

  // Keeps the line's room while the list loads, and after, for a pull that is already listed.
  if (list === undefined || listed) return <p className="summary-hof" aria-hidden="true" />;

  // Once the Rankings list has loaded, if a pull's score can't beat the lowest listed score, say so (#1072).
  // Retains the reserved min-height so the cards below never move.
  if (state === 'idle' && list && !wouldJoinHallOfFame(pull, list, utcDay(now))) {
    return (
      <p className="summary-hof summary-hof--not-listed" ref={lineRef} tabIndex={-1}>
        <span>
          <NotQualifyingNote lead={NOT_BEATING_FLOOR_LEAD} onOpenHelp={onOpenRankingsHelp} />
        </span>
      </p>
    );
  }

  const send = () => {
    // The button goes away while it sends: keep keyboard focus on the line.
    lineRef.current?.focus({ preventScroll: true });
    void submit();
  };
  // If the list couldn't load (offline, relays down), use neutral wording "Qualifies for Rankings".
  // Otherwise check if it makes today's top 50 or only the all-time list.
  const today = list ? dailyRank(pull, list, now) !== null : false;
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
          : !list
            ? 'Qualifies for Rankings'
            : today
              ? "Makes today's Rankings"
              : 'Makes the all-time Rankings';

  return (
    <p className="summary-hof" ref={lineRef} tabIndex={-1}>
      <span aria-hidden="true">🏆</span>
      <span role="status">{text}</span>
      {/* Read before Submit, and kept in every state so the line's height never changes. */}
      <span className="summary-hof-public">Your display name and public key become public.</span>
      {(state === 'idle' || state === 'failed') && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="btn btn--secondary btn--sm summary-hof-submit" onClick={send}>
            {state === 'failed' ? 'Retry' : 'Submit'}
            {state === 'idle' && <span className="sr-only"> to Rankings</span>}
          </button>
        </>
      )}
    </p>
  );
};

export default SummaryHallOfFame;

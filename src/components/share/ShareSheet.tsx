import { useEffect, useMemo, useState } from 'react';
import { Crown, Info, ShieldCheck } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import type { PackScore } from '../../engine';
import { decodeProof, pullId, qualifiesForHallOfFame, utcDay, wouldJoinHallOfFame } from '../../engine';
import { loadHallOfFame, loadPending, type HallOfFameEntry } from '../../game/hallOfFameList';
import { getLatestSet, getSet, setCode } from '../../content/sets';
import { getPlayer } from '../../game/player';
import { canShare, previewFor, proofFor, pullUrl, type PullRef } from '../../game/pulls';
import { bragText } from '../../game/share';
import { useHallOfFameSubmit } from './useHallOfFameSubmit';
import { renderPoster } from '../../game/bragImage';
import Sheet from '../ui/Sheet';
import NotQualifyingNote from '../ui/NotQualifyingNote';
import { NOT_BEATING_FLOOR_LEAD } from '../ui/rankingsRule';
import PackCardViewer from '../ui/PackCardViewer';
import { revealOrder } from '../../game/reveal';
import SharePreviewSheet from './SharePreviewSheet';
import '../../styles/Share.css';

export interface ShareTarget {
  ref: PullRef;
  cards: CardWithMeta[];
  score: PackScore;
}

interface ShareSheetProps {
  target: ShareTarget;
  onClose: () => void;
  /** Go to Rankings' "How Rankings work", from the note on why a pull has no Submit. The sheet closes first. */
  onOpenRankingsHelp?: () => void;
}

/** Share a whole pack: the poster you'll send, then share it or the link. */
const ShareSheet = ({ target, onClose, onOpenRankingsHelp }: ShareSheetProps) => {
  const player = getPlayer();
  const set = getLatestSet(target.ref.setId);
  const setName = set?.name ?? target.ref.setId;
  const shareable = canShare(target.ref);
  const proof = useMemo(() => (shareable ? proofFor(target.ref) : ''), [shareable, target.ref]);
  // The QR code opens the pull directly; the link people paste goes through the best card's
  // preview page, so chat apps show that card.
  const url = proof ? pullUrl(proof) : '';
  const link = proof ? pullUrl(proof, previewFor(target.cards)) : '';
  const id = useMemo(() => (proof ? pullId(decodeProof(proof)) : ''), [proof]);
  // Submit only what would make the list (the top pulls or today's top in UTC); until it loads
  // or if unavailable, anything that qualifies with neutral wording (#1072).
  const qualifies = qualifiesForHallOfFame(target.score);
  const [published, setPublished] = useState<HallOfFameEntry[] | null | undefined>(undefined);
  const [pending, setPending] = useState<HallOfFameEntry[]>([]);
  useEffect(() => {
    if (!qualifies) return;
    const controller = new AbortController();
    loadHallOfFame().then((res) => {
      if (controller.signal.aborted) return;
      setPublished(res);
      if (res) {
        loadPending(res, (entry) => {
          if (!controller.signal.aborted) setPending((prev) => [...prev, entry]);
        }, controller.signal).catch(() => {});
      }
    });
    return () => controller.abort();
  }, [qualifies]);
  const list = useMemo(() => (published ? [...published, ...pending] : published), [published, pending]);
  const listed = !!list?.some((e) => e.id === id);
  const wouldJoin = list ? wouldJoinHallOfFame({ id, setId: target.ref.setId, score: target.score }, list, utcDay(new Date().toISOString())) : null;
  const [submitState] = useHallOfFameSubmit(proof, id, target.score.score);

  if (!shareable) {
    return (
      <Sheet title="Can't share this one" onClose={onClose} size="sm">
        <p className="share-note">
          This pack was opened with a different player key than the one on this device (for example, before you imported a
          save), so this device can't sign a proof for it. Open it on the device that has that key, or import that save again.
        </p>
      </Sheet>
    );
  }

  const handleOpenHelp = onOpenRankingsHelp
    ? () => {
        onClose();
        onOpenRankingsHelp();
      }
    : undefined;

  return (
    <SharePreviewSheet
      title="Share your pull"
      subtitle={
        <>
          {setName} · {target.score.hand.name} · <span className="tabular">{target.score.score.toLocaleString()}</span>
        </>
      }
      makeImage={() =>
        renderPoster({
          cards: target.cards,
          score: target.score,
          setName,
          playerName: player.name,
          fingerprint: player.fingerprint,
          url,
          cert: set ? `${setCode(set)} #${target.ref.nonce}` : `#${target.ref.nonce}`,
          setColor: set?.palette?.[0],
        })
      }
      imageName={`brainrot-pull-${target.ref.setId}-${target.ref.nonce}.png`}
      url={link}
      text={bragText(target.cards, target.score, setName, link)}
      onClose={onClose}
      actions={
        listed ? (
          <p className="share-note">
            <Crown aria-hidden="true" /> This pull is in Rankings.
          </p>
        ) : !qualifies ? (
          <p className="share-note">
            <Info aria-hidden="true" />{' '}
            {/* One flex item, so the sentence stays whole around its link. */}
            <span>
              <NotQualifyingNote onOpenHelp={handleOpenHelp} />
            </span>
          </p>
        ) : submitState === 'idle' && wouldJoin === false ? (
          <p className="share-note">
            <Info aria-hidden="true" />{' '}
            <span>
              <NotQualifyingNote lead={NOT_BEATING_FLOOR_LEAD} onOpenHelp={handleOpenHelp} />
            </span>
          </p>
        ) : (
          <HallOfFameSubmit
            proof={proof}
            id={id}
            score={target.score.score}
            headline={list ? 'This makes Rankings' : 'Qualifies for Rankings'}
          />
        )
      }
    >
      <details className="share-disclosure">
        <summary>Share an individual card</summary>
        <section className="share-pack-cards" aria-label="Cards in this pack">
          <p className="share-note">Choose a card to view or share it. The controls above share the whole pack.</p>
          {/* In the order the pack was revealed, best last, like its summary. */}
          <PackCardViewer
            cards={revealOrder(target.cards)}
            displayMode="grid"
            showValue={false}
            canShareCards
            set={getSet(target.ref.setId, target.ref.setVersion)}
          />
        </section>
      </details>
      <p className="share-note">
        <ShieldCheck aria-hidden="true" /> Anyone who opens the link or scans the code re-checks this exact pack on their own
        device.
      </p>
    </SharePreviewSheet>
  );
};

/** One tap, no account: the pull goes to public relays and a GitHub Action adds it within about 15 minutes. */
const HallOfFameSubmit = ({
  proof,
  id,
  score,
  headline = 'This makes Rankings',
}: {
  proof: string;
  id: string;
  score: number;
  headline?: string;
}) => {
  const [state, submit] = useHallOfFameSubmit(proof, id, score);

  const note =
    state === 'sent'
      ? `It shows in Rankings now, checked on each visitor's device, and is filed for good within the hour.`
      : state === 'failed'
        ? "Couldn't reach any relay. Try again."
        : 'No account needed. It shows in Rankings right away.';

  return (
    <div className="share-hof">
      <Crown aria-hidden="true" />
      <span>
        <strong>{headline}</strong>
        <span role="status">{note}</span>
        <span className="share-hof-public">Your display name and public key become public.</span>
      </span>
      <button type="button" className="btn btn--secondary btn--sm" onClick={submit} disabled={state === 'sending' || state === 'sent'}>
        {state === 'sending' ? 'Sending…' : state === 'sent' ? 'Submitted' : 'Submit'}
      </button>
    </div>
  );
};

export default ShareSheet;

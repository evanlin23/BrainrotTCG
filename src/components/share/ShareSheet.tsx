import { useEffect, useMemo, useState } from 'react';
import { Crown, ShieldCheck } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import type { PackScore } from '../../engine';
import { decodeProof, pullId, qualifiesForHallOfFame, wouldJoinHallOfFame } from '../../engine';
import { loadHallOfFame, type HallOfFameEntry } from '../../game/hallOfFameList';
import { getLatestSet, setCode } from '../../content/sets';
import { getPlayer } from '../../game/player';
import { canShare, previewFor, proofFor, pullUrl, type PullRef } from '../../game/pulls';
import { bragText, hallOfFameSubmitUrl, submitToHallOfFame, wasSubmitted } from '../../game/share';
import { renderPoster } from '../../game/bragImage';
import Sheet from '../ui/Sheet';
import PackCardViewer from '../ui/PackCardViewer';
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
}

/** Share a whole pack: the poster you'll send, then share it or the link. */
const ShareSheet = ({ target, onClose }: ShareSheetProps) => {
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
  // Submit only what would make the list (the top pulls, or a first); until it loads, anything that qualifies.
  const [list, setList] = useState<HallOfFameEntry[] | null>(null);
  useEffect(() => {
    if (qualifiesForHallOfFame(target.score)) loadHallOfFame().then(setList);
  }, [target.score]);
  const listed = !!list?.some((e) => e.id === id);
  const joins = qualifiesForHallOfFame(target.score) && (!list || wouldJoinHallOfFame({ id, setId: target.ref.setId, score: target.score }, list));

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
            <Crown aria-hidden="true" /> This pull is in the Hall of Fame.
          </p>
        ) : (
          joins && <HallOfFameSubmit proof={proof} id={id} githubUrl={hallOfFameSubmitUrl(url, `${target.score.hand.name} in ${setName}`)} />
        )
      }
    >
      <section className="share-pack-cards" aria-label="Cards in this pack">
        <h3 className="section-title">Cards in this pack</h3>
        <p className="share-note">Choose a card to view or share it. The controls above share the whole pack.</p>
        <PackCardViewer cards={target.cards} displayMode="grid" showValue={false} canShareCards />
      </section>
      <p className="share-note">
        <ShieldCheck aria-hidden="true" /> Anyone who opens the link or scans the code re-checks this exact pack on their own
        device.
      </p>
    </SharePreviewSheet>
  );
};

type SubmitState = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * One tap, no account: the pull goes to public relays and a GitHub Action adds it within about 15
 * minutes. The GitHub issue form stays as a fallback.
 */
const HallOfFameSubmit = ({ proof, id, githubUrl }: { proof: string; id: string; githubUrl: string }) => {
  const [state, setState] = useState<SubmitState>(() => (wasSubmitted(id) ? 'sent' : 'idle'));
  const [detail, setDetail] = useState('');

  const submit = async () => {
    setState('sending');
    try {
      const { accepted, total } = await submitToHallOfFame(proof, id);
      setState(accepted > 0 ? 'sent' : 'failed');
      setDetail(accepted > 0 ? `Sent to ${accepted} of ${total} relays.` : '');
    } catch {
      setState('failed');
    }
  };

  const note =
    state === 'sent'
      ? `${detail ? `${detail} ` : ''}It shows in the Hall of Fame now, checked on each visitor's device, and is filed for good within the hour.`
      : state === 'failed'
        ? "Couldn't reach any relay. Try again, or submit on GitHub."
        : 'No account needed. It shows in the Hall of Fame right away.';

  return (
    <div className="share-hof">
      <Crown aria-hidden="true" />
      <span>
        <strong>This makes the Hall of Fame</strong>
        <span role="status">{note}</span>
        <a href={githubUrl} target="_blank" rel="noreferrer">
          Or submit on GitHub instead
        </a>
      </span>
      <button type="button" className="btn btn--secondary btn--sm" onClick={submit} disabled={state === 'sending' || state === 'sent'}>
        {state === 'sending' ? 'Sending…' : state === 'sent' ? 'Submitted' : 'Submit'}
      </button>
    </div>
  );
};

export default ShareSheet;

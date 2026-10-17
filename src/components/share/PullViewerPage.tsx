import { useEffect, useState } from 'react';
import { Link2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { checkPull, previewFor, pullUrl, type CheckedPull } from '../../game/pulls';
import { publicName } from '../../engine';
import { setCode } from '../../content/sets';
import PackCardViewer from '../ui/PackCardViewer';
import Sheet from '../ui/Sheet';
import '../../styles/Share.css';

interface PullViewerPageProps {
  proof: string;
  onClose: () => void;
}

type State = { status: 'checking' } | { status: 'ok'; pull: CheckedPull } | { status: 'error'; reason: string };

/** Opened from a shared `#/pull/<proof>` link. Everything is verified right here, on the viewer's device. */
const PullViewerPage = ({ proof, onClose }: PullViewerPageProps) => {
  const [state, setState] = useState<State>({ status: 'checking' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const stop = new AbortController();
    checkPull(proof, stop.signal)
      .then((pull) => !cancelled && setState({ status: 'ok', pull }))
      .catch((error: unknown) => !cancelled && setState({ status: 'error', reason: error instanceof Error ? error.message : String(error) }));
    return () => {
      cancelled = true;
      stop.abort();
    };
  }, [proof]);

  const copyLink = async () => {
    // Once the pack is checked, the link previews as its best card.
    const link = pullUrl(proof, state.status === 'ok' ? previewFor(state.pull.cardsWithMeta) : undefined);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this:', link);
    }
  };

  const openOwn = (
    <button type="button" className="btn btn--primary btn--block" onClick={onClose}>
      Open your own packs
    </button>
  );

  if (state.status === 'checking') {
    return (
      <Sheet title="Checking this pull" onClose={onClose} size="sm">
        <div className="pull-viewer-checking" role="status">
          <span className="pull-viewer-spinner" aria-hidden="true" />
          <p>Re-opening the pack on your device…</p>
        </div>
      </Sheet>
    );
  }

  if (state.status === 'error') {
    return (
      <Sheet title="Not a valid pull" onClose={onClose} size="sm" footer={openOwn}>
        <p className="pull-viewer-badge is-invalid">
          <span>
            <ShieldAlert aria-hidden="true" /> {state.reason}
          </span>
        </p>
        <p className="share-note">The link was edited, cut off or made up. Real pulls always check out.</p>
      </Sheet>
    );
  }

  const { pull } = state;
  const hand = pull.score.hand.name !== 'No Matches' ? pull.score.hand.name : 'A pull';
  return (
    <Sheet
      title={hand}
      subtitle={
        <>
          {pull.set.name} · {publicName(pull.proof.name)} <span className="share-fp">#{pull.fingerprint}</span>
        </>
      }
      onClose={onClose}
      size="md"
      className="pull-viewer"
      footer={
        <div className="pull-viewer-actions">
          <button type="button" className="btn btn--secondary" onClick={copyLink}>
            <Link2 aria-hidden="true" /> {copied ? 'Copied' : 'Copy link'}
          </button>
          {openOwn}
        </div>
      }
    >
      <p className="pull-viewer-badge">
        <span>
          <ShieldCheck aria-hidden="true" /> Verified on this device
        </span>
        <span className="pull-viewer-cert">
          Cert {pull.fingerprint} · {setCode(pull.set)} #{pull.proof.nonce}
        </span>
      </p>
      <PackCardViewer cards={pull.cardsWithMeta} displayMode="carousel" />
      <details className="pull-viewer-how">
        <summary>How do we know?</summary>
        <p>
          Your device just re-derived ticket #{pull.proof.nonce} of this player's key and opened it in {pull.set.name} v
          {pull.set.version}. It came out exactly as shown, and the player's signature matches. Each ticket costs real work to
          mine, so a pull can't be edited or picked from a pile of fakes.
        </p>
      </details>
    </Sheet>
  );
};

export default PullViewerPage;

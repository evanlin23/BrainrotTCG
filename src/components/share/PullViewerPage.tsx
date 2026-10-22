import { useEffect, useState } from 'react';
import { Link2, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { checkPull, previewFor, pullUrl, UnknownCardError, type CheckedPull } from '../../game/pulls';
import { isMemoryError, OUT_OF_MEMORY_ADVICE } from '../../game/ticketPool';
import { ProofError, publicName } from '../../engine';
import { setCode } from '../../content/sets';
import PackCardViewer from '../ui/PackCardViewer';
import Sheet from '../ui/Sheet';
import '../../styles/Profile.css';
import '../../styles/Share.css';

interface PullViewerPageProps {
  proof: string;
  onClose: () => void;
}

type State =
  | { status: 'checking' }
  | { status: 'ok'; pull: CheckedPull }
  | { status: 'invalid'; reason: string }
  | { status: 'unknown_set'; reason: string }
  | { status: 'operational'; headline: string; message: string };

/** Opened from a shared `#/pull/<proof>` link. Everything is verified right here, on the viewer's device. */
const PullViewerPage = ({ proof, onClose }: PullViewerPageProps) => {
  const [activeProof, setActiveProof] = useState(proof);
  const [state, setState] = useState<State>({ status: 'checking' });
  const [copied, setCopied] = useState(false);
  /** Bumped by "Try again" after running out of memory or experiencing an operational error. */
  const [attempt, setAttempt] = useState(0);

  // When proof changes across route transitions in the same mounted sheet,
  // immediately reset to checking state so stale verification/cards/previews cannot leak.
  if (proof !== activeProof) {
    setActiveProof(proof);
    setState({ status: 'checking' });
    setCopied(false);
  }

  useEffect(() => {
    let cancelled = false;
    const stop = new AbortController();
    checkPull(proof, stop.signal)
      .then((pull) => !cancelled && setState({ status: 'ok', pull }))
      .catch((error: unknown) => {
        if (cancelled || stop.signal.aborted) return;
        if (error instanceof ProofError) {
          if (error.rule === 'set') {
            setState({ status: 'unknown_set', reason: error.message });
          } else {
            setState({ status: 'invalid', reason: error.message });
          }
        } else if (error instanceof UnknownCardError) {
          // The same on every device, so offering a retry would be wrong.
          setState({ status: 'invalid', reason: error.message });
        } else if (isMemoryError(error)) {
          console.error('Pull verification failed', error);
          setState({
            status: 'operational',
            headline: "Couldn't finish re-opening the pack on this device",
            message: OUT_OF_MEMORY_ADVICE,
          });
        } else {
          console.error('Pull verification failed', error);
          setState({
            status: 'operational',
            headline: "Couldn't verify on this device",
            message: 'Something went wrong while re-opening the pack. Try again.',
          });
        }
      });
    return () => {
      cancelled = true;
      stop.abort();
    };
  }, [proof, attempt]);

  const copyLink = async () => {
    // Once the pack is checked, the link previews as its best card.
    // Ensure the preview is derived only from the successfully verified current proof.
    const preview = state.status === 'ok' ? previewFor(state.pull.cardsWithMeta) : undefined;
    const link = pullUrl(proof, preview);
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

  if (state.status === 'operational') {
    return (
      <Sheet title="Couldn't check this pull" onClose={onClose} size="sm" footer={openOwn}>
        <div className="profile-verify is-failed" role="status">
          <span className="profile-verify-line">
            <ShieldAlert aria-hidden="true" /> {state.headline}
          </span>
          <span className="profile-verify-sub">{state.message}</span>
          <button
            type="button"
            className="btn btn--secondary btn--sm profile-verify-retry"
            onClick={() => {
              setState({ status: 'checking' });
              setAttempt((n) => n + 1);
            }}
          >
            <RotateCcw aria-hidden="true" /> Try again
          </button>
        </div>
      </Sheet>
    );
  }

  if (state.status === 'unknown_set') {
    return (
      <Sheet title="Couldn't check this pull" onClose={onClose} size="sm" footer={openOwn}>
        <p className="pull-viewer-badge is-invalid">
          <span>
            <ShieldAlert aria-hidden="true" /> {state.reason}
          </span>
        </p>
        <p className="share-note">
          This pull is from a set or version this app doesn't recognize. Make sure you are using the latest version of the game.
        </p>
      </Sheet>
    );
  }

  if (state.status === 'invalid') {
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

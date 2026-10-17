import { useEffect, useMemo, useState } from 'react';
import { Link2, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { levelForXp, profileStats, publicName } from '../../engine';
import { profileUrl, verifyProfileLive, type ProfileProgress } from '../../game/profiles';
import ProfileSummary from './ProfileSummary';
import Sheet from '../ui/Sheet';
import '../../styles/Share.css';
import '../../styles/Profile.css';

interface ProfileViewerPageProps {
  proof: string;
  onClose: () => void;
}

type State = { status: 'invalid'; reason: string } | ({ status: 'checking' } & ProfileProgress);

/**
 * Opened from a shared `#/profile/<proof>` link. The signature is checked at once, so the claimed
 * level shows right away; the best packs are re-opened first (about a second), then the rest, and
 * once every pack is in, the claims must match or the profile is marked fake.
 */
const ProfileViewerPage = ({ proof, onClose }: ProfileViewerPageProps) => {
  const [state, setState] = useState<State | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    try {
      verifyProfileLive(
        proof,
        (p) => {
          if (!controller.signal.aborted) setState({ status: 'checking', ...p });
        },
        controller.signal,
      );
    } catch (error) {
      // Synchronous on purpose: a bad link is rejected before any packs are opened.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ status: 'invalid', reason: error instanceof Error ? error.message : String(error) });
    }
    return () => controller.abort();
  }, [proof]);

  // Until every pack is in: the claimed level, the (already re-opened) best packs, and the rest so far.
  const stats = useMemo(() => {
    if (state?.status !== 'checking') return null;
    const sofar = profileStats(state.packs);
    if (state.done || state.error) return sofar;
    const { xp } = state.checked.profile;
    return { ...sofar, xp, level: levelForXp(xp), packs: state.checked.tickets.length, best: state.highlights ?? [] };
  }, [state]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(profileUrl(proof));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this:', profileUrl(proof));
    }
  };

  const openOwn = (
    <button type="button" className="btn btn--primary btn--block" onClick={onClose}>
      Open your own packs
    </button>
  );

  if (!state) return null;

  if (state.status === 'invalid') {
    return (
      <Sheet title="Not a valid profile" onClose={onClose} size="sm" footer={openOwn}>
        <p className="pull-viewer-badge is-invalid">
          <span>
            <ShieldAlert aria-hidden="true" /> {state.reason}
          </span>
        </p>
        <p className="share-note">The link was edited, cut off or made up. Real profiles always check out.</p>
      </Sheet>
    );
  }

  const { checked, packs, done, error, highlights } = state;
  const fake = error?.rule === 'claims';
  const total = checked.tickets.length;
  const name = publicName(checked.profile.name);
  return (
    <Sheet
      title={name}
      subtitle={
        <>
          <span className="share-fp">#{checked.fingerprint}</span> · {total.toLocaleString()} pack{total === 1 ? '' : 's'}
        </>
      }
      onClose={onClose}
      size="lg"
      className="profile-viewer"
      footer={
        <div className="pull-viewer-actions">
          <button type="button" className="btn btn--secondary" onClick={copyLink}>
            <Link2 aria-hidden="true" /> {copied ? 'Copied' : 'Copy link'}
          </button>
          {openOwn}
        </div>
      }
    >
      <div className={`profile-verify ${done ? 'is-done' : ''} ${error ? 'is-failed' : ''}`} role="status">
        <span className="profile-verify-line">
          {fake ? (
            <>
              <ShieldAlert aria-hidden="true" /> Not a real profile: {error.message}
            </>
          ) : error ? (
            <>
              <ShieldAlert aria-hidden="true" /> Couldn't finish re-opening the packs on this device
            </>
          ) : done ? (
            <>
              <ShieldCheck aria-hidden="true" /> Verified: {total === 1 ? 'its pack was' : `all ${total.toLocaleString()} packs`} re-opened on this device
            </>
          ) : (
            <>
              <Loader2 aria-hidden="true" className="spin" /> Re-opening packs on this device…{' '}
              <span className="tabular">
                {packs.length.toLocaleString()}/{total.toLocaleString()}
              </span>
            </>
          )}
        </span>
        {!done && !error && (
          <>
            <span className="progress" aria-hidden="true">
              <span style={{ width: `${(packs.length / total) * 100}%` }} />
            </span>
            {highlights && <span className="profile-verify-sub">Best pulls checked. Level is as claimed until every pack is in.</span>}
          </>
        )}
      </div>

      {stats && !fake && <ProfileSummary stats={stats} levelNote={done ? undefined : 'claimed'} partial={!done && !error} />}

      <details className="profile-how">
        <summary>How do we know?</summary>
        <p>
          The link lists which set every one of this player's tickets went to, from their very first (#0) to #{total - 1}, with no
          gaps, signed with their key. Your device re-opened each of those packs itself: the level, cards and best pulls above
          are what those tickets actually hold, so they can't be edited, and bad packs can't be left out.
        </p>
        <p>
          What a link can't show is packs opened after it was made, so a profile is a snapshot. Each ticket costs real work to
          mine, so a high level means a lot of packs.
        </p>
      </details>
    </Sheet>
  );
};

export default ProfileViewerPage;

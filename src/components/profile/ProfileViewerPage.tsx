import { useEffect, useMemo, useState } from 'react';
import { Link2, Loader2, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { levelForXp, profileStats, visitorName } from '../../engine';
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
 * once every pack is in, the claims must match or the profile is marked fake. Copy only claims what
 * has been checked: "Verified" appears only when every pack is in, an interrupted check shows just
 * the re-opened packs as partial totals, and a failed claim gets no success explanation.
 */
const ProfileViewer = ({ proof, onClose }: ProfileViewerPageProps) => {
  const [state, setState] = useState<State | null>(null);
  const [copied, setCopied] = useState(false);
  /** Bumped by "Try again": packs already re-opened are cached, so a retry picks up where it stopped. */
  const [attempt, setAttempt] = useState(0);

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
  }, [proof, attempt]);

  // Until every pack is in: the claimed level, the (already re-opened) best packs, and the rest so far.
  const stats = useMemo(() => {
    if (state?.status !== 'checking') return null;
    const sofar = profileStats(state.packs);
    // Verified, or stopped early: only what was actually re-opened. Never the claimed level.
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
  const reopened = packs.length;
  const interrupted = !!error && !fake;
  // A late error can arrive after every pack is in; then "only N/N" would read wrongly.
  const unfinished = reopened < total;
  const counts = (
    <span className="tabular">
      {reopened.toLocaleString()}/{total.toLocaleString()}
    </span>
  );
  const name = visitorName(checked.profile.name);
  return (
    <Sheet
      title={name}
      subtitle={<span className="share-fp">#{checked.fingerprint}</span>}
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
              <ShieldAlert aria-hidden="true" />
              <span>
                {unfinished ? <>Check interrupted: only {counts} packs re-opened in your browser</> : 'Check interrupted before it finished'}
              </span>
            </>
          ) : done ? (
            <>
              <ShieldCheck aria-hidden="true" /> This profile checks out: every pack re-opened in your browser
            </>
          ) : (
            <>
              <Loader2 aria-hidden="true" className="spin" />
              <span>
                Checking: packs re-opened in your browser {counts}
              </span>
            </>
          )}
        </span>
        {!done && !error && (
          <>
            <span className="progress" aria-hidden="true">
              <span style={{ width: `${(packs.length / total) * 100}%` }} />
            </span>
            <span className="profile-verify-sub">
              {highlights
                ? 'Best pulls re-opened. The level is only what the link claims until every pack is in.'
                : 'Not verified yet. The level is only what the link claims until every pack is in.'}
            </span>
          </>
        )}
        {error && !fake && (
          <>
            <span className="profile-verify-sub">{error.message}</span>
            <button
              type="button"
              className="btn btn--secondary btn--sm profile-verify-retry"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RotateCcw aria-hidden="true" /> Try again
            </button>
          </>
        )}
      </div>

      {stats && !fake && (
        <ProfileSummary
          stats={stats}
          levelNote={done ? undefined : interrupted ? 'from re-opened packs only' : 'claimed'}
          partial={!done}
          partialNote={
            interrupted
              ? unfinished
                ? `* from the ${reopened.toLocaleString()} of ${total.toLocaleString()} packs re-opened before the check stopped`
                : '* from the packs re-opened before the check stopped'
              : undefined
          }
        />
      )}

      <details className="profile-how">
        <summary>How do we know?</summary>
        <p>
          The link lists which set every one of this player's tickets went to, from their very first (#0) to #{total - 1}, with no
          gaps, signed with their key. That signature is checked as soon as the link opens.
        </p>
        <p>
          {fake
            ? "The packs re-opened on this device don't match what the link claims, so this isn't a real profile and nothing about it counts as verified."
            : done
              ? "Your device re-opened each of those packs itself, and the claims match: the level, cards and best pulls above are what those tickets actually hold, so they can't be edited, and bad packs can't be left out."
              : interrupted
                ? unfinished
                  ? `The check stopped after ${reopened.toLocaleString()} of ${total.toLocaleString()} packs. The totals above come only from those packs, and the rest are unchecked, so the profile is not verified. Try again to carry on from where it stopped.`
                  : 'The check stopped before it finished, so the profile is not verified. Try again to run it once more.'
                : `Your device is re-opening those packs now (${reopened.toLocaleString()} of ${total.toLocaleString()} so far). Until every pack is in, the level is only what the link claims and nothing here counts as verified.`}
        </p>
        <p>
          What a link can't show is packs opened after it was made, so a profile is a snapshot. Each ticket costs real work to
          mine, so a high level means a lot of packs.
        </p>
      </details>
    </Sheet>
  );
};

/**
 * Everything the viewer holds (the check so far, an open best pull, the copied note, the retry count)
 * belongs to one profile, so a different link starts it afresh: profile A's pack can't stay open over
 * profile B, and A's check, stopped by the remount, can't leave its numbers behind. Progress for the
 * same link keeps the selection.
 */
const ProfileViewerPage = (props: ProfileViewerPageProps) => <ProfileViewer key={props.proof} {...props} />;

export default ProfileViewerPage;

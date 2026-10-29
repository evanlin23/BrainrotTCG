import { useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Loader2, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { levelForXp, profileStats, visitorName } from '../../engine';
import { profileUrl } from '../../game/profiles';
import { verifyProfileLive, type ProfileProgress } from '../../game/profileVerification';
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
 * level shows right away; only the best packs (the highlights) are re-opened by default (about a
 * second), then the check pauses. "Verify all N packs" re-opens the rest, and once every pack is in,
 * the claims must match or the profile is marked fake. Copy only claims what has been checked: the
 * paused state says the totals come from the best packs only and the rest are unchecked, "This
 * profile checks out" appears only when every pack is in, an interrupted check shows just the
 * re-opened packs as partial totals, and a failed claim gets no success explanation. The best packs'
 * own "Verified" badge is true of each pack and stays once they are re-opened.
 */
const ProfileViewer = ({ proof, onClose }: ProfileViewerPageProps) => {
  const [state, setState] = useState<State | null>(null);
  const [copied, setCopied] = useState(false);
  /** False: re-open the highlights and pause. True: the viewer asked for every pack. */
  const [full, setFull] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
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
        { highlightsOnly: !full },
      );
    } catch (error) {
      // Synchronous on purpose: a bad link is rejected before any packs are opened.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ status: 'invalid', reason: error instanceof Error ? error.message : String(error) });
    }
    return () => controller.abort();
  }, [proof, attempt, full]);

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
  const highlightsDone = state.highlightsDone ?? false;
  /** The best packs are re-opened and the check has stopped there, waiting to be asked for the rest. */
  const paused = highlightsDone && !full && !done && !error;
  const bestCount = highlights?.length ?? 0;
  const bestPacks = `${bestCount.toLocaleString()} best ${bestCount === 1 ? 'pack' : 'packs'}`;
  const verifyAll = () => {
    // The button unmounts with this click, which would drop focus to the page: land on the status line instead.
    statusRef.current?.focus();
    setFull(true);
  };
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
      <div
        ref={statusRef}
        tabIndex={-1}
        className={`profile-verify ${done ? 'is-done' : ''} ${error ? 'is-failed' : ''}`}
        role="status"
      >
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
          ) : paused ? (
            <>
              <ShieldCheck aria-hidden="true" />
              <span>Best pulls re-opened in your browser</span>
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
        {paused && (
          <>
            <span className="profile-verify-sub">
              Only the best packs are re-opened. The rest are not checked, so the level is only what the link claims.
            </span>
            <button type="button" className="btn btn--secondary btn--sm profile-verify-full" onClick={verifyAll}>
              Verify all {total.toLocaleString()} packs
            </button>
            <span className="profile-verify-sub">Checking every pack can take a while on a big profile.</span>
          </>
        )}
        {!done && !error && !paused && (
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
            paused
              ? `* the pack count is the link's own; cards, holo and best score are from the ${bestPacks} only, and the rest of the packs are not checked`
              : interrupted
                ? unfinished
                  ? `* from the ${reopened.toLocaleString()} of ${total.toLocaleString()} packs re-opened before the check stopped`
                  : '* from the packs re-opened before the check stopped'
                : undefined
          }
          packBadge={
            // Each best pack was re-opened from its own ticket, so its badge holds while the rest are still going.
            done || highlightsDone || (highlights && !error)
              ? () => (
                  <span className="profile-verified" title="Opened again from its ticket: these exact cards and score">
                    <span className="sr-only">, </span>
                    <ShieldCheck aria-hidden="true" />
                    Verified
                  </span>
                )
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
            ? "The packs your device re-opened don't match what the link claims, so this isn't a real profile and nothing about it counts as verified."
            : paused
              ? `Your device re-opened the ${bestPacks} itself, and they come out in the order the link lists. The rest of the packs are not checked until you ask, so the level and pack count are only what the link claims, the cards, holo and best score above come from those best packs only, and the profile as a whole is not verified.`
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

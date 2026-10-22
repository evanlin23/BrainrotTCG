import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { IdCard, Link2 } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import PackCardViewer from '../ui/PackCardViewer';
import type { PageSection } from '../ui/Page';
import Tabs from '../ui/Tabs';
import { tabPanelProps } from '../ui/tabPanel';
import BestCardsSection from './BestCardsSection';
import ProfileSummary from './ProfileSummary';
import PackCacheNote from './PackCacheNote';
import PlayerSection from './PlayerSection';
import PullRow from './PullRow';
import RewardsSection from './RewardsSection';
import SubmittedBadge from './SubmittedBadge';
import AchievementsSection from '../achievements/AchievementsSection';
import SharePreviewSheet from '../share/SharePreviewSheet';
import { renderPlayerCard } from '../../game/playerCard';
import { getLatestSet } from '../../content/sets';
import { byBest, getHistory, historyCards, isHallOfFameWorthy, type HistoryEntry } from '../../game/history';
import { HALL_OF_FAME_MIN_SCORE, type ProfilePack } from '../../engine';
import { STORAGE_KEYS } from '../../constants';
import { getPlayer } from '../../game/player';
import { myProfileInfo, myProfileProof, myStats, onReopenProgress, profileUrl, reopenMyPacks, reopenStatus } from '../../game/profiles';
import { copyText } from '../../game/shareActions';
import type { PullRef } from '../../game/pulls';
import type { AchievementData, Settings } from '../../types';
import { usePackCacheVersion } from '../../hooks/usePackCache';
import '../../styles/Pulls.css';

interface LegacyBest {
  highestPackCards?: CardWithMeta[];
  highestPackLegacy?: boolean;
}

interface ProfilePageProps {
  stats: LegacyBest;
  /** Null while saved packs are still being read (or couldn't be). */
  level: number | null;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  unlockedAchievements: Record<string, AchievementData | number>;
  achievementProgress?: Record<string, [have: number, need: number, unit: string]>;
  onSharePull: (entry: HistoryEntry, cards: CardWithMeta[]) => void;
  /** Share the pack that unlocked an achievement. */
  onShareAchievementPull?: (ref: PullRef, cards: CardWithMeta[]) => void;
  /** Go to Settings, Save & backup. */
  onOpenSave: () => void;
  /** Go to the packs screen. */
  onOpenPacks: () => void;
  /** Whether this tab may still write its save (false once another tab switched or replaced it). */
  canSave: () => boolean;
  /** A name couldn't be stored as the page was left. */
  onSaveFailed: () => void;
  /** The section a link or toast asked for: Achievements or rewards open when asked for. */
  section?: PageSection;
}

/** Archive rows shown at first (so Best cards below stays within reach), and added by each Show more. */
const FIRST_PAGE = 5;
const PAGE = 30;

/** How the pack list is shown: best first (the default), newest first, or only the ones that qualify for Rankings. */
type PackView = 'newest' | 'best' | 'hof';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const timeAgo = (t: number) => {
  const minutes = Math.round((t - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/**
 * The Profile page (#/profile): your name, your level and stats with a link that proves them,
 * achievements, the card backs and foils your level unlocked, and every pack you've opened (best first).
 */
const ProfilePage = ({
  stats,
  level,
  settings,
  onSettingsChange,
  unlockedAchievements,
  achievementProgress,
  onSharePull,
  onShareAchievementPull,
  onOpenSave,
  onOpenPacks,
  canSave,
  onSaveFailed,
  section,
}: ProfilePageProps) => {
  const [player, setPlayer] = useState(getPlayer);
  // Saved packs are read in pages (game/profiles.ts): recount, and show their cards, as they arrive.
  const packCache = usePackCacheVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => getHistory(), [packCache]);
  // Re-opening runs in the background (game/profiles.ts); recount when a run ends.
  const [reopen, setReopen] = useState(reopenStatus);
  const [reopenRuns, setReopenRuns] = useState(0);
  useEffect(
    () =>
      onReopenProgress((status) => {
        setReopen(status);
        if (!status.running) setReopenRuns((n) => n + 1);
      }),
    [],
  );
  // Another tab recording a pack can complete (or change) what a profile link can prove: recount.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEYS.HISTORY) setReopenRuns((n) => n + 1);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const summary = useMemo(() => myStats(), [reopenRuns, packCache]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mine = useMemo(() => myProfileInfo(), [reopenRuns, packCache]);
  // Until saved packs are read, a pack not in memory yet isn't one this device lacks.
  const unopened = mine?.cache === 'ready' ? mine.missing - mine.filled : 0;
  const [shown, setShown] = useState(FIRST_PAGE);
  const listRef = useRef<HTMLUListElement>(null);
  const historyTitleRef = useRef<HTMLHeadingElement>(null);
  /** How many rows were showing when Show more was pressed: the rows after them are the new ones. */
  const focusFrom = useRef<number | null>(null);
  // After Show more, the pressed button may be gone (the last page), so focus would fall to the page: move it
  // to the first new row you can open (a pack whose cards aren't saved here is a disabled row), else the heading.
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null) return;
    focusFrom.current = null;
    const fresh = [...(listRef.current?.querySelectorAll<HTMLButtonElement>(':scope > li > .pull-row') ?? [])].slice(from);
    (fresh.find((b) => !b.disabled) ?? historyTitleRef.current)?.focus({ preventScroll: true });
  }, [shown]);
  const [view, setView] = useState<PackView>('best');
  const tabsId = useId();
  const best = useMemo(() => [...history].sort(byBest), [history]);
  const worthy = useMemo(() => best.filter(isHallOfFameWorthy), [best]);
  const listed = view === 'hof' ? worthy : view === 'best' ? best : history;
  const changeView = (next: PackView) => {
    setView(next);
    setShown(FIRST_PAGE);
  };
  const [copied, setCopied] = useState(false);
  const [preparing, setPreparing] = useState<string | null>(null);
  /** Why the last profile link couldn't be made (e.g. another tab changed the save meanwhile). */
  const [linkError, setLinkError] = useState<string | null>(null);
  /** A link that took a while to prepare; the tap that started it may no longer be allowed to copy. */
  const [readyUrl, setReadyUrl] = useState<string | null>(null);

  const send = async (url: string) => {
    if (await copyText(url)) {
      setReadyUrl(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  /** The profile link. Usually instant; tickets this device has no cards for are re-opened once, first. */
  const makeLink = async (): Promise<{ url: string; slow: boolean } | null> => {
    const slow = !!mine?.missing;
    setPreparing(slow ? 'Preparing…' : null);
    setLinkError(null);
    let proof: string | null;
    try {
      proof = await myProfileProof((done, total) => setPreparing(`Preparing ${done}/${total}…`));
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setPreparing(null);
      // What the link could prove may have changed while it was prepared.
      setReopenRuns((n) => n + 1);
    }
    return proof ? { url: profileUrl(proof), slow } : null;
  };

  const share = async () => {
    if (readyUrl) return send(readyUrl);
    const link = await makeLink();
    if (!link) return;
    if (link.slow) setReadyUrl(link.url);
    else await send(link.url);
  };

  /** The profile card: an image with the profile link's QR code, then copy the image or the link. */
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const shareCard = async () => {
    const link = readyUrl ? { url: readyUrl } : await makeLink();
    if (link) setCardUrl(link.url);
  };

  /** The history record of one of the profile's best packs (the profile lists only the current key's). */
  const entryOf = (pack: ProfilePack) =>
    history.find(
      (e) =>
        e.nonce === pack.nonce &&
        e.setId === pack.set.id &&
        e.setVersion === pack.set.version &&
        player.publicKeyHex.startsWith(e.key),
    );

  const openEntry = (entry: HistoryEntry | undefined) => {
    const cards = entry && historyCards(entry);
    if (entry && cards) onSharePull(entry, cards);
  };

  return (
    <>
      <div className="profile-page pulls-page">
        <PlayerSection onRenamed={setPlayer} canSave={canSave} onSaveFailed={onSaveFailed} />

        <h2 className="sr-only">Level and stats</h2>
        {mine && !summary ? (
          <PackCacheNote
            what="your level and stats"
            onFailed={
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void reopenMyPacks().catch(() => undefined)}>
                Re-open the packs instead
              </button>
            }
          />
        ) : mine && summary ? (
          <ProfileSummary
            stats={summary}
            onOpenPack={(pack) => openEntry(entryOf(pack))}
            packBadge={(pack) => {
              const entry = entryOf(pack);
              return entry && <SubmittedBadge entry={entry} />;
            }}
            actions={
              <>
                <button type="button" className="btn btn--secondary btn--sm" onClick={share} disabled={!!preparing || !!mine?.filled}>
                  <Link2 aria-hidden="true" />
                  {preparing ?? (copied ? 'Link copied' : readyUrl ? 'Copy link now' : 'Copy profile link')}
                </button>
                <button type="button" className="btn btn--secondary btn--sm" onClick={shareCard} disabled={!!preparing || !!mine?.filled}>
                  <IdCard aria-hidden="true" /> Profile card
                </button>
              </>
            }
          />
        ) : (
          <div className="pulls-empty">
            <p>No packs yet. Your level, stats and best pulls show up here.</p>
            <button type="button" className="btn btn--primary" onClick={onOpenPacks}>
              Open your first pack
            </button>
          </div>
        )}


        {linkError && (
          <p className="pulls-note" role="alert">
            Couldn't make your profile link: {linkError} If a pack is still opening in this or another tab, try again once it
            finishes.
          </p>
        )}

        {mine && mine.filled > 0 && (
          <p className="pulls-note">
            Original set/version records are missing or unavailable for {mine.filled.toLocaleString()} pack{mine.filled === 1 ? '' : 's'}.
            These local totals are partial. A complete profile link or card cannot be created from this save. Keep a private export
            (open Settings, then Save & backup); if you have an older complete backup, it may contain the missing records.
          </p>
        )}

        {reopen?.running ? (
          <p className="pulls-note" role="status">
            Re-opening your packs in the background: {reopen.done.toLocaleString()} of {reopen.total.toLocaleString()}. You can leave
            this page and keep playing; if you close the tab, it carries on next time.
          </p>
        ) : (
          unopened > 0 && (
            <p className="pulls-note">
              {unopened.toLocaleString()} pack{unopened === 1 ? " in your history doesn't" : "s in your history don't"} have
              {unopened === 1 ? ' its' : ' their'} cards on this device, so the numbers above leave {unopened === 1 ? 'it' : 'them'} out
              for now.{reopen?.error ? " Re-opening stopped with an error." : ''}{' '}
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void reopenMyPacks().catch(() => undefined)}>
                {reopen?.error ? 'Try again' : 'Re-open them'}
              </button>
            </p>
          )
        )}

        <AchievementsSection
          unlockedAchievements={unlockedAchievements}
          progress={achievementProgress}
          onSharePull={onShareAchievementPull}
          openRequest={section?.id === 'achievements' ? section.n : undefined}
        />

        <RewardsSection
          level={level}
          settings={settings}
          onSettingsChange={onSettingsChange}
          openRequest={section?.id === 'rewards' ? section.n : undefined}
        />

        {stats.highestPackLegacy && stats.highestPackCards?.length ? (
          <section className="pulls-legacy">
            <h2 className="section-title pulls-history-title">Best before verifiable pulls</h2>
            <PackCardViewer cards={stats.highestPackCards} displayMode="grid" canShareCards />
          </section>
        ) : null}

        {history.length > 0 && (
          <section aria-labelledby="pulls-history-title" className="pulls-history">
            <h2 id="pulls-history-title" ref={historyTitleRef} tabIndex={-1} className="section-title pulls-history-title">
              All packs · {history.length.toLocaleString()}
            </h2>
            <Tabs
              idBase={tabsId}
              label="Sort packs"
              value={view}
              onChange={changeView}
              tabs={[
                { id: 'best', label: 'Best' },
                { id: 'newest', label: 'Newest' },
                { id: 'hof', label: <>For Rankings · {worthy.length.toLocaleString()}</> },
              ]}
            />
            <div className="pulls-panel" {...tabPanelProps(tabsId, view)}>
              {view === 'hof' && (
                <p className="pulls-note">
                  {worthy.length
                    ? 'These qualify for Rankings, the public Hall of Fame. Open one to share it or submit it.'
                    : `None yet: a Full House or better, or a Brainrot Score of ${HALL_OF_FAME_MIN_SCORE.toLocaleString()}+, qualifies for Rankings.`}
                </p>
              )}
              <ul ref={listRef} className="pulls-list">
                {listed.slice(0, shown).map((entry) => (
                  <PullRow
                    key={`${entry.key}-${entry.nonce}-${entry.setId}@${entry.setVersion}-${entry.openedAt}`}
                    cards={historyCards(entry)}
                    set={getLatestSet(entry.setId)}
                    setId={entry.setId}
                    hand={entry.hand}
                    score={entry.score}
                    meta={timeAgo(entry.openedAt)}
                    worthy={isHallOfFameWorthy(entry)}
                    badge={<SubmittedBadge entry={entry} />}
                    onClick={() => openEntry(entry)}
                  />
                ))}
              </ul>
              {shown < listed.length && (
                <button
                  type="button"
                  className="btn btn--ghost btn--block"
                  onClick={() => {
                    focusFrom.current = shown;
                    setShown(shown + PAGE);
                  }}
                >
                  Show more<span className="sr-only"> packs</span> · {(listed.length - shown).toLocaleString()} remaining
                </button>
              )}
            </div>
          </section>
        )}

        {mine && <BestCardsSection refreshKey={`${packCache}:${reopenRuns}`} cacheReady={mine.cache === 'ready'} />}

        <p className="profile-save-note">
          <span>Saved in this browser ·</span>
          <button type="button" className="link-btn" onClick={onOpenSave}>Back up</button>
        </p>
      </div>
      {cardUrl && summary && (
        <SharePreviewSheet
          title="Your profile card"
          subtitle="Level, title, sets and best pull, with a QR code that re-checks every pack."
          makeImage={() => renderPlayerCard(summary, player, cardUrl)}
          imageName="brainrot-profile-card.png"
          url={cardUrl}
          text={`${player.name}'s Brainrot TCG profile card\n${cardUrl}`}
          onClose={() => setCardUrl(null)}
        />
      )}
    </>
  );
};

export default ProfilePage;

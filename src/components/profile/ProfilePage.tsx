import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { IdCard, Link2 } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import PackCardViewer from '../ui/PackCardViewer';
import type { PageSection } from '../ui/Page';
import Tabs from '../ui/Tabs';
import { tabPanelProps } from '../ui/tabPanel';
import BestCardsSection from './BestCardsSection';
import BestHighlights from './BestHighlights';
import ProfileSummary from './ProfileSummary';
import ProfileSection from './ProfileSection';
import PackCacheNote from './PackCacheNote';
import PlayerSection from './PlayerSection';
import PullRow from './PullRow';
import RecordBook from './RecordBook';
import RewardsSection from './RewardsSection';
import SubmittedBadge from './SubmittedBadge';
import AchievementsSection from '../achievements/AchievementsSection';
import SharePreviewSheet from '../share/SharePreviewSheet';
import { renderPlayerCard } from '../../game/playerCard';
import { getLatestSet } from '../../content/sets';
import { byBest, getHistory, historyCards, isHallOfFameWorthy, type HistoryEntry } from '../../game/history';
import { computeDroughtCounters } from '../../game/droughtCounters';
import { packMedals, recordBook } from '../../game/personalRecords';
import { QUALIFY_RULE } from '../ui/rankingsRule';
import type { BestPackStats } from '../../game/bestSources';
import { STORAGE_KEYS } from '../../constants';
import { getPlayer } from '../../game/player';
import { myProfileInfo, myProfileProof, myStats, profileUrl } from '../../game/profiles';
import { onReopenProgress, reopenMyPacks, reopenStatus } from '../../game/reopenJob';
import { copyText } from '../../game/shareActions';
import type { PullRef } from '../../game/pulls';
import type { AchievementData, Settings } from '../../types';
import { usePackCacheVersion } from '../../hooks/usePackCache';
import '../../styles/Pulls.css';

interface ProfilePageProps {
  /** The best pack kept when it opened (and a legacy one from before ticket references). */
  stats: BestPackStats;
  /** Null while saved packs are still being read (or couldn't be). */
  level: number | null;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  unlockedAchievements: Record<string, AchievementData | number>;
  achievementProgress?: Record<string, [have: number, need: number, unit: string]>;
  onSharePull: (entry: HistoryEntry, cards: CardWithMeta[]) => void;
  /** Share the verified Best pack, by its reference and the engine's cards. */
  onSharePack: (ref: PullRef, cards: CardWithMeta[]) => void;
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
  onSharePack,
  onShareAchievementPull,
  onOpenSave,
  onOpenPacks,
  canSave,
  onSaveFailed,
  section,
}: ProfilePageProps) => {
  const [player, setPlayer] = useState(getPlayer);
  // Saved packs are read in pages (game/packCache.ts): recount, and show their cards, as they arrive.
  const packCache = usePackCacheVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => getHistory(), [packCache]);
  // Re-opening runs in the background (game/reopenJob.ts); recount when a run ends.
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
  // Best cards weighed or rebuilt (BestCardsSection): the Best card highlight may have changed.
  const [bestCardsRuns, setBestCardsRuns] = useState(0);
  // Saved packs are being read or their best cards are still being weighed: the Best card highlight holds its place.
  const [bestCardsSettled, setBestCardsSettled] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const summary = useMemo(() => myStats(), [reopenRuns, packCache]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mine = useMemo(() => myProfileInfo(), [reopenRuns, packCache]);
  // It reads each pack's saved cards, which a finished re-open run (or another tab) fills in without
  // changing the history entries, so it recounts on the same signals as the summary above.
  const droughtStats = useMemo(
    () => computeDroughtCounters(history, { playerKeyHex: player.publicKeyHex }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, player.publicKeyHex, reopenRuns, packCache],
  );
  // Personal records and the medals packs keep, from this player's own packs; recounted on the same
  // signals, since holos and droughts read saved cards as they arrive.
  const records = useMemo(
    () => recordBook(history, player.publicKeyHex),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, player.publicKeyHex, reopenRuns, packCache],
  );
  const medals = useMemo(() => packMedals(history, player.publicKeyHex), [history, player.publicKeyHex]);
  // Until saved packs are read, a pack not in memory yet isn't one this device lacks.
  const unopened = mine?.cache === 'ready' ? mine.missing - mine.filled : 0;
  // A best card is on its way only while a read is: the saved packs loading, or their Best cards being weighed
  // (BestCardsSection, which settles). A failed read, or no saved packs at all, has none coming: show what is resolved.
  const bestCardExpected = !!mine && (mine.cache === 'loading' || (mine.cache === 'ready' && !bestCardsSettled));
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

  /** The history record of the Best pack, for its submitted badge (only the current key's). */
  const entryOf = (ref: PullRef) =>
    history.find(
      (e) =>
        e.nonce === ref.nonce &&
        e.setId === ref.setId &&
        e.setVersion === ref.setVersion &&
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

        <ProfileSection title="Best pack and card">
          <BestHighlights
            stats={stats}
            refreshKey={`${packCache}:${reopenRuns}:${bestCardsRuns}`}
            expecting={bestCardExpected}
            onSharePack={onSharePack}
            packBadge={(ref) => {
              const entry = entryOf(ref);
              return entry && <SubmittedBadge entry={entry} />;
            }}
          />
        </ProfileSection>

        <ProfileSection title="Level, stats and collection">
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
              highlighted
              droughtStats={droughtStats}
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
              <p>No packs yet. Your level, stats, best pack and best card show up here.</p>
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
        </ProfileSection>

        {history.length > 0 && <RecordBook book={records} cardsPending={mine?.cache === 'loading'} />}

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
          <ProfileSection className="pulls-legacy" title="Best before verifiable pulls">
            <PackCardViewer cards={stats.highestPackCards} displayMode="grid" canShareCards />
          </ProfileSection>
        ) : null}

        {history.length > 0 && (
          <ProfileSection title={`All packs · ${history.length.toLocaleString()}`} titleId="pulls-history-title" titleRef={historyTitleRef} className="pulls-history">
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
                    : `None yet: ${QUALIFY_RULE}, qualifies for Rankings.`}
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
                    medal={medals.get(entry)}
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
          </ProfileSection>
        )}

        {mine && (
          <BestCardsSection
            refreshKey={`${packCache}:${reopenRuns}`}
            cacheReady={mine.cache === 'ready'}
            onListChange={() => setBestCardsRuns((n) => n + 1)}
            onSettledChange={setBestCardsSettled}
          />
        )}

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

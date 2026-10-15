import { useEffect, useId, useMemo, useState } from 'react';
import { ChevronRight, IdCard, Link2, Trophy } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import CardImage from '../cards/CardImage';
import PackCardViewer from '../ui/PackCardViewer';
import Sheet from '../ui/Sheet';
import Tabs from '../ui/Tabs';
import { tabPanelProps } from '../ui/tabPanel';
import ProfileSummary from './ProfileSummary';
import RewardsPanel from './RewardsPanel';
import SharePreviewSheet from '../share/SharePreviewSheet';
import { modifierClasses } from '../../game/modifiers';
import { renderPlayerCard } from '../../game/playerCard';
import type { Settings } from '../../types';
import { packImageUrl } from '../../content/art';
import { DEFAULT_SET_ID, getLatestSet, setCode } from '../../content/sets';
import { byBest, getHistory, historyCards, isHallOfFameWorthy, type HistoryEntry } from '../../game/history';
import { HALL_OF_FAME_MIN_SCORE } from '../../engine';
import { getPlayer } from '../../game/player';
import { myProfileInfo, myProfileProof, myStats, onReopenProgress, profileUrl, reopenMyPacks, reopenStatus } from '../../game/profiles';
import { copyText } from '../../game/shareActions';
import '../../styles/Pulls.css';

interface LegacyBest {
  highestPackCards?: CardWithMeta[];
  highestPackLegacy?: boolean;
}

interface MyProfilePageProps {
  stats: LegacyBest;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  onClose: () => void;
  onSharePull: (entry: HistoryEntry, cards: CardWithMeta[]) => void;
}

const PAGE = 30;

/** How the pack list is shown: newest first, best first, or only the ones good enough for the Hall of Fame. */
type PackView = 'newest' | 'best' | 'hof';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const timeAgo = (t: number) => {
  const minutes = Math.round((t - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Your level and stats, a link that proves them, and every pack you've opened (newest first). */
const MyProfilePage = ({ stats, settings, onSettingsChange, onClose, onSharePull }: MyProfilePageProps) => {
  const player = getPlayer();
  const history = useMemo(() => getHistory(), []);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const summary = useMemo(() => myStats(), [reopenRuns]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mine = useMemo(() => myProfileInfo(), [reopenRuns]);
  const unopened = mine ? mine.missing - mine.filled : 0;
  const [shown, setShown] = useState(PAGE);
  const [view, setView] = useState<PackView>('newest');
  const tabsId = useId();
  const best = useMemo(() => [...history].sort(byBest), [history]);
  const worthy = useMemo(() => best.filter(isHallOfFameWorthy), [best]);
  const listed = view === 'hof' ? worthy : view === 'best' ? best : history;
  const changeView = (next: PackView) => {
    setView(next);
    setShown(PAGE);
  };
  const [copied, setCopied] = useState(false);
  const [preparing, setPreparing] = useState<string | null>(null);
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
    let proof: string | null;
    try {
      proof = await myProfileProof((done, total) => setPreparing(`Preparing ${done}/${total}…`));
    } finally {
      setPreparing(null);
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

  /** The player card: an image with the profile link's QR code, then copy the image or the link. */
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const shareCard = async () => {
    const link = readyUrl ? { url: readyUrl } : await makeLink();
    if (link) setCardUrl(link.url);
  };

  const openEntry = (entry: HistoryEntry | undefined) => {
    const cards = entry && historyCards(entry);
    if (entry && cards) onSharePull(entry, cards);
  };

  return (
    <>
      <Sheet
        title="Profile"
        subtitle={
          <>
            {player.name} <span className="share-fp">#{player.fingerprint}</span>
          </>
        }
        onClose={onClose}
        size="lg"
        className="pulls-page"
      >
        {mine ? (
          <ProfileSummary
            stats={summary}
            onOpenPack={(pack) => openEntry(history.find((e) => e.nonce === pack.nonce && player.publicKeyHex.startsWith(e.key)))}
            actions={
              <>
                <button type="button" className="btn btn--secondary btn--sm" onClick={share} disabled={!!preparing}>
                  <Link2 aria-hidden="true" />
                  {preparing ?? (copied ? 'Link copied' : readyUrl ? 'Copy link now' : 'Copy profile link')}
                </button>
                <button type="button" className="btn btn--secondary btn--sm" onClick={shareCard} disabled={!!preparing}>
                  <IdCard aria-hidden="true" /> Player card
                </button>
              </>
            }
          />
        ) : (
          <div className="pulls-empty">
            <p>No packs yet. Your level, stats and best pulls show up here.</p>
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Open your first pack
            </button>
          </div>
        )}

        {mine && (
          <div className="pulls-rewards">
            <RewardsPanel level={summary.level} settings={settings} onSettingsChange={onSettingsChange} packImage={packImageUrl(DEFAULT_SET_ID)} />
          </div>
        )}

        {mine && mine.filled > 0 && (
          <p className="pulls-note">
            {mine.filled.toLocaleString()} early pack{mine.filled === 1 ? " wasn't" : "s weren't"} recorded on this device. A profile
            can't skip tickets, so yours counts {mine.filled === 1 ? 'it' : 'them'} as whatever those tickets hold.
          </p>
        )}

        {reopen?.running ? (
          <p className="pulls-note" role="status">
            Re-opening your packs in the background: {reopen.done.toLocaleString()} of {reopen.total.toLocaleString()}. You can close
            this and keep playing; if you close the tab, it carries on next time.
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

        {stats.highestPackLegacy && stats.highestPackCards?.length ? (
          <section className="pulls-legacy">
            <h3 className="section-title pulls-history-title">Best before verifiable pulls</h3>
            <PackCardViewer cards={stats.highestPackCards} displayMode="grid" canShareCards />
          </section>
        ) : null}

        {history.length > 0 && (
          <section aria-labelledby="pulls-history-title" className="pulls-history">
            <h3 id="pulls-history-title" className="section-title pulls-history-title">
              All packs · {history.length.toLocaleString()}
            </h3>
            <Tabs
              idBase={tabsId}
              label="Sort packs"
              value={view}
              onChange={changeView}
              tabs={[
                { id: 'newest', label: 'Newest' },
                { id: 'best', label: 'Best' },
                { id: 'hof', label: <>Hall of Fame · {worthy.length.toLocaleString()}</> },
              ]}
            />
            <div className="pulls-panel" {...tabPanelProps(tabsId, view)}>
              {view === 'hof' && (
                <p className="pulls-note">
                  {worthy.length
                    ? 'Good enough for the Hall of Fame. Open one to share it or submit it.'
                    : `None yet: a Full House or better, or a Brainrot Score of ${HALL_OF_FAME_MIN_SCORE.toLocaleString()}+, gets in.`}
                </p>
              )}
              <ul className="pulls-list">
                {listed.slice(0, shown).map((entry) => {
                  const cards = historyCards(entry);
                  const set = getLatestSet(entry.setId);
                  const [a = '#ff3df2', b = '#29f0ff'] = set?.palette ?? [];
                  return (
                    <li key={`${entry.key}-${entry.nonce}`}>
                      <button
                        type="button"
                        className="pull-row"
                        style={{ '--set-a': a, '--set-b': b } as React.CSSProperties}
                        onClick={() => openEntry(entry)}
                        disabled={!cards}
                      >
                        <span className="pull-row-thumbs" aria-hidden="true">
                          {cards
                            ? cards.map((c, i) => <CardImage key={i} src={c.image} finish={c.finish} alt="" loading="lazy" className={`${c.isHolo ? 'holo' : ''} ${modifierClasses(c)}`} />)
                            : Array.from({ length: 5 }, (_, i) => <span key={i} className="pull-row-blank" />)}
                        </span>
                        <span className="pull-row-main">
                          <span className="pull-row-hand">
                            {entry.hand}
                            {isHallOfFameWorthy(entry) && (
                              <>
                                <Trophy className="pull-row-hof" aria-hidden="true" />
                                <span className="sr-only">, good enough for the Hall of Fame</span>
                              </>
                            )}
                          </span>
                          <span className="pull-row-meta">
                            {set && <span className="set-code">{setCode(set)}</span>}
                            <span className="pull-row-setname">{set?.name ?? entry.setId} · </span>
                            {timeAgo(entry.openedAt)}
                          </span>
                        </span>
                        <span className="pull-row-score tabular">{entry.score.toLocaleString()}</span>
                        {cards && <ChevronRight className="pull-row-chevron" aria-hidden="true" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {shown < listed.length && (
                <button type="button" className="btn btn--ghost btn--block" onClick={() => setShown((n) => n + PAGE)}>
                  Show more
                </button>
              )}
            </div>
          </section>
        )}
      </Sheet>
      {cardUrl && (
        <SharePreviewSheet
          title="Your player card"
          subtitle="Level, title, sets and best pull, with a QR code that re-checks every pack."
          makeImage={() => renderPlayerCard(summary, player, cardUrl)}
          imageName="brainrot-player-card.png"
          url={cardUrl}
          text={`${player.name}'s Brainrot TCG player card\n${cardUrl}`}
          onClose={() => setCardUrl(null)}
        />
      )}
    </>
  );
};

export default MyProfilePage;

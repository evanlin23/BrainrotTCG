import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Crown, History, ShieldCheck } from 'lucide-react';
import CardImage from '../cards/CardImage';
import Sheet from '../ui/Sheet';
import Tabs from '../ui/Tabs';
import { tabPanelProps } from '../ui/tabPanel';
import { QUALIFY_HAND, QUALIFY_RULE, QUALIFY_SCORE, RANKINGS_HELP } from '../ui/rankingsRule';
import '../../styles/HallOfFame.css';
import { getCard } from '../../data/cards';
import { modifierClasses } from '../../game/modifiers';
import { loadHallOfFame, loadPending, type HallOfFameEntry } from '../../game/hallOfFameList';
import { dailyPulls, HALL_OF_FAME_TOP, previousUtcDay, topPulls, utcDay, visitorName } from '../../engine';

// Hackathon legends ("Where it started"): screenshots from before pulls were verifiable.
import adiImage from '../../assets/images/hall_of_fame/adi-four-of-a-kind.webp';
import danielImage from '../../assets/images/hall_of_fame/daniel-full-house.webp';
import squidImage from '../../assets/images/hall_of_fame/tehsquid-full-house.webp';

interface LegendEntry {
  name: string;
  description: string;
  image: string;
  date: string;
  portrait?: boolean;
}

const HACKATHON_LEGENDS: LegendEntry[] = [
  { name: 'Adi/frail_banana', description: '4 of a Kind', image: adiImage, date: 'March 1st, 2026' },
  { name: 'Daniel/dandandoo', description: 'Full House', image: danielImage, date: 'March 1st, 2026' },
  { name: 'TehSquid', description: 'Full House', image: squidImage, date: 'March 4th, 2026', portrait: true },
];

/** How many leaderboard rows show at first, and how many more each "Show more" adds. */
const PAGE_SIZE = 20;
/** How many of yesterday's best show when nothing has been filed today. */
const YESTERDAY_SHOWN = 3;
/**
 * How long the page waits on the live relays before it stops saying it is checking. Re-deriving recent
 * submissions queues behind pack-opening tickets and can take far longer; the check itself carries on,
 * and whatever it finds still joins the lists.
 */
const CHECK_DEADLINE_MS = 15_000;

/** Today's UTC day (YYYY-MM-DD), moving on at 00:00 UTC while the page is open. */
const useUtcToday = () => {
  const [day, setDay] = useState(() => utcDay(new Date().toISOString()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const now = new Date();
      const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      // A timer that fires a moment early finds the same day and simply waits again.
      timer = setTimeout(() => {
        setDay(utcDay(new Date().toISOString()));
        arm();
      }, midnight - now.getTime());
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return day;
};

/** When the day after `day` starts (00:00 UTC), in the player's own clock. */
const localResetTime = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Today ranks the current UTC day's pulls; All-time ranks the best ever. */
type RankingsTab = 'today' | 'all';

/** The Rankings page (#/rankings). */
const HallOfFamePage = () => {
  const [entries, setEntries] = useState<HallOfFameEntry[] | null>(null);
  const [tab, setTab] = useState<RankingsTab>('today');
  const [legendsOpen, setLegendsOpen] = useState(false);
  const tabsId = useId();
  const day = useUtcToday();

  const [pending, setPending] = useState<HallOfFameEntry[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  // True once a check of the live relays found every one unreachable: the published rankings still
  // show, but anything sent since the last deploy can't be seen, so an empty board mustn't claim it's empty.
  const [relaysDown, setRelaysDown] = useState(false);
  // True from the moment the published rankings arrive until the live relays have answered (or failed
  // to), or CHECK_DEADLINE_MS has passed. The published pulls show meanwhile, but an empty board can't
  // say it's empty, or the status that the rankings loaded, before it knows which: the status says it
  // is checking until then.
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadingRef = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    loadingRef.current = true;
    loadHallOfFame().then((list) => {
      if (controller.signal.aborted) return;
      if (list === null) {
        loadingRef.current = false;
        setLoadState('failed');
        return;
      }
      setEntries(list);
      setPending([]);
      setRelaysDown(false);
      setChecking(true);
      setLoadState('loaded');
      // Then anything sent since the last deploy, re-derived here before it shows (see loadPending).
      // The published pulls show meanwhile; the empty-board copy and the "loaded" announcement wait
      // for the answer. A check that fails outright (its code couldn't load) is as good as no relay.
      // Past the deadline the page stops waiting, but the check isn't abandoned: entries it still finds
      // are added, and if it ends with no relay reached, the live-feed message appears then.
      deadline = setTimeout(() => setChecking(false), CHECK_DEADLINE_MS);
      const settle = (reached: boolean) => {
        if (controller.signal.aborted) return;
        clearTimeout(deadline);
        loadingRef.current = false;
        if (!reached) setRelaysDown(true);
        setChecking(false);
      };
      loadPending(list, (entry) => {
        if (!controller.signal.aborted) setPending((prev) => [...prev, entry]);
      }, controller.signal).then((reached) => settle(reached !== false), () => settle(false));
    });
    return () => {
      controller.abort();
      clearTimeout(deadline);
    };
  }, [attempt]);
  const retry = () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadState('loading');
    setAttempt((prev) => prev + 1);
  };
  // The status announces every outcome. A failure or a finished retry also moves focus to it, but
  // only when focus has nowhere better to be: on the Retry button (disabled or now gone), lost to the
  // page, or still on the page's heading as it opened. Focus the person put elsewhere stays there.
  const statusRef = useRef<HTMLParagraphElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (loadState !== 'failed' && !(loadState === 'loaded' && !checking && attempt > 0)) return;
    const status = statusRef.current;
    const active = document.activeElement;
    const opened = status?.closest('.page')?.querySelector('.page-title');
    if (status && (!active || active === document.body || active === retryRef.current || active === opened)) {
      status.focus({ preventScroll: true });
    }
  }, [loadState, checking, attempt]);
  const all = useMemo(() => (entries ? [...entries, ...pending] : null), [entries, pending]);

  // The same rules the deploy used to pick these entries (src/engine/hallOfFame.ts): one entry per
  // pull, the earliest verification keeping the credit. A pull can be signed more than once, so they
  // key on the pull id (set, key and ticket number) rather than the proof text. Published entries
  // aren't re-derived here: the deploy already did, from the same site as this code. Each row links
  // to its pull, which re-derives it when opened.
  const ranked = useMemo(() => topPulls(all ?? []), [all]);
  // Today: pulls filed on the current UTC day (the same day for everyone), plus any just submitted.
  const today = useMemo(() => dailyPulls(all ?? [], day), [all, day]);
  const yesterday = useMemo(() => dailyPulls(all ?? [], previousUtcDay(day)).slice(0, YESTERDAY_SHOWN), [all, day]);
  // The leaderboard shows a page at a time so the page stays short on a phone. Only what's drawn
  // changes: the order is the same whatever is shown.
  const [shown, setShown] = useState(PAGE_SIZE);
  const listRef = useRef<HTMLOListElement>(null);
  const focusRowRef = useRef<number | null>(null);
  useEffect(() => {
    // After "Show more", focus moves to the first new row, so a keyboard or screen reader user
    // carries on from where the list grew instead of from the button below it.
    const row = focusRowRef.current;
    if (row === null) return;
    focusRowRef.current = null;
    listRef.current?.querySelectorAll<HTMLElement>('.hof-entry')[row]?.focus();
  }, [shown]);
  const showMore = () => {
    focusRowRef.current = shown;
    setShown(shown + PAGE_SIZE);
  };
  const changeTab = (next: RankingsTab) => {
    setTab(next);
    setShown(PAGE_SIZE);
  };

  const renderEntry = (entry: HallOfFameEntry, rank: number) => {
    const who = visitorName(entry.name);
    return (
      <li key={entry.id}>
        <a className="hof-entry" href={`#/pull/${entry.proof}`} aria-label={`Number ${rank + 1}: ${entry.hand} by ${who} in ${entry.setName}, score ${entry.score}`}>
          <span className="hof-rank tabular">{rank + 1}</span>
          <span className="hof-cards" aria-hidden="true">
            {entry.cards.map((c, i) => {
              const card = getCard(`${entry.setId}/${c.cardId}`);
              return card ? <CardImage key={i} src={card.image} finish={c.finish} alt="" className={`${card.rarity.toLowerCase()} ${c.isHolo ? 'holo' : ''} ${modifierClasses(c)}`} /> : null;
            })}
          </span>
          <span className="hof-main">
            <span className="hof-hand">{entry.hand}</span>
            <span className="hof-who">
              {who} <span className="share-fp">#{entry.fingerprint}</span>
            </span>
            <span className="hof-meta">
              {entry.mine && <span className="hof-pending">Just submitted · </span>}
              {entry.setName}
            </span>
          </span>
          <span className="hof-side">
            <span className="hof-score tabular">{entry.score.toLocaleString()}</span>
          </span>
        </a>
      </li>
    );
  };

  const rankedList = (list: HallOfFameEntry[]) => (
    <>
      <ol ref={listRef} className="hof-list">{list.slice(0, shown).map((e, i) => renderEntry(e, i))}</ol>
      {shown < list.length && (
        <button type="button" className="btn btn--secondary btn--block hof-more" onClick={showMore}>
          Show more
        </button>
      )}
    </>
  );

  const guidance = (
    <>
      Pull {QUALIFY_HAND} (or {QUALIFY_SCORE}), share it, and submit it from the share sheet.
    </>
  );

  // Loaded and not reporting a problem: the published list shows, and the status steps back to one line.
  const quiet = loadState === 'loaded' && !relaysDown;

  return (
    <div className="hall-of-fame">
      <p className="page-subtitle">Shared pulls, verified and ranked by Brainrot Score</p>
      <Tabs
        idBase={tabsId}
        label="Rankings lists"
        value={tab}
        onChange={changeTab}
        tabs={[
          { id: 'today', label: 'Today' },
          { id: 'all', label: 'All-time' },
        ]}
      />

      {/* With the rankings showing, the status is one quiet line that keeps its room whether it says
          "Checking…" or is only spoken, so the rows don't move when it comes and goes. */}
      <div className={quiet ? 'hof-load-state hof-load-state--quiet' : 'hof-load-state'}>
        <p role="status" tabIndex={-1} ref={statusRef} className={quiet && !checking ? 'sr-only' : undefined}>
          {loadState === 'loading'
            ? 'Loading rankings…'
            : loadState === 'failed'
              ? "Couldn't load the rankings. Try again."
              : checking
                ? 'Checking for new packs…'
                : relaysDown
                  ? "Couldn't reach the live feed, so pulls sent recently may be missing. Try again."
                  : 'Rankings loaded.'}
        </p>
        {/* Retry appears only once a load has actually failed: beside "Loading…" it read as a hang. */}
        {(loadState === 'failed' || (loadState === 'loaded' && relaysDown)) && (
          <button ref={retryRef} type="button" className="btn btn--secondary btn--sm" onClick={retry} aria-label="Retry loading rankings">
            Retry
          </button>
        )}
      </div>

      <details className="hof-how">
        <summary>{RANKINGS_HELP}</summary>
        <div className="hof-how-body">
          <p>
            Players share pulls here, ranked by Brainrot Score. Today ranks pulls filed since 00:00 UTC; All-time ranks the best{' '}
            {HALL_OF_FAME_TOP} pulls. Each was re-derived from its proof when filed, and newer ones on this device (open one to check
            it yourself). Other screens call this the Hall of Fame.
          </p>
          <p>
            <strong>Who qualifies:</strong> {QUALIFY_RULE}.
          </p>
          <p>
            <strong>Nothing is filed automatically.</strong> Opening a pack, or copying or sharing a link, does not enter you. A
            qualifying pull offers Submit on its results screen or Share sheet, and submitting makes your display name and public
            key public. Submit is missing if the pull does not qualify, is already listed, was opened under another key or would not beat the lowest score on the lists.
          </p>
          <p>
            Submitting is not a rank. A submitted pull shows here once checked and, if it makes the list, is usually filed
            within about an hour. If the list could not load, or was out of date when you submitted, a pull that does not beat the lowest
            score is turned away.
          </p>
        </div>
      </details>

      <div className="hof-panel" {...tabPanelProps(tabsId, tab)}>
        {tab === 'today' && loadState === 'loaded' && (
          <>
            <p className="hof-note">
              <ShieldCheck aria-hidden="true" />
              <span>
                Today&apos;s best pulls. Resets at 00:00 UTC ({localResetTime(day)} your time).
              </span>
            </p>
            {today.length > 0 ? (
              rankedList(today)
            ) : checking ? null : (
              <>
                <div className="hof-empty">
                  <Crown aria-hidden="true" />
                  <p>
                    {relaysDown ? (
                      <strong>No filed pulls today that we can see.</strong>
                    ) : (
                      <>
                        <strong>No pulls filed today yet.</strong> {guidance} Yours could be first.
                      </>
                    )}
                  </p>
                </div>
                {yesterday.length > 0 && (
                  <section className="hof-yesterday" aria-labelledby={`${tabsId}-yesterday`}>
                    <h2 id={`${tabsId}-yesterday`} className="section-title">
                      Yesterday&apos;s best
                    </h2>
                    <ol className="hof-list">{yesterday.map((e, i) => renderEntry(e, i))}</ol>
                  </section>
                )}
              </>
            )}
          </>
        )}

        {tab === 'all' && loadState === 'loaded' && (
          <>
            {ranked.length > 0 ? (
              <>
                <p className="hof-note">
                  <ShieldCheck aria-hidden="true" />
                  <span>
                    The top {HALL_OF_FAME_TOP} by Brainrot Score.
                  </span>
                </p>
                {rankedList(ranked)}
              </>
            ) : checking ? null : (
              <div className="hof-empty">
                <Crown aria-hidden="true" />
                <p>
                  {relaysDown ? (
                    <strong>Nothing filed here that we can see.</strong>
                  ) : (
                    <>
                      <strong>Nothing filed here yet.</strong> {guidance} You could be first.
                    </>
                  )}
                </p>
              </div>
            )}
          </>
        )}
        {/* Nothing to list yet: skeleton rows keep the page looking busy rather than empty or broken. They sit after the Today
           note so the note doesn't jump when rows arrive. */}
        {(loadState === 'loading' || (loadState === 'loaded' && checking && (tab === 'today' ? today : ranked).length === 0)) && (
          <ol className="hof-skeleton" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="hof-skeleton-row">
                <span className="hof-skeleton-bar hof-skeleton-bar--rank" />
                <span className="hof-skeleton-bar hof-skeleton-bar--cards" />
                <span className="hof-skeleton-lines">
                  <span className="hof-skeleton-bar" />
                  <span className="hof-skeleton-bar hof-skeleton-bar--short" />
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Where it started: the hackathon's screenshots, kept apart from the verified rankings. */}
      <div className="hof-origins">
        <button type="button" className="btn btn--ghost btn--sm" aria-haspopup="dialog" onClick={() => setLegendsOpen(true)}>
          <History aria-hidden="true" /> Where it started
        </button>
      </div>
      {legendsOpen && (
        <Sheet title="Where it started" subtitle="Screenshots from the hackathon, before pulls could be verified, so they aren't ranked." onClose={() => setLegendsOpen(false)} className="hof-legends-sheet">
          <ul className="hof-legends">
            {HACKATHON_LEGENDS.map((entry) => (
              <li key={entry.name} className="hof-legend">
                <img src={entry.image} alt={`${entry.name}'s ${entry.description}`} className={entry.portrait ? 'is-portrait' : ''} loading="lazy" />
                <span className="hof-legend-info">
                  <strong>{entry.name}</strong>
                  <span>
                    {entry.description} · {entry.date}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </div>
  );
};

export default HallOfFamePage;

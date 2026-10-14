import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Crown, ShieldAlert, ShieldCheck } from 'lucide-react';
import Sheet from '../ui/Sheet';
import CardImage from '../cards/CardImage';
import Tabs from '../ui/Tabs';
import { tabPanelProps } from '../ui/tabPanel';
import '../../styles/HallOfFame.css';
import { getCard } from '../../data/cards';
import { modifierClasses } from '../../game/modifiers';
import { checkPull } from '../../game/pulls';
import { loadHallOfFame, loadPending, type HallOfFameEntry } from '../../game/hallOfFameList';
import { firstPulls, HALL_OF_FAME_MIN_SCORE, HALL_OF_FAME_TOP, normalizeName, topPulls } from '../../engine';

// Hackathon legends: screenshots from before pulls were verifiable.
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

type Check = 'checking' | 'verified' | 'failed';

/** How many entries to re-verify on this device (each costs one ticket). */
const VERIFY_LIMIT = 30;

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

interface HallOfFamePageProps {
  onClose: () => void;
}

const HallOfFamePage = ({ onClose }: HallOfFamePageProps) => {
  const [entries, setEntries] = useState<HallOfFameEntry[] | null>(null);
  const [checks, setChecks] = useState<Record<number, Check>>({});
  const [tab, setTab] = useState<'top' | 'firsts' | 'legends'>('top');
  const tabsId = useId();

  const [pending, setPending] = useState<HallOfFameEntry[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const loadingRef = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    loadingRef.current = true;
    loadHallOfFame().then((list) => {
      if (controller.signal.aborted) return;
      loadingRef.current = false;
      if (list === null) {
        setLoadState('failed');
        return;
      }
      setEntries(list);
      setPending([]);
      setLoadState('loaded');
      // Then anything sent since the last deploy, checked here (see loadPending).
      loadPending(list, (entry) => {
        if (!controller.signal.aborted) setPending((prev) => [...prev, entry]);
      }, controller.signal).catch(() => {});
    });
    return () => controller.abort();
  }, [attempt]);
  const retry = () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadState('loading');
    setAttempt((prev) => prev + 1);
  };
  const all = useMemo(() => (entries ? [...entries, ...pending] : null), [entries, pending]);

  // The same rules the deploy used to pick these entries (src/engine/hallOfFame.ts): one entry per
  // pull, the earliest verification keeping the credit. A pull can be signed more than once, so they
  // key on the pull id (set, key and ticket number) rather than the proof text.
  const ranked = useMemo(() => topPulls(all ?? []), [all]);
  // World firsts go by when GitHub verified them, so only filed entries can be one.
  const firsts = useMemo(() => firstPulls(entries ?? []), [entries]);

  // Don't trust the JSON either: re-derive each pack here, one at a time. One queue for the whole
  // visit: entries arriving later (just-submitted ones reorder the list) join it, and nothing already
  // checked is checked again, since each check mines a ticket.
  const rankedRef = useRef(ranked);
  const startedRef = useRef(new Set<number>());
  const runningRef = useRef(false);
  const goneRef = useRef(false);
  useEffect(() => {
    // StrictMode replays setup after cleanup while retaining these refs.
    goneRef.current = false;
    return () => { goneRef.current = true; };
  }, []);
  useEffect(() => {
    rankedRef.current = ranked;
    const next = () => rankedRef.current.slice(0, VERIFY_LIMIT).find((e) => !e.pending && !startedRef.current.has(e.issue));
    const run = async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      for (let entry = next(); entry && !goneRef.current; entry = next()) {
        const { issue } = entry;
        startedRef.current.add(issue);
        setChecks((prev) => ({ ...prev, [issue]: 'checking' }));
        let result: Check = 'failed';
        try {
          const pull = await checkPull(entry.proof);
          // Every field we display must be exactly what the proof produces.
          const matches =
            pull.proof.name === entry.name &&
            pull.fingerprint === entry.fingerprint &&
            pull.set.id === entry.setId &&
            pull.score.hand.name === entry.hand &&
            pull.score.score === entry.score &&
            pull.cards.length === entry.cards.length &&
            pull.cards.every(
              (c, i) =>
                c.cardId === entry.cards[i]?.cardId &&
                c.isHolo === entry.cards[i]?.isHolo &&
                (c.finish ?? null) === (entry.cards[i]?.finish ?? null) &&
                !!c.misprint === !!entry.cards[i]?.misprint,
            );
          result = matches ? 'verified' : 'failed';
        } catch {
          result = 'failed';
        }
        if (!goneRef.current) setChecks((prev) => ({ ...prev, [issue]: result }));
      }
      runningRef.current = false;
      // Entries that arrived while the last check was finishing.
      if (!goneRef.current && next()) void run();
    };
    void run();
  }, [ranked]);

  const renderEntry = (entry: HallOfFameEntry, rank?: number) => {
    const check = entry.pending ? 'verified' : checks[entry.issue];
    const who = normalizeName(entry.name) || 'Anonymous';
    return (
      <li key={`${entry.proof}-${rank ?? 'first'}`}>
        <a
          className={`hof-entry ${check === 'failed' ? 'is-failed' : ''}`}
          href={`#/pull/${entry.proof}`}
          aria-label={`${rank !== undefined ? `Number ${rank + 1}: ` : ''}${entry.hand} by ${who} in ${entry.setName}, score ${entry.score}`}
        >
          {rank !== undefined && <span className="hof-rank tabular">{rank + 1}</span>}
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
              {entry.pending && <span className="hof-pending">Just submitted · </span>}
              {/* On world firsts, when matters, so it goes first where a long set name can't push it off. */}
              {rank === undefined && `${formatDate(entry.submittedAt)} · `}
              {entry.setName}
            </span>
          </span>
          <span className="hof-side">
            <span className="hof-score tabular">{entry.score.toLocaleString()}</span>
            <CheckBadge check={check} />
          </span>
        </a>
      </li>
    );
  };

  const empty = (
    <div className="hof-empty">
      <Crown aria-hidden="true" />
      <p>
        <strong>Nothing filed here yet.</strong> Pull a Full House or better (or a Brainrot Score of {HALL_OF_FAME_MIN_SCORE.toLocaleString()}+),
        share it, and submit it from the share sheet. You could be first.
      </p>
    </div>
  );

  return (
    <Sheet title="Hall of Fame" subtitle={`The top ${HALL_OF_FAME_TOP} pulls, and the first of every hand in each set`} onClose={onClose} size="lg" className="hall-of-fame">
      <Tabs
        idBase={tabsId}
        label="Hall of Fame lists"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'top', label: 'Leaderboard' },
          { id: 'firsts', label: 'World firsts' },
          { id: 'legends', label: 'Legends' },
        ]}
      />

      {tab !== 'legends' && (
        <div className={loadState === 'loaded' ? 'sr-only' : 'hof-load-state'}>
          {loadState === 'failed' && <p role="alert">Couldn't load the leaderboard. Try again.</p>}
          <p role="status">
            {loadState === 'loading' ? 'Loading leaderboard…' : loadState === 'loaded' ? 'Leaderboard loaded.' : ''}
          </p>
          {loadState !== 'loaded' && <button type="button" className="btn btn--secondary btn--sm" onClick={retry} disabled={loadState === 'loading'}>Retry</button>}
        </div>
      )}

      <div className="hof-panel" {...tabPanelProps(tabsId, tab)}>
        {tab === 'top' && (
          <>
            {loadState === 'loaded' && all?.length === 0 && empty}
            {ranked.length > 0 && (
              <>
                <p className="hof-note">
                  <ShieldCheck aria-hidden="true" /> Ranked by Brainrot Score. The top {VERIFY_LIMIT} are re-checked on your device; open one to see it.
                </p>
                <ol className="hof-list">{ranked.map((e, i) => renderEntry(e, i))}</ol>
              </>
            )}
          </>
        )}

        {tab === 'firsts' && (
          <>
            <p className="hof-note">The first verified Full House, 4 of a Kind and 5 of a Kind in each set.</p>
            {firsts.length > 0 ? <ul className="hof-list">{firsts.map((e) => renderEntry(e))}</ul> : loadState === 'loaded' ? empty : null}
          </>
        )}

        {tab === 'legends' && (
          <>
            <p className="hof-note">The originals, from the hackathon, before pulls were verifiable.</p>
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
          </>
        )}
      </div>
    </Sheet>
  );
};

const CheckBadge = ({ check }: { check?: Check }) => {
  // Verified is the normal case and the note above says so; only exceptions get a mark.
  if (check === 'verified') return null;
  if (check === 'failed')
    return (
      <span className="hof-check is-failed">
        <ShieldAlert aria-hidden="true" /> Failed
      </span>
    );
  if (check === 'checking') return <span className="hof-check">Checking…</span>;
  return null;
};

export default HallOfFamePage;

import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import CardImage from '../cards/CardImage';
import CardViewerModal from '../cards/CardViewerModal';
import type { CardWithMeta } from '../cards/Card';
import PullRow from './PullRow';
import { getSet, setCode } from '../../content/sets';
import { STORAGE_KEYS } from '../../constants';
import { qualifiesForHallOfFame } from '../../engine';
import {
  checkBestCard,
  checkBestPack,
  forCurrentPlayer,
  resolveBestCard,
  resolveBestPack,
  type BestCardSource,
  type BestPackSource,
  type BestPackStats,
  type BestSourceState,
  type CheckOptions,
  type OwnedPullRef,
  type UnavailableReason,
  type VerifiedBestCard,
  type VerifiedBestPack,
} from '../../game/bestSources';
import { modifierClasses, modifierLabel } from '../../game/modifiers';
import { getPlayerTickets, PLAYER_STORAGE_KEY } from '../../game/player';
import { versionOf } from '../../game/versions';
import '../../styles/Pulls.css';
import '../../styles/Profile.css';

type Check<S, V> = (source: S, options: CheckOptions) => Promise<BestSourceState<S, V>>;

/**
 * `found` as checked by the engine: once per source, again on each retry, the check stopped when the
 * source changes or the page goes. Whatever it settled on is retired the moment the player changes.
 */
const useChecked = <S extends { ref: OwnedPullRef }, V>(found: BestSourceState<S, V>, check: Check<S, V>) => {
  const id = found.status === 'checking' ? JSON.stringify(found.source) : null;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ id: string; attempt: number; state: BestSourceState<S, V> } | null>(null);
  // One source object per id, so the check starts again only when what it checks changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => (found.status === 'checking' ? found.source : null), [id]);
  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    const key = JSON.stringify(source);
    check(source, { signal: controller.signal }).then(
      (state) => {
        if (!controller.signal.aborted) setResult({ id: key, attempt, state });
      },
      () => { /* Aborted: the source or the page moved on. */ },
    );
    return () => controller.abort();
  }, [source, check, attempt]);
  const state = id !== null && result?.id === id && result.attempt === attempt ? result.state : found;
  return { state: forCurrentPlayer(state), retry: () => setAttempt((n) => n + 1) };
};

const UNAVAILABLE: Record<UnavailableReason, string> = {
  none: 'None yet.',
  legacy: "Your best pack is from before verifiable pulls, so it can't be checked.",
  'other-player': 'The one recorded here is a different player’s, so it isn’t shown.',
  'unknown-set': "Its set version isn't in this version of the game, so it can't be checked here.",
  'player-changed': 'The player changed, so the earlier result isn’t shown.',
  unranked: 'Not ranked yet: this device has no details for your best cards.',
};

const Verified = () => (
  <span className="profile-verified" title="Opened again from its ticket with your key: these exact cards and score">
    <span className="sr-only">, </span>
    <ShieldCheck aria-hidden="true" />
    Verified
  </span>
);

/** What a screen reader hears when a check settles: the state alone, never the row or its buttons. */
const stateText = <S, V>(state: BestSourceState<S, V>, what: string): string => {
  if (state.status === 'checking') return `Checking ${what} against its ticket…`;
  if (state.status === 'unavailable') return UNAVAILABLE[state.reason];
  if (state.status === 'available') return `Verified: ${what}.`;
  if (state.reason === 'mismatch') return "Not verified: its ticket doesn't open what was recorded, so it isn't shown.";
  return `Couldn't check ${what} just now.`;
};

/**
 * What stands where a verified row will be while its check is still on the way. It is the row's own
 * layout (same thumbnails, lines and score), so the verdict arriving never moves the packs listed below.
 */
const PendingRow = ({ card, text }: { card?: boolean; text: string }) => (
  <ul className="pulls-list" aria-hidden="true">
    <li>
      <div className={`pull-row profile-highlight-pending${card ? ' best-card-row' : ''}`}>
        <span className="pull-row-thumbs">
          {Array.from({ length: card ? 1 : 5 }, (_, i) => (
            <span key={i} className="pull-row-blank" />
          ))}
        </span>
        <span className="pull-row-main">
          <span className="pull-row-hand">{text}</span>
          <span className="pull-row-meta">
            <span className="set-code">&nbsp;</span>
          </span>
        </span>
        <span className="pull-row-score tabular">&nbsp;</span>
        <ChevronRight className="pull-row-chevron" aria-hidden="true" />
      </div>
    </li>
  </ul>
);

interface HighlightProps<S, V> {
  title: string;
  titleRef: RefObject<HTMLHeadingElement | null>;
  state: BestSourceState<S, V>;
  what: string;
  /** Try again, after an error that checking again can fix. */
  onRetry: () => void;
  /** The row's place is held (checking, or a check that is about to start) so that its verdict moves nothing. */
  waiting: boolean;
  /** A best card's row is taller than a best pack's. */
  card?: boolean;
  /** The verified row, once there is one. */
  children?: ReactNode;
}

const Highlight = <S, V>({ title, titleRef, state, what, onRetry, waiting, card, children }: HighlightProps<S, V>) => {
  const id = useId();
  // The row (or the place held for it) says what is happening, so the live region alone carries the words.
  const quiet = state.status === 'available' || waiting;
  return (
    <section aria-labelledby={id} className="profile-highlight">
      <h2 id={id} ref={titleRef} tabIndex={-1} className="section-title profile-heading">
        {title}
      </h2>
      {/* Only the state is live (checking, then verified or why not), so a settled check doesn't read out the whole row. */}
      <p className={quiet ? 'sr-only' : 'pulls-note profile-highlight-note'}>
        <span role="status">{waiting ? `Checking ${what} against its ticket…` : stateText(state, what)}</span>
        {state.status === 'failed' && state.reason !== 'mismatch' && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>
            Try again
          </button>
        )}
      </p>
      {waiting ? <PendingRow card={card} text="Checking…" /> : children}
    </section>
  );
};

interface BestHighlightsProps {
  stats: BestPackStats;
  /** Changes when this device's packs or Best cards change: find both again. */
  refreshKey: string;
  /** Opens the pack's share sheet (its ordinary pull proof). */
  onSharePack: (ref: OwnedPullRef, cards: CardWithMeta[]) => void;
  /** After the Verified mark, e.g. whether this device sent the pack to the Hall of Fame. */
  packBadge?: (ref: OwnedPullRef) => ReactNode;
  /**
   * This device has saved packs whose best card is still being weighed (BestCardsSection), so one is on
   * its way: its place is held now, and a best card found later moves nothing below.
   */
  expecting?: boolean;
}

/**
 * The Profile's two highlights (#680): Best pack and Best card, each found from what was kept for it
 * (game/bestSources.ts) and verified on its own by opening its one pack again, so one still checking
 * or failing never holds back the other. Only the engine's cards and score are shown as verified; the
 * badge covers that pack, never the whole profile. Each shares through its pack's ordinary pull proof.
 */
const BestHighlights = ({ stats, refreshKey, onSharePack, packBadge, expecting = false }: BestHighlightsProps) => {
  // Another tab switching or importing a player, or recording a pack: find both again.
  const [run, setRun] = useState(0);
  useEffect(() => {
    const watched = new Set<string>([PLAYER_STORAGE_KEY, STORAGE_KEYS.STATS, STORAGE_KEYS.BEST_CARDS]);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || watched.has(event.key)) setRun((n) => n + 1);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const found = useMemo(() => {
    const snapshot = getPlayerTickets();
    return { pack: resolveBestPack(stats, snapshot.player), card: resolveBestCard(snapshot) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, refreshKey, run]);
  const pack = useChecked<BestPackSource, VerifiedBestPack>(found.pack, checkBestPack);
  const card = useChecked<BestCardSource, VerifiedBestCard>(found.card, checkBestCard);

  const packTitle = useRef<HTMLHeadingElement>(null);
  const cardTitle = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  /** The card whose viewer is open, by source: a viewer for a card no longer shown never comes back on its own. */
  const [viewing, setViewing] = useState<string | null>(null);
  // The viewer hands focus back to whatever had it, but Safari doesn't focus a button on click: land on the row regardless.
  useEffect(() => {
    if (!viewing && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  }, [viewing]);
  /** Try again removes the button that had focus: keep focus in the highlight, on its heading. */
  const retry = (again: () => void, title: RefObject<HTMLHeadingElement | null>) => {
    title.current?.focus({ preventScroll: true });
    again();
  };

  const unavailableFor = (s: BestSourceState<unknown, unknown>, reason: 'none' | 'unranked') =>
    s.status === 'unavailable' && s.reason === reason;
  const nothing = (s: BestSourceState<unknown, unknown>) => unavailableFor(s, 'none');
  // The empty profile keeps its own first-pack prompt.
  if (nothing(pack.state) && nothing(card.state) && !expecting) return null;
  const anyVerified = pack.state.status === 'available' || card.state.status === 'available';
  // While the rebuild runs, winners with no cards yet read as 'unranked': that holds the place too.
  const cardWaiting =
    card.state.status === 'checking' || (expecting && (nothing(card.state) || unavailableFor(card.state, 'unranked')));
  const anyWaiting = cardWaiting || pack.state.status === 'checking';

  const shownCard = card.state.status === 'available' ? card.state : null;
  const cardSet = shownCard && getSet(shownCard.source.ref.setId, shownCard.source.ref.setVersion);
  const [a = '#ff3df2', b = '#29f0ff'] = cardSet?.palette ?? [];
  const cardVersion = shownCard && versionOf(shownCard.verified.pulled);
  const cardId = shownCard && JSON.stringify([shownCard.source.ref, shownCard.source.slot]);

  return (
    <div className="profile-highlights">
      <Highlight
        title="Best pack"
        titleRef={packTitle}
        state={pack.state}
        what="your best pack"
        onRetry={() => retry(pack.retry, packTitle)}
        waiting={pack.state.status === 'checking'}
      >
        {pack.state.status === 'available' && (
          <ul className="pulls-list">
            {(() => {
              const { source, verified } = pack.state;
              return (
                <PullRow
                  cards={verified.cards}
                  set={getSet(source.ref.setId, source.ref.setVersion)}
                  setId={source.ref.setId}
                  hand={verified.score.hand.name}
                  score={verified.score.score}
                  meta={<>ticket #{source.ref.nonce.toLocaleString()}</>}
                  worthy={qualifiesForHallOfFame(verified.score)}
                  badge={
                    <>
                      <Verified />
                      {packBadge?.(source.ref)}
                    </>
                  }
                  onClick={() => onSharePack(source.ref, verified.cards)}
                />
              );
            })()}
          </ul>
        )}
      </Highlight>

      <Highlight
        title="Best card"
        titleRef={cardTitle}
        state={card.state}
        what="your best card"
        onRetry={() => retry(card.retry, cardTitle)}
        waiting={cardWaiting}
        card
      >
        {shownCard && cardVersion && (
          <>
            <ul className="pulls-list">
              <li>
                <button
                  type="button"
                  className="pull-row best-card-row quiet-focus"
                  style={{ '--set-a': a, '--set-b': b } as React.CSSProperties}
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setViewing(cardId);
                  }}
                >
                  <span className="pull-row-thumbs" aria-hidden="true">
                    <CardImage
                      src={shownCard.verified.card.image}
                      finish={cardVersion.finish}
                      alt=""
                      loading="lazy"
                      className={`${cardVersion.isHolo ? 'holo' : ''} ${modifierClasses(cardVersion)}`}
                    />
                  </span>
                  <span className="pull-row-main">
                    <span className="pull-row-hand">
                      {shownCard.verified.card.name}
                      <Verified />
                    </span>
                    <span className="pull-row-meta">
                      {cardSet && <span className="set-code">{setCode(cardSet)}</span>}
                      <span className="sr-only">, </span>
                      {modifierLabel(cardVersion) || 'Plain'}
                      <span className="sr-only">, </span>
                      <span> · ticket #{shownCard.source.ref.nonce.toLocaleString()}</span>
                    </span>
                  </span>
                  <span className="pull-row-score tabular">
                    {shownCard.verified.points.toLocaleString()}
                    <span className="pull-row-unit" aria-hidden="true"> pts</span>
                    <span className="sr-only"> points</span>
                  </span>
                  <ChevronRight className="pull-row-chevron" aria-hidden="true" />
                </button>
              </li>
            </ul>
            {!shownCard.source.complete && <p className="pulls-note profile-highlight-note">The best among the packs saved on this device.</p>}
          </>
        )}
      </Highlight>

      {/* While a check is out, the footnote's place is held, so a verdict moves nothing below it. */}
      {(anyVerified || anyWaiting) && (
        <p className={anyVerified ? 'profile-footnote' : 'profile-footnote profile-footnote--held'} aria-hidden={anyVerified ? undefined : true}>
          Verified means its pack was opened again from its ticket with your key. It covers that pack only: your level and totals
          below are this device's progress.
        </p>
      )}

      {viewing !== null && viewing === cardId && shownCard && cardVersion && (
        <CardViewerModal
          card={{ ...shownCard.verified.card, ...cardVersion }}
          canShare
          pack={shownCard.source.ref}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
};

export default BestHighlights;

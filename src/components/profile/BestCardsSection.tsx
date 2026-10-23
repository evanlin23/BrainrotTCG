import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import CardImage from '../cards/CardImage';
import CardViewerModal from '../cards/CardViewerModal';
import { getLatestSet, setCode } from '../../content/sets';
import { getCard, type Card } from '../../data/cards';
import { getBestCards, rebuildBestCards, type BestCard, type BestCards } from '../../game/bestCards';
import { modifierClasses, modifierLabel } from '../../game/modifiers';
import { getPlayerTickets } from '../../game/player';
import { syncMyBestCards } from '../../game/profiles';
import type { PullRef } from '../../game/pulls';
import { versionOf, type CardVersion } from '../../game/versions';

/** One listed instance, with the card as its pack's set version drew it (a later version can't change it). */
interface Row {
  id: string;
  card: Card & CardVersion;
  version: CardVersion;
  points: number;
  ref: PullRef & { publicKeyHex: string };
}

const toRow = (best: BestCard): Row | null => {
  if (!best.card || best.points === null) return null;
  const base = getCard(`${best.card.setId}/${best.card.cardId}`);
  if (!base) return null;
  const version = versionOf(best.card);
  return {
    id: `${best.publicKeyHex}-${best.setId}@${best.setVersion}-${best.nonce}-${best.slot}`,
    card: { ...base, rarity: best.card.rarity, ...version },
    version,
    points: best.points,
    ref: { setId: best.setId, setVersion: best.setVersion, nonce: best.nonce, publicKeyHex: best.publicKeyHex },
  };
};

const readList = (): BestCards => {
  const { player, nextNonce } = getPlayerTickets();
  return getBestCards(player.publicKeyHex, nextNonce);
};

interface BestCardsSectionProps {
  /** Changes when the packs this device holds change: weigh them again. */
  refreshKey: string;
  /** Saved packs are all read in. Until then an empty list may only be one that isn't loaded yet. */
  cacheReady: boolean;
  /** The stored list was weighed or rebuilt (the Best card highlight finds its winner again). */
  onListChange?: () => void;
  /** Whether every winner has its card, or the last rebuild gave up on some: no best card is still on its way. */
  onSettledChange?: (settled: boolean) => void;
}

/**
 * The player's best individual cards (game/bestCards.ts), best first, each opening the card viewer with
 * its Share card action for that exact version. Only the current key's list is ever read.
 */
const BestCardsSection = ({ refreshKey, cacheReady, onListChange, onSettledChange }: BestCardsSectionProps) => {
  const [list, setList] = useState(readList);
  const [rebuilding, setRebuilding] = useState(false);
  /** The last rebuild lost some winners' cards (a pack that wouldn't derive, or the rebuild itself): not an empty collection. */
  const [unavailable, setUnavailable] = useState(false);
  /** Bumped by Try again, which runs the same rebuild once more. */
  const [attempt, setAttempt] = useState(0);
  const [viewing, setViewing] = useState<Row | null>(null);
  const mounted = useRef(true);
  // The latest callback, for the effects below without restarting them.
  const listChanged = useRef(onListChange);
  useEffect(() => {
    listChanged.current = onListChange;
  });
  const rebuilt = useRef(new Set<string>());
  const opener = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  /** Try again was pressed: 'asked' until its rebuild starts, 'running' until that rebuild settles. */
  const retried = useRef<'asked' | 'running' | null>(null);

  // The viewer hands focus back to whatever had it, but Safari doesn't focus a button on click: land on the row regardless.
  // That is script focus, so the row is .quiet-focus: no ring after a press or click, the ring back after Escape or Tab (base.css, #312).
  useEffect(() => {
    if (!viewing && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  }, [viewing]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Weigh the packs this device can recover into the list (again as more of them are read in).
  useEffect(() => {
    try {
      // Reads and saves the stored list (an external system), so it runs after the render, not in it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setList(syncMyBestCards());
      listChanged.current?.();
    } catch { /* The list as stored stays on screen. */ }
  }, [refreshKey]);

  // Winners this build can't score yet (their cached card is gone) are re-derived from their tickets, once per key
  // (and once more each time the player asks to try again, never on its own).
  useEffect(() => {
    // A retry that starts no rebuild has no outcome to move focus for.
    const skip = () => {
      if (retried.current === 'asked') retried.current = null;
    };
    if (!cacheReady || !list.cards.some((c) => !c.card)) return skip();
    const { player, nextNonce } = getPlayerTickets();
    if (rebuilt.current.has(player.publicKeyHex)) return skip();
    rebuilt.current.add(player.publicKeyHex);
    if (retried.current === 'asked') retried.current = 'running';
    setRebuilding(true);
    void rebuildBestCards(player.publicKeyHex, nextNonce)
      .then(({ cards, complete, unsaved, failed }) => {
        // A player switched meanwhile is no longer the one on screen.
        if (!mounted.current || getPlayerTickets().player.publicKeyHex !== player.publicKeyHex) return;
        setList({ cards, complete, unsaved });
        setUnavailable(failed > 0);
        listChanged.current?.();
      })
      .catch(() => {
        if (mounted.current && getPlayerTickets().player.publicKeyHex === player.publicKeyHex) setUnavailable(true);
      })
      .finally(() => {
        if (mounted.current) setRebuilding(false);
      });
  }, [list, cacheReady, attempt]);

  const retry = () => {
    if (rebuilding) return;
    rebuilt.current.delete(getPlayerTickets().player.publicKeyHex);
    retried.current = 'asked';
    setAttempt((n) => n + 1);
  };

  const rows = useMemo(() => list.cards.map(toRow).filter((r): r is Row => r !== null), [list]);
  // No heading over a list that is still on its way in.
  // Only while winners are still unscored: packs read in later may have settled them.
  const lost = unavailable && list.cards.some((c) => !c.card);
  const settled = cacheReady && !rebuilding && (lost || !list.cards.some((c) => !c.card));
  const settledChanged = useRef(onSettledChange);
  useEffect(() => {
    settledChanged.current = onSettledChange;
  });
  useEffect(() => {
    settledChanged.current?.(settled);
  }, [settled]);
  // A retry that settles it removes the status and its button, which had focus: land on the first row, else the heading.
  useEffect(() => {
    if (rebuilding || retried.current !== 'running') return;
    retried.current = null;
    if (lost) return;
    // Only if focus was left behind (on the vanished button, so on the page) or is still in the section:
    // a player who moved on meanwhile keeps their place.
    const active = document.activeElement;
    if (active && active !== document.body && !sectionRef.current?.contains(active)) return;
    (sectionRef.current?.querySelector<HTMLElement>('.best-card-row') ?? titleRef.current)?.focus({ preventScroll: true });
  }, [rebuilding, lost]);

  if (rows.length === 0 && !lost && (!cacheReady || rebuilding)) return null;

  return (
    <section ref={sectionRef} aria-labelledby="best-cards-title" className="best-cards">
      <h2 id="best-cards-title" ref={titleRef} tabIndex={-1} className="section-title best-cards-title">
        Best cards
      </h2>
      {lost && (
        <div className="pulls-note" role="status">
          <p>
            {rebuilding
              ? 'Trying again…'
              : rows.length === 0
                ? "Your best cards couldn't be loaded just now. They are still saved on this device."
                : "Some of your best cards couldn't be loaded just now. The rest are listed, and the others are still saved on this device."}
          </p>
          <button type="button" className="btn btn--ghost" aria-disabled={rebuilding} onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        lost ? null : <p className="pulls-note">None on this device yet. Open a pack and its best cards collect here.</p>
      ) : (
        <>
          {!list.complete && <p className="pulls-note">The best among the packs saved on this device.</p>}
          <ul className="pulls-list">
            {rows.map((row) => {
              const set = getLatestSet(row.ref.setId);
              const [a = '#ff3df2', b = '#29f0ff'] = set?.palette ?? [];
              const words = modifierLabel(row.version) || 'Plain';
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className="pull-row best-card-row quiet-focus"
                    style={{ '--set-a': a, '--set-b': b } as React.CSSProperties}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setViewing(row);
                    }}
                  >
                    <span className="pull-row-thumbs" aria-hidden="true">
                      <CardImage
                        src={row.card.image}
                        finish={row.version.finish}
                        alt=""
                        loading="lazy"
                        className={`${row.version.isHolo ? 'holo' : ''} ${modifierClasses(row.version)}`}
                      />
                    </span>
                    <span className="pull-row-main">
                      <span className="pull-row-hand">{row.card.name}</span>
                      <span className="pull-row-meta">
                        {set && <span className="set-code">{setCode(set)}</span>}
                        <span className="sr-only">, </span>
                        {words}
                        <span className="sr-only">, </span>
                        <span> · ticket #{row.ref.nonce.toLocaleString()}</span>
                      </span>
                    </span>
                    <span className="pull-row-score tabular">
                      {row.points.toLocaleString()}
                      <span className="pull-row-unit" aria-hidden="true"> pts</span>
                      <span className="sr-only"> points</span>
                    </span>
                    <ChevronRight className="pull-row-chevron" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {viewing && <CardViewerModal card={viewing.card} canShare pack={viewing.ref} onClose={() => setViewing(null)} />}
    </section>
  );
};

export default BestCardsSection;

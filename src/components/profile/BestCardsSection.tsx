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
}

/**
 * The player's best individual cards (game/bestCards.ts), best first, each opening the card viewer with
 * its Share card action for that exact version. Only the current key's list is ever read.
 */
const BestCardsSection = ({ refreshKey, cacheReady }: BestCardsSectionProps) => {
  const [list, setList] = useState(readList);
  const [rebuilding, setRebuilding] = useState(false);
  const [viewing, setViewing] = useState<Row | null>(null);
  const mounted = useRef(true);
  const rebuilt = useRef(new Set<string>());
  const opener = useRef<HTMLButtonElement | null>(null);

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
    } catch { /* The list as stored stays on screen. */ }
  }, [refreshKey]);

  // Winners this build can't score yet (their cached card is gone) are re-derived from their tickets, once per key.
  useEffect(() => {
    if (!cacheReady || !list.cards.some((c) => !c.card)) return;
    const { player, nextNonce } = getPlayerTickets();
    if (rebuilt.current.has(player.publicKeyHex)) return;
    rebuilt.current.add(player.publicKeyHex);
    setRebuilding(true);
    void rebuildBestCards(player.publicKeyHex, nextNonce)
      .then(({ cards, complete, unsaved }) => {
        if (mounted.current) setList({ cards, complete, unsaved });
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current) setRebuilding(false);
      });
  }, [list, cacheReady]);

  const rows = useMemo(() => list.cards.map(toRow).filter((r): r is Row => r !== null), [list]);
  // No heading over a list that is still on its way in.
  if (rows.length === 0 && (!cacheReady || rebuilding)) return null;

  return (
    <section aria-labelledby="best-cards-title" className="best-cards">
      <h2 id="best-cards-title" className="section-title best-cards-title">
        Best cards
      </h2>
      {rows.length === 0 ? (
        <p className="pulls-note">None on this device yet. Open a pack and its best cards collect here.</p>
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

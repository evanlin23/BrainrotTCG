import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { motion } from 'framer-motion';
import { RotateCcw, Share2 } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import CardViewerModal from '../cards/CardViewerModal';
import CardImage from '../cards/CardImage';
import DeferredSheet from '../ui/DeferredSheet';
import { sheetLoader } from '../ui/sheetEntry';
import CardGuideButton from '../ui/CardGuideButton';
import { modifierLabel, modifierThumb, specialCardsLine } from '../../game/modifiers';
import { CARD_RARITIES, cardNumber, scoreCards } from '../../data/cards';
import { comboOneIn, type SetDefinition } from '../../engine';
import { myProgress } from '../../game/profiles';
import type { PullRef } from '../../game/pulls';
import { bestPullOrder } from '../../game/reveal';
import { versionOf } from '../../game/versions';
import { usePackCacheVersion } from '../../hooks/usePackCache';
import { useHoldUntilDecoded } from '../../hooks/useHoldUntilDecoded';
import PackCacheNote from '../profile/PackCacheNote';
import PackHeadline from './PackHeadline';
import '../../styles/CollectionLabel.css';
import '../../styles/PackSummary.css';

const Motion = motion;
const loadCardShare = sheetLoader(() => import('../share/CardShareSheet'));

interface PackSummaryUIProps {
  openedCards: CardWithMeta[];
  set: SetDefinition;
  onClose: () => void;
  onShare?: () => void;
  /** The pull these cards came from: each card can then be shared or saved as an image that links to it. */
  pack?: PullRef;
  /** Keep optional work waiting until these cards have decoded (off while a sheet covers them). */
  holdOptional?: boolean;
}

/**
 * After the last card, one screen (docs/DESIGN.md, one-screen summary rule): the headline (combo,
 * Brainrot Score, standout card, how rare the combo is), the five cards in one compact row, best pull
 * first (each opens up close, and has its own Share for an image of it that links to this pack), then
 * the actions, stuck to the bottom so they never scroll away. Below them: new cards, level progress,
 * and how the score works, folded. Sharing starts here, never mid-reveal: the link carries the whole
 * pack, so it would spoil the cards still face down.
 */
const PackSummaryUI = ({ openedCards, set, onClose, onShare, pack, holdOptional = false }: PackSummaryUIProps) => {
  const [selected, setSelected] = useState<CardWithMeta | null>(null);
  const [sharing, setSharing] = useState<CardWithMeta | null>(null);
  // The "tap a card" hint stays until a card is opened on this visit.
  const [viewed, setViewed] = useState(false);
  const shown = useMemo(() => bestPullOrder(openedCards), [openedCards]);
  const cardsRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useHoldUntilDecoded(cardsRef, holdOptional);
  // The keyboard starts at the result, not on an action: the heading, so the cards come next.
  useEffect(() => {
    if (holdOptional) headingRef.current?.focus({ preventScroll: true });
    // Only as it appears; not while a sheet covers it (holdOptional is off then).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Keyboard focus never lands under the stuck actions, however tall large text makes them: the browser
  // only scrolls focus into the scroller's box, so move it clear of them.
  const clearActions = (event: FocusEvent<HTMLDivElement>) => {
    const actions = actionsRef.current;
    const target = event.target;
    if (!actions || actions.contains(target)) return;
    const stuck = actions.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    if (box.bottom <= stuck.top || box.top >= stuck.bottom) return;
    const before = actions.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING;
    event.currentTarget.scrollBy({ top: before ? box.bottom - stuck.top + 8 : box.top - stuck.bottom - 8 });
  };
  const { points, hand, score } = scoreCards(openedCards);
  // Enumerates every pack of the set, so once per set and combo.
  const oneIn = useMemo(() => comboOneIn(set, scoreCards(openedCards).hand), [set, openedCards]);
  const newCount = openedCards.filter((c) => c.isNew).length;
  const special = specialCardsLine(openedCards);
  // What this pack did for your level: shown here so progress isn't hidden away in the profile.
  // Null until saved packs are read: a loading note then, never zero XP.
  const packCache = usePackCacheVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const progress = useMemo(() => myProgress(), [packCache]);
  const into = progress ? progress.xp - progress.levelXp : 0;
  const span = progress ? progress.nextXp - progress.levelXp : 1;

  return (
    <Motion.div className="pack-summary" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
      <div className="summary-content" onFocus={clearActions}>
        <div className="summary-details">
          {/* openedCards are in reveal order, which keeps pack order on ties, so the standout's tie rule holds. */}
          <PackHeadline cards={openedCards} headingRef={headingRef} oneIn={oneIn} />
          <ul className="summary-cards" ref={cardsRef}>
            {shown.map((card) => (
              <li key={card.uniqueId}>
                <button
                  type="button"
                  className={`summary-card ${card.rarity.toLowerCase()} ${card.isHolo ? 'holo' : ''} ${modifierThumb(card).className}`}
                  style={modifierThumb(card).style}
                  onClick={() => {
                    setSelected(card);
                    setViewed(true);
                  }}
                  aria-label={`View ${card.name} up close, ${CARD_RARITIES[card.rarity].name}${modifierLabel(card) ? `, ${modifierLabel(card)}` : ''}${card.isNew ? ', new' : ''}`}
                >
                  <CardImage src={card.image} finish={card.finish} alt="" draggable="false" />
                  <span className="summary-card-expand" aria-hidden="true">⤢</span>
                  {card.isNew && <span className="new-sticker">New</span>}
                  {modifierLabel(card, false) && <span className="mod-label">{modifierLabel(card, false)}</span>}
                </button>
                <span className="collection-label tabular" aria-hidden="true">
                  {cardNumber(card)}{' '}
                  <span className={`collection-label-rarity ${card.rarity.toLowerCase()}`}>{CARD_RARITIES[card.rarity].symbol}</span>
                </span>
                {pack && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm summary-card-share"
                    onClick={() => setSharing(card)}
                    aria-label={`Share or save ${card.name}${modifierLabel(card) ? `, ${modifierLabel(card)}` : ''}`}
                  >
                    <Share2 aria-hidden="true" /> <span className="summary-card-share-text">Share</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!viewed && <p className="summary-caption">Tap a card to see it up close</p>}

          {/* Right after the result, and stuck to the bottom so they never scroll away. */}
          <div className="summary-actions" ref={actionsRef}>
            {onShare && (
              <button type="button" className="btn btn--secondary btn--lg" onClick={onShare}>
                <Share2 aria-hidden="true" /> Share
              </button>
            )}
            <button type="button" className="btn btn--primary btn--lg" onClick={onClose}>
              <RotateCcw aria-hidden="true" /> Open another pack
            </button>
          </div>

          {special && <p className="summary-new">{special}</p>}
          {newCount > 0 && (
            <p className="summary-new tabular">
              {newCount} new {newCount === 1 ? 'card' : 'cards'} for your binder
            </p>
          )}
          {progress ? (
            <div className="summary-xp">
              <span className="summary-xp-text tabular">
                <strong>+{progress.gained.toLocaleString()} XP</strong> · Level {progress.level} · {into.toLocaleString()}/{span.toLocaleString()} to Level {progress.level + 1}
              </span>
              <span className="progress" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (into / span) * 100)}%` }} />
              </span>
            </div>
          ) : (
            <PackCacheNote what="your level progress" className="summary-xp summary-xp-text" />
          )}
          <details className="summary-how">
            <summary>How this score works</summary>
            <p className="summary-how-math tabular">
              {points.toLocaleString()} pts × <strong>{hand.multiplier.toLocaleString()}</strong> for {hand.name} ={' '}
              <strong>{score.toLocaleString()}</strong> Brainrot Score
            </p>
            <CardGuideButton set={set} />
          </details>
        </div>
      </div>

      {selected && (
        <CardViewerModal
          card={selected}
          onClose={() => setSelected(null)}
          canShare
          pack={pack}
        />
      )}
      {sharing && pack && (
        <DeferredSheet
          load={loadCardShare}
          title={`Share ${sharing.name}`}
          screenProps={{ card: sharing, version: versionOf(sharing), from: pack, onClose: () => setSharing(null) }}
        />
      )}
    </Motion.div>
  );
};

export default PackSummaryUI;

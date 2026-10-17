import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { motion } from 'framer-motion';
import { RotateCcw, Share2 } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import CardViewerModal from '../cards/CardViewerModal';
import CardImage from '../cards/CardImage';
import CardGuideButton from '../ui/CardGuideButton';
import { modifierLabel, modifierThumb } from '../../game/modifiers';
import { CARD_RARITIES, cardNumber, scoreCards } from '../../data/cards';
import { scoreAtLeastChance, type SetDefinition } from '../../engine';
import type { PullRef } from '../../game/pulls';
import { useHoldUntilDecoded } from '../../hooks/useHoldUntilDecoded';
import PackHeadline from './PackHeadline';
import SummaryHallOfFame from './SummaryHallOfFame';
import '../../styles/CollectionLabel.css';
import '../../styles/PackSummary.css';

const Motion = motion;

interface PackSummaryUIProps {
  openedCards: CardWithMeta[];
  set: SetDefinition;
  onClose: () => void;
  onShare?: () => void;
  /** The pull these cards came from: a card opened up close can then be shared or saved as an image that links to it. */
  pack?: PullRef;
  /** Keep optional work waiting until these cards have decoded (off while a sheet covers them). */
  holdOptional?: boolean;
}

/**
 * After the last card, one screen (docs/DESIGN.md, one-screen summary rule): the headline (Brainrot
 * Score, then "[combo] · 1 in X packs score this high" or "Most packs score this high", then the Hall of
 * Fame line), one line with the card hint and the Card guide link, the five cards in one compact row, in
 * the order they were revealed (each wears its New and special badges and opens up close, where it can be
 * shared as an image that links to this pack; the summary has no per-card Share), then the actions, stuck
 * to the bottom so they never scroll away. Nothing follows them: level progress lives on Profile. Sharing
 * starts here, never mid-reveal: the link carries the whole pack, so it would spoil the cards still face
 * down.
 */
const PackSummaryUI = ({ openedCards, set, onClose, onShare, pack, holdOptional = false }: PackSummaryUIProps) => {
  const [selected, setSelected] = useState<CardWithMeta | null>(null);
  // The "select a card" hint stays until a card is opened on this visit.
  const [viewed, setViewed] = useState(false);
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
  const packScore = useMemo(() => scoreCards(openedCards), [openedCards]);
  // Works through every pack of the set (cached per set), so once per set and score, not on each render.
  const scoreChance = useMemo(() => scoreAtLeastChance(set, packScore.score), [set, packScore.score]);

  return (
    <Motion.div className="pack-summary" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
      <div className="summary-content" onFocus={clearActions}>
        <div className="summary-details">
          <PackHeadline cards={openedCards} headingRef={headingRef} scoreChance={scoreChance}>
            {pack && <SummaryHallOfFame pack={pack} score={packScore} />}
          </PackHeadline>
          <div className="summary-guide-line">
            {!viewed && <p className="summary-caption">Select a card to view</p>}
            <CardGuideButton set={set} />
          </div>
          <ul className="summary-cards" ref={cardsRef}>
            {openedCards.map((card) => (
              <li key={card.uniqueId}>
                <button
                  type="button"
                  className={`summary-card quiet-focus ${card.rarity.toLowerCase()} ${card.isHolo ? 'holo' : ''} ${modifierThumb(card).className}`}
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
              </li>
            ))}
          </ul>

          {/* Right after the result, and stuck to the bottom so they never scroll away. */}
          <div className="summary-actions" ref={actionsRef}>
            {onShare && (
              <button type="button" className="btn btn--secondary btn--lg" onClick={onShare}>
                <Share2 aria-hidden="true" /> Share
              </button>
            )}
            <button type="button" className="btn btn--primary btn--lg" onClick={onClose}>
              <RotateCcw aria-hidden="true" /> Next pack
            </button>
          </div>
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
    </Motion.div>
  );
};

export default PackSummaryUI;

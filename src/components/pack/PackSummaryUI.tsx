import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { motion } from 'framer-motion';
import { RotateCcw, Share2 } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import type { CollectionItem } from '../../types';
import CardViewerModal from '../cards/CardViewerModal';
import CardImage from '../cards/CardImage';
import CardGuideButton from '../ui/CardGuideButton';
import { packThumbUrl } from '../../content/art';
import { otherPackChoices } from '../sets/packChoices';
import { modifierLabel, modifierThumb } from '../../game/modifiers';
import { CARD_RARITIES, cardNumber, scoreCards } from '../../data/cards';
import type { SetDefinition } from '../../engine';
import type { PullRef } from '../../game/pulls';
import { getHistory } from '../../game/history';
import { packRecord } from '../../game/personalRecords';
import { useHoldUntilDecoded } from '../../hooks/useHoldUntilDecoded';
import { STAGE_PRIMARY_ATTR, type StageClickGuard } from '../../hooks/useStageClickGuard';
import PackHeadline from './PackHeadline';
import SummaryHallOfFame from './SummaryHallOfFame';
import '../../styles/CollectionLabel.css';
import '../../styles/PackSummary.css';

const Motion = motion;

// The wrapper thumbnails render at a fixed size (the art is 300x533), so their load never changes the layout.
const THUMB_H = 28;
const THUMB_W = 16;

/** What "Try another pack" needs: the sets the picker lists (oldest first), the player's cards, and how to open the Packs sheet. */
export interface PackChoices {
  sets: SetDefinition[];
  collection: Record<string, CollectionItem>;
  onOpen: () => void;
}

interface PackSummaryUIProps {
  openedCards: CardWithMeta[];
  set: SetDefinition;
  onClose: () => void;
  onShare?: () => void;
  /** The pull these cards came from: a card opened up close can then be shared or saved as an image that links to it. */
  pack?: PullRef;
  /** Go to Rankings' "How Rankings work" (the summary stays mounted under the page, as for any page). */
  onOpenRankingsHelp?: () => void;
  /** Keep optional work waiting until these cards have decoded (off while a sheet covers them). */
  holdOptional?: boolean;
  /**
   * The summary's settle window (useStageClickGuard), owned by PackOpener so the keyboard (Space and Enter)
   * reads the same state that holds these clicks and sets data-settling here (#972).
   */
  guard: StageClickGuard;
  /** Left out (or with no other set to choose), the summary has no "Try another pack". */
  packChoices?: PackChoices;
}

/**
 * After the last card, one screen (docs/DESIGN.md, one-screen summary rule): the headline (Brainrot
 * Score, led by NEW BEST (or a set best) when it beats the player's best, then "[combo] ×[multiplier]", then the
 * previous best for a record, or "your #2 pack ever", then the Hall of Fame line), one line with the card hint and the Card guide link, the five cards in one compact row, in
 * the order they were revealed (each wears its New and special badges and opens up close, where it can be
 * shared as an image that links to this pack; the summary has no per-card Share), then the actions, stuck
 * to the bottom so they never scroll away. Nothing follows them: level progress lives on Profile. Sharing
 * starts here, never mid-reveal: the link carries the whole pack, so it would spoil the cards still face
 * down.
 */
const PackSummaryUI = ({ openedCards, set, onClose, onShare, pack, onOpenRankingsHelp, holdOptional = false, guard, packChoices }: PackSummaryUIProps) => {
  const [selected, setSelected] = useState<CardWithMeta | null>(null);
  // The "select a card" hint stays until a card is opened on this visit.
  const [viewed, setViewed] = useState(false);
  const cardsRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useHoldUntilDecoded(cardsRef, holdOptional);
  // A click that was meant for the last card (the player is clicking in one spot, #627) lands here as the
  // summary appears: it must not open a card up close, the Card guide, the share sheet or send a Hall of
  // Fame entry. Open again is the one deliberate move.
  const { blockClicks, settling } = guard;
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
  // Whatever scrolls something into view (a click's auto-scroll, a screen reader's focus) stops clear of the
  // stuck actions however tall they are: the list's scroll padding follows their real height.
  useEffect(() => {
    const content = contentRef.current;
    const actions = actionsRef.current;
    if (!content || !actions || typeof ResizeObserver === 'undefined') return;
    const publish = () => content.style.setProperty('--summary-actions-height', `${actions.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(actions);
    return () => observer.disconnect();
  }, []);
  const packScore = useMemo(() => scoreCards(openedCards), [openedCards]);
  // Read as the summary first renders, so a record line shows from the first paint and nothing moves after.
  const others = packChoices ? otherPackChoices(packChoices.sets, set.id, packChoices.collection) : null;
  const record = useMemo(() => (pack ? packRecord(getHistory(), pack, packScore.score) : null), [pack, packScore]);

  return (
    <Motion.div className="pack-summary" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
      <div className="summary-content" ref={contentRef} onFocus={clearActions} onClickCapture={blockClicks}>
        <div className="summary-details">
          <PackHeadline cards={openedCards} headingRef={headingRef} record={record}>
            {pack && <SummaryHallOfFame pack={pack} score={packScore} onOpenRankingsHelp={onOpenRankingsHelp} />}
          </PackHeadline>
          <div className="summary-guide-line">
            {!viewed && <p className="summary-caption">Select a card to view</p>}
            <CardGuideButton set={set} />
          </div>
          <ul className="summary-cards" ref={cardsRef} data-settling={settling || undefined}>
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
                  {/* A tile is small: a finish shows its ready-made thumbnail, and only the up-close view renders it full size (#620). */}
                  <CardImage src={card.image} finish={card.finish} thumbnail alt="" draggable="false" />
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

          {/* Other eras exist: a quiet way into the Packs sheet. It sits between the cards and the stuck actions, so it adds no height to what sticks and the primary stays last. */}
          {packChoices && others && others.count > 0 && (
            <button
              type="button"
              className="summary-try-another btn btn--ghost"
              onClick={packChoices.onOpen}
              aria-haspopup="dialog"
              // The visible words first, then how many there are to choose from.
              aria-label={`Try another pack, ${others.count} other ${others.count === 1 ? 'pack' : 'packs'} to choose from`}
            >
              <span className="summary-try-thumbs" aria-hidden="true">
                {others.preview.map((other) => (
                  <img key={other.id} src={packThumbUrl(other.id)} alt="" width={THUMB_W} height={THUMB_H} draggable="false" />
                ))}
              </span>
              Try another pack
            </button>
          )}

          {/* Right after the result, and stuck to the bottom so they never scroll away. */}
          <div className="summary-actions" ref={actionsRef}>
            {onShare && (
              <button type="button" className="btn btn--secondary btn--lg" onClick={onShare}>
                <Share2 aria-hidden="true" /> Share
              </button>
            )}
            <button type="button" className="btn btn--primary btn--lg" onClick={onClose} {...{ [STAGE_PRIMARY_ATTR]: true }}>
              <RotateCcw aria-hidden="true" /> Open {set.name} again
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

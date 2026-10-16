import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { RotateCcw, Share2 } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import CardViewerModal from '../cards/CardViewerModal';
import CardImage from '../cards/CardImage';
import DeferredSheet from '../ui/DeferredSheet';
import { sheetLoader } from '../ui/sheetEntry';
import BrainrotScorePanel from '../ui/BrainrotScorePanel';
import { modifierLabel, modifierThumb, specialCardsLine } from '../../game/modifiers';
import { CARD_RARITIES, cardNumber, scoreCards } from '../../data/cards';
import type { SetDefinition } from '../../engine';
import { myProgress } from '../../game/profiles';
import type { PullRef } from '../../game/pulls';
import { bestPullOrder } from '../../game/reveal';
import { versionOf } from '../../game/versions';
import { usePackCacheVersion } from '../../hooks/usePackCache';
import { useHoldUntilDecoded } from '../../hooks/useHoldUntilDecoded';
import PackCacheNote from '../profile/PackCacheNote';
import '../../styles/CollectionLabel.css';

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
 * After the last card, result first: the hand as the headline, then the five cards laid out like a
 * pack's contents on a table, best pull first (each with its collector number, rarity, a NEW sticker
 * if it's new, and its own Share for an image of it that links to this pack), then the score and
 * level, with the actions in their own row below. Sharing starts here, never mid-reveal: the link
 * carries the whole pack, so it would spoil the cards still face down.
 */
const PackSummaryUI = ({ openedCards, set, onClose, onShare, pack, holdOptional = false }: PackSummaryUIProps) => {
  const [selected, setSelected] = useState<CardWithMeta | null>(null);
  const [sharing, setSharing] = useState<CardWithMeta | null>(null);
  const shown = useMemo(() => bestPullOrder(openedCards), [openedCards]);
  const cardsRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useHoldUntilDecoded(cardsRef, holdOptional);
  // The keyboard starts at the result, not on an action: the heading, so the cards come next.
  useEffect(() => {
    if (holdOptional) headingRef.current?.focus({ preventScroll: true });
    // Only as it appears; not while a sheet covers it (holdOptional is off then).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { points, hand, score } = scoreCards(openedCards);
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
      <div className="summary-content">
        <div className="summary-details">
          <h2 className="summary-title" ref={headingRef} tabIndex={-1}>{hand.name}</h2>
          <ul className="summary-cards" ref={cardsRef}>
            {shown.map((card) => (
              <li key={card.uniqueId}>
                <button
                  type="button"
                  className={`summary-card ${card.rarity.toLowerCase()} ${card.isHolo ? 'holo' : ''} ${modifierThumb(card).className}`}
                  style={modifierThumb(card).style}
                  onClick={() => setSelected(card)}
                  aria-label={`${card.name}, ${CARD_RARITIES[card.rarity].name}${modifierLabel(card) ? `, ${modifierLabel(card)}` : ''}${card.isNew ? ', new' : ''}`}
                >
                  <CardImage src={card.image} finish={card.finish} alt="" draggable="false" />
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
                    aria-label={`Share or save ${card.name}`}
                  >
                    <Share2 aria-hidden="true" /> Share
                  </button>
                )}
              </li>
            ))}
          </ul>
          {special && <p className="summary-new">{special}</p>}
          {newCount > 0 && (
            <p className="summary-new tabular">
              {newCount} new {newCount === 1 ? 'card' : 'cards'} for your binder
            </p>
          )}
          {/* The hand's name is the heading above the cards, so the panel doesn't repeat it. */}
          <BrainrotScorePanel points={points} multiplier={hand.multiplier} score={score} setId={set.id} />
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
        </div>
      </div>

      {/* After the result, in a row of their own that never scrolls away. */}
      <div className="summary-actions">
        {onShare && (
          <button type="button" className="btn btn--secondary btn--lg" onClick={onShare}>
            <Share2 aria-hidden="true" /> Share
          </button>
        )}
        <button type="button" className="btn btn--primary btn--lg" onClick={onClose}>
          <RotateCcw aria-hidden="true" /> Open another pack
        </button>
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

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { RotateCcw, Share2 } from 'lucide-react';
import type { CardWithMeta } from '../cards/Card';
import CardViewerModal from '../cards/CardViewerModal';
import CardImage from '../cards/CardImage';
import BrainrotScorePanel from '../ui/BrainrotScorePanel';
import { modifierLabel, modifierThumb } from '../../game/modifiers';
import { CARD_RARITIES, getSetCards, scoreCards } from '../../data/cards';
import type { SetDefinition } from '../../engine';
import { myProgress } from '../../game/profiles';
import { usePackCacheVersion } from '../../hooks/usePackCache';
import PackCacheNote from '../profile/PackCacheNote';
import '../../styles/CollectionLabel.css';

const Motion = motion;

interface PackSummaryUIProps {
  openedCards: CardWithMeta[];
  set: SetDefinition;
  onClose: () => void;
  onShare?: () => void;
}

/**
 * After the last card: the hand as the headline, the score, and the five cards laid out like a
 * pack's contents on a table, each with its collector number, rarity and a NEW sticker if it's new.
 */
const PackSummaryUI = ({ openedCards, set, onClose, onShare }: PackSummaryUIProps) => {
  const [selected, setSelected] = useState<CardWithMeta | null>(null);
  const { points, hand, score } = scoreCards(openedCards);
  const setCards = getSetCards(set.id);
  const numberOf = (card: CardWithMeta) => {
    const i = setCards.findIndex((c) => c.key === card.key);
    return `${String(i + 1).padStart(3, '0')}/${String(setCards.length).padStart(3, '0')}`;
  };
  const newCount = openedCards.filter((c) => c.isNew).length;
  // What this pack did for your level: shown here so progress isn't hidden away in the profile.
  // Null until saved packs are read: a loading note then, never zero XP.
  const packCache = usePackCacheVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const progress = useMemo(() => myProgress(), [packCache]);
  const into = progress ? progress.xp - progress.levelXp : 0;
  const span = progress ? progress.nextXp - progress.levelXp : 1;

  return (
    <Motion.div className="pack-summary" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
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

      <div className="summary-content">
        <div className="summary-details">
          <h2 className="summary-title">{hand.name}</h2>
          {/* The hand's name is the heading just above, so the panel doesn't repeat it. */}
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

          <ul className="summary-cards">
            {openedCards.map((card) => (
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
                  {numberOf(card)}{' '}
                  <span className={`collection-label-rarity ${card.rarity.toLowerCase()}`}>{CARD_RARITIES[card.rarity].symbol}</span>
                </span>
              </li>
            ))}
          </ul>
          {newCount > 0 && (
            <p className="summary-new tabular">
              {newCount} new {newCount === 1 ? 'card' : 'cards'} for your binder
            </p>
          )}
        </div>
      </div>

      {selected && (
        <CardViewerModal
          card={selected}
          onClose={() => setSelected(null)}
          canShare
        />
      )}
    </Motion.div>
  );
};

export default PackSummaryUI;

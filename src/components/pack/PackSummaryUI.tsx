import { useState } from 'react';
import { motion } from 'framer-motion';
import BrainrotValuePanel from '../ui/BrainrotValuePanel';
import CardViewerModal from '../cards/CardViewerModal';
import type { CardWithMeta } from '../cards/Card';
import { getCardValue } from '../../data/cards';
import { getPackMultiplier } from '../../utils/poker';

const Motion = motion;

interface PackSummaryUIProps {
  openedCards: CardWithMeta[];
  onClose: () => void;
}

const PackSummaryUI = ({ openedCards, onClose }: PackSummaryUIProps) => {
  const [selectedSummaryCard, setSelectedSummaryCard] = useState<CardWithMeta | null>(null);

  const baseValue = openedCards.reduce((sum, card) => sum + getCardValue(card.rarity, card.isHolo), 0);
  const pokerHand = getPackMultiplier(openedCards);
  const flexValue = baseValue * pokerHand.multiplier;

  return (
    <Motion.div
      className="pack-summary"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
    >
      <h2 className="summary-title">Pack Summary</h2>
      <BrainrotValuePanel
        baseValue={baseValue}
        multiplier={pokerHand.multiplier}
        handName={pokerHand.name}
        flexValue={flexValue}
      />
      <button className="summary-close-btn" onClick={onClose}>
        Open Another Pack
      </button>
      <div className="summary-carousel">
        {openedCards.map((card, index) => {
          const totalCards = openedCards.length;
          const offset = (index - (totalCards - 1) / 2);
          const classes = [
            'summary-card',
            card.rarity.toLowerCase(),
            card.isHolo ? 'holo' : ''
          ].filter(Boolean).join(' ');
          return (
            <div
              key={card.uniqueId}
              className={classes}
              style={{ '--offset': offset } as React.CSSProperties}
              onClick={() => setSelectedSummaryCard(card)}
            >
              <img src={card.image} alt={card.name} />
            </div>
          );
        })}
      </div>

      {/* Card Viewer Modal for summary */}
      {selectedSummaryCard && (
        <CardViewerModal
          card={selectedSummaryCard}
          hasNormal={!selectedSummaryCard.isHolo}
          hasHolo={selectedSummaryCard.isHolo}
          initialHolo={selectedSummaryCard.isHolo}
          onClose={() => setSelectedSummaryCard(null)}
        />
      )}
    </Motion.div>
  );
};

export default PackSummaryUI;

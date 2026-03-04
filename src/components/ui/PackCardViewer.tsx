import { useState } from 'react';
import BrainrotValuePanel from './BrainrotValuePanel';
import CardViewerModal from '../cards/CardViewerModal';
import type { CardWithMeta } from '../cards/Card';
import { getCardValue } from '../../data/cards';
import { getPackMultiplier } from '../../utils/poker';
import '../../styles/PackCardViewer.css';

export type PackDisplayMode = 'carousel' | 'grid';

interface PackCardViewerProps {
    cards: CardWithMeta[];
    displayMode?: PackDisplayMode;
    showValue?: boolean;
    onCardClick?: (card: CardWithMeta) => void;
    className?: string;
}

const PackCardViewer = ({
    cards,
    displayMode = 'carousel',
    showValue = true,
    onCardClick,
    className = '',
}: PackCardViewerProps) => {
    const [selectedCard, setSelectedCard] = useState<CardWithMeta | null>(null);

    const baseValue = cards.reduce((sum, card) => sum + getCardValue(card.rarity, card.isHolo), 0);
    const pokerHand = getPackMultiplier(cards);
    const flexValue = baseValue * pokerHand.multiplier;

    const handleCardClick = (card: CardWithMeta) => {
        if (onCardClick) {
            onCardClick(card);
        } else {
            setSelectedCard(card);
        }
    };

    const getCardClasses = (card: CardWithMeta) => {
        return [
            displayMode === 'carousel' ? 'pack-viewer-card-carousel' : 'pack-viewer-card-grid',
            card.rarity.toLowerCase(),
            card.isHolo ? 'holo' : ''
        ].filter(Boolean).join(' ');
    };

    return (
        <div className={`pack-card-viewer ${className}`}>
            {showValue && (
                <BrainrotValuePanel
                    baseValue={baseValue}
                    multiplier={pokerHand.multiplier}
                    handName={pokerHand.name}
                    flexValue={flexValue}
                />
            )}

            <div className={`pack-viewer-cards pack-viewer-${displayMode}`}>
                {cards.map((card, index) => {
                    const offset = displayMode === 'carousel'
                        ? (index - (cards.length - 1) / 2)
                        : 0;

                    return (
                        <div
                            key={card.uniqueId || index}
                            className={getCardClasses(card)}
                            style={displayMode === 'carousel' ? { '--offset': offset } as React.CSSProperties : undefined}
                            onClick={() => handleCardClick(card)}
                        >
                            <img src={card.image} alt={card.name} />
                        </div>
                    );
                })}
            </div>

            {/* Built-in Card Viewer Modal (only if no custom onCardClick) */}
            {!onCardClick && selectedCard && (
                <CardViewerModal
                    card={selectedCard}
                    hasNormal={!selectedCard.isHolo}
                    hasHolo={selectedCard.isHolo}
                    initialHolo={selectedCard.isHolo}
                    onClose={() => setSelectedCard(null)}
                />
            )}
        </div>
    );
};

export default PackCardViewer;

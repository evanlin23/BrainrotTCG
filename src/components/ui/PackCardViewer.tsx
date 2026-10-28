import { useState } from 'react';
import BrainrotScorePanel from './BrainrotScorePanel';
import PackHeadline from '../pack/PackHeadline';
import CardViewerModal from '../cards/CardViewerModal';
import CardImage from '../cards/CardImage';
import type { CardWithMeta } from '../cards/Card';
import type { SetDefinition } from '../../engine';
import { scoreCards } from '../../data/cards';
import { hydrateCard } from '../../utils/migrations';
import { modifierLabel, modifierThumb } from '../../game/modifiers';
import '../../styles/PackCardViewer.css';

export type PackDisplayMode = 'carousel' | 'grid';

interface PackCardViewerProps {
    cards: CardWithMeta[];
    displayMode?: PackDisplayMode;
    showValue?: boolean;
    onCardClick?: (card: CardWithMeta) => void;
    className?: string;
    /** The player's own pack: its cards can be shared one by one. */
    canShareCards?: boolean;
    /** The set, at the version the pack was opened, whose odds and modifiers the card guide shows (#676). */
    set?: SetDefinition;
    /**
     * A title above already names the combo (a shared pull's "Pair"): the combo headline is left out so the
     * combo and its multiplier read once, the multiplier in the score panel's arithmetic. A pack with no
     * combo (multiplier 1) keeps its own "No Matches" line even when titled.
     */
    titled?: boolean;
}

const PackCardViewer = ({
    cards: storedCards,
    displayMode = 'carousel',
    showValue = true,
    onCardClick,
    className = '',
    canShareCards = false,
    set,
    titled = false,
}: PackCardViewerProps) => {
    const [selectedCard, setSelectedCard] = useState<CardWithMeta | null>(null);

    // Stored packs may carry stale image URLs from an older build; re-resolve them.
    const cards = storedCards.map((card) => hydrateCard(card));
    const { points, hand: pokerHand, score } = scoreCards(cards);

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
                <>
                    {!(titled && pokerHand.multiplier > 1) && <PackHeadline cards={cards} showTotal={false} />}
                    <BrainrotScorePanel
                        points={points}
                        multiplier={pokerHand.multiplier}
                        score={score}
                        set={set}
                        setId={cards[0]?.setId}
                    />
                </>
            )}

            <div className={`pack-viewer-cards pack-viewer-${displayMode}`}>
                {cards.map((card, index) => {
                    const offset = displayMode === 'carousel'
                        ? (index - (cards.length - 1) / 2)
                        : 0;

                    return (
                        <button
                            type="button"
                            key={card.uniqueId || index}
                            className={`${getCardClasses(card)} ${modifierThumb(card).className}`}
                            style={{ ...(displayMode === 'carousel' ? { '--offset': offset } : {}), ...modifierThumb(card).style } as React.CSSProperties}
                            onClick={() => handleCardClick(card)}
                            aria-label={`${card.name}${modifierLabel(card) ? ` (${modifierLabel(card)})` : ''}`}
                        >
                            {card.isHolo && <span className="holo-rainbow-layer" aria-hidden="true" />}
                            <CardImage src={card.image} finish={card.finish} thumbnail alt="" fetchPriority="high" />
                            {modifierLabel(card, false) && <span className="mod-label">{modifierLabel(card, false)}</span>}
                        </button>
                    );
                })}
            </div>

            {/* Built-in Card Viewer Modal (only if no custom onCardClick) */}
            {!onCardClick && selectedCard && (
                <CardViewerModal
                    card={selectedCard}
                    onClose={() => setSelectedCard(null)}
                    canShare={canShareCards}
                />
            )}
        </div>
    );
};

export default PackCardViewer;

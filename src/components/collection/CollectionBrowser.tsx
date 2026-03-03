import { useMemo, useState } from 'react';
import CardViewerModal from '../cards/CardViewerModal';
import { Card, getCardValue, INITIAL_CARDS } from '../../data/cards';
import type { CollectionItem } from '../../types';

interface CollectionBrowserProps {
  collection: Record<string, CollectionItem>;
  onClose: () => void;
}

const CollectionBrowser = ({ collection, onClose }: CollectionBrowserProps) => {
  const [selectedCard, setSelectedCard] = useState<{ card: Card; normalCount: number; holoCount: number } | null>(null);

  const collectionItems = useMemo(() => {
    const rarityOrder: Record<string, number> = {
      BRAINROT: 0,
      LEGENDARY: 1,
      EPIC: 2,
      RARE: 3,
      UNCOMMON: 4,
      COMMON: 5,
    };
    return Object.values(collection)
      .map(item => ({
        ...item,
        normalCount: item.normalCount || 0,
        holoCount: item.holoCount || 0,
      }))
      .filter(item => item && item.card && item.card.rarity)
      .sort(
        (a, b) =>
          (rarityOrder[a.card.rarity] ?? 99) - (rarityOrder[b.card.rarity] ?? 99) ||
          (b.normalCount + b.holoCount) - (a.normalCount + a.holoCount) ||
          a.card.name.localeCompare(b.card.name)
      );
  }, [collection]);

  const totalFound = useMemo(
    () => collectionItems.reduce((sum, item) => sum + item.normalCount + item.holoCount, 0),
    [collectionItems]
  );

  const accountValue = useMemo(() => {
    return collectionItems.reduce((sum, item) => {
      const normalValue = item.normalCount * getCardValue(item.card.rarity, false);
      const holoValue = item.holoCount * getCardValue(item.card.rarity, true);
      return sum + normalValue + holoValue;
    }, 0);
  }, [collectionItems]);

  return (
    <>
      <section className="collection-browser">
        <div className="collection-header">
          <h2>Collection</h2>
          <p>
            {Object.keys(collection).length} / {INITIAL_CARDS.length} unique • {totalFound} total
          </p>
          <p style={{ color: '#ffd700', fontWeight: 'bold', margin: '0.5rem 0' }}>
            Account Value: {accountValue.toLocaleString()} Buhcoins
            {totalFound > 0 && (
              <span style={{ color: '#aaa', fontWeight: 'normal', marginLeft: '0.75rem' }}>
                (Average: {(accountValue / totalFound).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/card)
              </span>
            )}
          </p>
          <button className="collection-close-btn" onClick={onClose}>&times;</button>
        </div>

        {collectionItems.length === 0 ? (
          <p className="collection-empty">Open packs to start your collection.</p>
        ) : (
          <div className="collection-grid">
            {collectionItems.map(({ card, normalCount, holoCount }) => {
              const classes = [
                'collection-item',
                card.rarity.toLowerCase(),
                holoCount > 0 ? 'holo' : ''
              ].filter(Boolean).join(' ');
              return (
                <article
                  key={card.id}
                  className={classes}
                  onClick={() => setSelectedCard({ card, normalCount, holoCount })}
                >
                  <img src={card.image} alt={card.name} />
                  <span className="collection-count">
                    {normalCount > 0 && `x${normalCount}`}
                    {normalCount > 0 && holoCount > 0 && ' • '}
                    {holoCount > 0 && `✨x${holoCount}`}
                  </span>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Card Viewer Modal */}
      {selectedCard && (
        <CardViewerModal
          card={selectedCard.card}
          hasNormal={selectedCard.normalCount > 0}
          hasHolo={selectedCard.holoCount > 0}
          initialHolo={selectedCard.holoCount > 0 && selectedCard.normalCount === 0}
          onClose={() => setSelectedCard(null)}
        />
      )}
    </>
  );
};

export default CollectionBrowser;

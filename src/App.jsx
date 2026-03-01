import React, { useMemo, useState, useEffect } from 'react';
import './styles/index.css';
import PackOpener from './components/PackOpener';
import { INITIAL_CARDS } from './data/cards';
import swedenSrc from './assets/Sweden.mp3';

const COLLECTION_STORAGE_KEY = 'brainrot-found-collection-v1';

const getStoredCollection = () => {
  try {
    const raw = localStorage.getItem(COLLECTION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
};

function App() {
  const [collection, setCollection] = useState(getStoredCollection);
  const [isCollectionOpen, setIsCollectionOpen] = useState(false);

  // Play background music on page load
  useEffect(() => {
    const bgMusic = new Audio(swedenSrc);
    bgMusic.volume = 0.05;
    bgMusic.loop = true;
    bgMusic.play().catch(e => console.log("Background music failed:", e));

    return () => {
      bgMusic.pause();
    };
  }, []);

  const handleCardsOpened = (newCards) => {
    setCollection((prev) => {
      const next = { ...prev };
      newCards.forEach((card) => {
        const existing = next[card.id];
        next[card.id] = {
          card,
          count: existing ? existing.count + 1 : 1,
        };
      });
      localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const collectionItems = useMemo(
    () =>
      Object.values(collection).sort(
        (a, b) => b.count - a.count || a.card.name.localeCompare(b.card.name)
      ),
    [collection]
  );

  const totalFound = useMemo(
    () => collectionItems.reduce((sum, item) => sum + item.count, 0),
    [collectionItems]
  );

  return (
    <div className="app-container">
      <header>
        <h1>
          {"Brainrot TCG".split('').map((char, i) => (
            char === ' ' ? (
              <span key={i} className="title-space" />
            ) : (
              <span
                key={i}
                className="title-char"
                style={{ animationDelay: `${i * 0.08}s` }}
              >
                {char}
              </span>
            )
          ))}
        </h1>
      </header>

      <main>
        <PackOpener onOpen={handleCardsOpened} cards={INITIAL_CARDS} disabled={isCollectionOpen} />
      </main>

      <button
        className="collection-browse-btn"
        onClick={() => setIsCollectionOpen((prev) => !prev)}
      >
        {isCollectionOpen ? 'Hide Collection' : 'Browse Collection'}
      </button>

      {isCollectionOpen && (
        <section className="collection-browser">
          <div className="collection-header">
            <h2>Found Cards</h2>
            <p>
              {Object.keys(collection).length} / {INITIAL_CARDS.length} unique • {totalFound} total
            </p>
          </div>

          {collectionItems.length === 0 ? (
            <p className="collection-empty">Open packs to start your collection.</p>
          ) : (
            <div className="collection-grid">
              {collectionItems.map(({ card, count }) => (
                <article key={card.id} className={`collection-item ${card.rarity.toLowerCase()}`}>
                  <img src={card.image} alt={card.name} />
                  <span className="collection-count">x{count}</span>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default App;

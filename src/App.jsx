import React, { useMemo, useState, useEffect, useCallback } from 'react';
import './styles/index.css';
import PackOpener from './components/PackOpener';
import AchievementNotification from './components/AchievementNotification';
import AchievementsPage from './components/AchievementsPage';
import HallOfFame from './components/HallOfFame';
import { INITIAL_CARDS } from './data/cards';
import { ACHIEVEMENTS, getAchievementById } from './data/achievements';
import swedenSrc from './assets/audio/Sweden.mp3';

const COLLECTION_STORAGE_KEY = 'brainrot-found-collection-v1';
const ACHIEVEMENTS_STORAGE_KEY = 'brainrot-achievements-v1';
const STATS_STORAGE_KEY = 'brainrot-stats-v1';
const HALL_OF_FAME_STORAGE_KEY = 'brainrot-hall-of-fame-v1';

const getStoredData = (key, defaultValue = {}) => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultValue;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultValue;
    return parsed;
  } catch {
    return defaultValue;
  }
};

function App() {
  const [collection, setCollection] = useState(() => getStoredData(COLLECTION_STORAGE_KEY));
  const [achievements, setAchievements] = useState(() => getStoredData(ACHIEVEMENTS_STORAGE_KEY));
  const [stats, setStats] = useState(() => getStoredData(STATS_STORAGE_KEY, { packsOpened: 0, holoCards: {} }));
  const [hallOfFame, setHallOfFame] = useState(() => getStoredData(HALL_OF_FAME_STORAGE_KEY));

  const [isCollectionOpen, setIsCollectionOpen] = useState(false);
  const [isAchievementsOpen, setIsAchievementsOpen] = useState(false);
  const [isHallOfFameOpen, setIsHallOfFameOpen] = useState(false);
  const [notificationQueue, setNotificationQueue] = useState([]);
  const [selectedCard, setSelectedCard] = useState(null);

  // Play background music on page load
  useEffect(() => {
    const bgMusic = new Audio(swedenSrc);
    bgMusic.volume = 0.05;
    bgMusic.loop = true;
    bgMusic.play().catch(() => {});

    return () => {
      bgMusic.pause();
    };
  }, []);

  const unlockAchievement = useCallback((achievementId) => {
    if (achievements[achievementId]) return; // Already unlocked

    const achievement = getAchievementById(achievementId);
    if (!achievement) return;

    const timestamp = Date.now();
    setAchievements(prev => {
      const next = { ...prev, [achievementId]: timestamp };
      localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });

    setNotificationQueue(prev => [...prev, achievement]);
  }, [achievements]);

  const dismissNotification = useCallback((achievementId) => {
    setNotificationQueue(prev => prev.filter(a => a.id !== achievementId));
  }, []);

  const checkAchievements = useCallback((newCards, updatedCollection, updatedStats, updatedHallOfFame) => {
    const newAchievements = [];

    // Pack milestones
    const packsOpened = updatedStats.packsOpened;
    if (packsOpened >= 1 && !achievements.first_pack) newAchievements.push('first_pack');
    if (packsOpened >= 10 && !achievements.packs_10) newAchievements.push('packs_10');
    if (packsOpened >= 41 && !achievements.packs_41) newAchievements.push('packs_41');
    if (packsOpened >= 67 && !achievements.packs_67) newAchievements.push('packs_67');
    if (packsOpened >= 100 && !achievements.packs_100) newAchievements.push('packs_100');
    if (packsOpened >= 420 && !achievements.packs_420) newAchievements.push('packs_420');

    // Rarity discoveries (check new cards in this pack)
    const rarities = new Set(newCards.map(c => c.rarity));
    if (rarities.has('COMMON') && !achievements.first_common) newAchievements.push('first_common');
    if (rarities.has('UNCOMMON') && !achievements.first_uncommon) newAchievements.push('first_uncommon');
    if (rarities.has('RARE') && !achievements.first_rare) newAchievements.push('first_rare');
    if (rarities.has('EPIC') && !achievements.first_epic) newAchievements.push('first_epic');
    if (rarities.has('LEGENDARY') && !achievements.first_legendary) newAchievements.push('first_legendary');
    if (rarities.has('BRAINROT') && !achievements.first_brainrot) newAchievements.push('first_brainrot');

    // First holo
    if (newCards.some(c => c.isHolo) && !achievements.first_holo) newAchievements.push('first_holo');

    // Pack combos
    const cardCounts = {};
    newCards.forEach(c => {
      cardCounts[c.id] = (cardCounts[c.id] || 0) + 1;
    });
    const maxCount = Math.max(...Object.values(cardCounts));

    if (maxCount >= 2 && !achievements.two_of_kind) newAchievements.push('two_of_kind');
    if (maxCount >= 3 && !achievements.three_of_kind) newAchievements.push('three_of_kind');
    if (maxCount >= 4 && !achievements.four_of_kind) newAchievements.push('four_of_kind');
    if (maxCount >= 5 && !achievements.five_of_kind) newAchievements.push('five_of_kind');

    // Full house (3 + 2)
    const counts = Object.values(cardCounts);
    const hasThree = counts.some(c => c >= 3);
    const hasTwo = counts.filter(c => c >= 2).length >= 2 || counts.some(c => c >= 5);
    if (hasThree && hasTwo && !achievements.full_house) newAchievements.push('full_house');

    // All same rarity
    if (new Set(newCards.map(c => c.rarity)).size === 1 && !achievements.all_same_rarity) {
      newAchievements.push('all_same_rarity');
    }

    // Lucky day (2+ legendary or brainrot)
    const luckyCount = newCards.filter(c => c.rarity === 'LEGENDARY' || c.rarity === 'BRAINROT').length;
    if (luckyCount >= 2 && !achievements.lucky_day) newAchievements.push('lucky_day');

    // Collection milestones
    const uniqueCards = Object.keys(updatedCollection).length;
    if (uniqueCards >= 5 && !achievements.collect_5) newAchievements.push('collect_5');
    if (uniqueCards >= 10 && !achievements.collect_10) newAchievements.push('collect_10');
    if (uniqueCards >= INITIAL_CARDS.length && !achievements.complete_collection) {
      newAchievements.push('complete_collection');
    }

    // Holo collector (5 different holo cards)
    const holoCount = Object.keys(updatedStats.holoCards || {}).length;
    if (holoCount >= 5 && !achievements.holo_collector) newAchievements.push('holo_collector');

    // Unlock all new achievements
    newAchievements.forEach(id => unlockAchievement(id));
  }, [achievements, unlockAchievement]);

  const handleCardsOpened = useCallback((newCards) => {
    // Update stats
    const updatedStats = {
      ...stats,
      packsOpened: (stats.packsOpened || 0) + 1,
      holoCards: { ...stats.holoCards }
    };

    // Track holo cards
    newCards.forEach(card => {
      if (card.isHolo) {
        updatedStats.holoCards[card.id] = true;
      }
    });

    setStats(updatedStats);
    localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(updatedStats));

    // Update collection - combine cards but track if holo found
    let updatedCollection;
    setCollection((prev) => {
      const next = { ...prev };

      // Count cards and track holo status
      const packCounts = {};
      const holoFound = {};
      newCards.forEach((card) => {
        packCounts[card.id] = (packCounts[card.id] || 0) + 1;
        if (card.isHolo) {
          holoFound[card.id] = true;
        }
      });

      Object.entries(packCounts).forEach(([cardId, packCount]) => {
        const card = newCards.find(c => c.id === cardId);
        const existing = next[cardId];
        next[cardId] = {
          card,
          count: (existing?.count || 0) + packCount,
          hasHolo: existing?.hasHolo || holoFound[cardId] || false,
        };
      });

      localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(next));
      updatedCollection = next;
      return next;
    });

    // Check Hall of Fame milestones
    let updatedHallOfFame = { ...hallOfFame };
    const cardCounts = {};
    newCards.forEach(c => {
      cardCounts[c.id] = (cardCounts[c.id] || 0) + 1;
    });
    const maxCount = Math.max(...Object.values(cardCounts));

    // First 4 of a kind
    if (maxCount >= 4 && !hallOfFame.first4OfAKind) {
      const cardId = Object.entries(cardCounts).find(([, count]) => count >= 4)?.[0];
      updatedHallOfFame.first4OfAKind = {
        achieved: true,
        date: Date.now(),
        cardId
      };
    }

    // First full house
    const counts = Object.values(cardCounts);
    const hasThree = counts.some(c => c >= 3);
    const hasTwo = counts.filter(c => c >= 2).length >= 2;
    if (hasThree && hasTwo && !hallOfFame.firstFullHouse) {
      updatedHallOfFame.firstFullHouse = {
        achieved: true,
        date: Date.now(),
        cards: cardCounts
      };
    }

    if (updatedHallOfFame !== hallOfFame) {
      setHallOfFame(updatedHallOfFame);
      localStorage.setItem(HALL_OF_FAME_STORAGE_KEY, JSON.stringify(updatedHallOfFame));
    }

    // Check achievements after a short delay to ensure state updates
    setTimeout(() => {
      checkAchievements(newCards, updatedCollection || collection, updatedStats, updatedHallOfFame);
    }, 100);
  }, [stats, hallOfFame, collection, checkAchievements]);

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

  const isAnyModalOpen = isCollectionOpen || isAchievementsOpen || isHallOfFameOpen;

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
        <PackOpener onOpen={handleCardsOpened} cards={INITIAL_CARDS} disabled={isAnyModalOpen} />
      </main>

      {/* Navigation buttons - hidden when any modal is open */}
      {!isAnyModalOpen && (
        <div className="nav-buttons">
          <button
            className="nav-btn"
            onClick={() => setIsHallOfFameOpen(true)}
          >
            Hall of Fame
          </button>
          <button
            className="nav-btn"
            onClick={() => setIsAchievementsOpen(true)}
          >
            Achievements
          </button>
          <button
            className="nav-btn"
            onClick={() => setIsCollectionOpen(true)}
        >
          Collection
          </button>
        </div>
      )}

      {/* Achievement Notifications */}
      {notificationQueue.map((achievement, index) => (
        <AchievementNotification
          key={achievement.id}
          achievement={achievement}
          index={index}
          onDismiss={() => dismissNotification(achievement.id)}
        />
      ))}

      {/* Achievements Page */}
      {isAchievementsOpen && (
        <AchievementsPage
          unlockedAchievements={achievements}
          onClose={() => setIsAchievementsOpen(false)}
        />
      )}

      {/* Hall of Fame Page */}
      {isHallOfFameOpen && (
        <HallOfFame
          onClose={() => setIsHallOfFameOpen(false)}
        />
      )}

      {/* Collection Browser */}
      {isCollectionOpen && (
        <section className="collection-browser">
          <div className="collection-header">
            <h2>Collection</h2>
            <p>
              {Object.keys(collection).length} / {INITIAL_CARDS.length} unique • {totalFound} total
            </p>
            <button className="collection-close-btn" onClick={() => setIsCollectionOpen(false)}>&times;</button>
          </div>

          {collectionItems.length === 0 ? (
            <p className="collection-empty">Open packs to start your collection.</p>
          ) : (
            <div className="collection-grid">
              {collectionItems.map(({ card, count, hasHolo }) => {
                const classes = [
                  'collection-item',
                  card.rarity.toLowerCase(),
                  hasHolo ? 'holo' : ''
                ].filter(Boolean).join(' ');
                return (
                  <article
                    key={card.id}
                    className={classes}
                    onClick={() => setSelectedCard({ card, hasHolo })}
                  >
                    <img src={card.image} alt={card.name} />
                    <span className="collection-count">{hasHolo && '✨ '}x{count}</span>
                  </article>
                );
              })}
            </div>

            )}

          {/* Card Viewer Modal */}
          {selectedCard && (
            <div className="card-viewer-overlay" onClick={() => setSelectedCard(null)}>
              <div className="card-viewer-content" onClick={(e) => e.stopPropagation()}>
                <div className={`card-viewer-card ${selectedCard.card.rarity.toLowerCase()} ${selectedCard.hasHolo ? 'holo' : ''}`}>
                  <img src={selectedCard.card.image} alt={selectedCard.card.name} />
                </div>
                <button className="card-viewer-close" onClick={() => setSelectedCard(null)}>&times;</button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default App;

import { useState, useEffect, useCallback } from 'react';
import './styles/index.css';
import PackOpener from './components/pack/PackOpener';
import AchievementNotification from './components/achievements/AchievementNotification';
import BestPackPage from './components/pages/BestPackPage';
import AchievementsPage from './components/achievements/AchievementsPage';
import HallOfFamePage from './components/pages/HallOfFamePage';
import CollectionBrowser from './components/collection/CollectionBrowser';
import { INITIAL_CARDS, getCardValue } from './data/cards';
import { getAchievementById, Achievement } from './data/achievements';
import { CardWithMeta } from './components/cards/Card';
import { getPackMultiplier } from './utils/poker';
import { getStoredData } from './utils/storage';
import { STORAGE_KEYS } from './constants';
import {
  checkPackMilestones,
  checkCollectionAchievements,
  checkPackAchievements,
  getAccountValue,
  getMaxCopiesOfCard,
} from './utils/achievementChecks';
import type { CollectionItem, Stats, HallOfFameData } from './types';
import swedenSrc from './assets/audio/Sweden.mp3';

function App() {
  const [collection, setCollection] = useState<Record<string, CollectionItem>>(() => getStoredData(STORAGE_KEYS.COLLECTION, {}));
  const [achievements, setAchievements] = useState<Record<string, number>>(() => getStoredData(STORAGE_KEYS.ACHIEVEMENTS, {}));
  const [stats, setStats] = useState<Stats>(() => getStoredData(STORAGE_KEYS.STATS, { packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
  const [hallOfFame, setHallOfFame] = useState<HallOfFameData>(() => getStoredData(STORAGE_KEYS.HALL_OF_FAME, {}));

  const [isCollectionOpen, setIsCollectionOpen] = useState(false);
  const [isAchievementsOpen, setIsAchievementsOpen] = useState(false);
  const [isHallOfFameOpen, setIsHallOfFameOpen] = useState(false);
  const [isBestPackOpen, setIsBestPackOpen] = useState(false);
  const [notificationQueue, setNotificationQueue] = useState<Achievement[]>([]);

  // Play background music on page load
  useEffect(() => {
    const bgMusic = new Audio(swedenSrc);
    bgMusic.volume = 0.05;
    bgMusic.loop = true;
    bgMusic.play().catch(() => { });

    return () => {
      bgMusic.pause();
    };
  }, []);

  // Check retroactive achievements on mount
  useEffect(() => {
    // Use shared achievement checking functions
    const packAchievements = checkPackMilestones(stats.packsOpened || 0, achievements);
    const collectionAchievements = checkCollectionAchievements(collection, stats, achievements);

    const retroactiveAchievements = [...packAchievements, ...collectionAchievements];

    // Apply retroactive achievements (without notifications to avoid spam on load)
    if (retroactiveAchievements.length > 0) {
      const timestamp = Date.now();
      setAchievements(prev => {
        const next = { ...prev };
        retroactiveAchievements.forEach(id => {
          if (!next[id]) next[id] = timestamp;
        });
        localStorage.setItem(STORAGE_KEYS.ACHIEVEMENTS, JSON.stringify(next));
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  const unlockAchievement = useCallback((achievementId: string) => {
    if (achievements[achievementId]) return; // Already unlocked

    const achievement = getAchievementById(achievementId);
    if (!achievement) return;

    const timestamp = Date.now();
    setAchievements(prev => {
      const next = { ...prev, [achievementId]: timestamp };
      localStorage.setItem(STORAGE_KEYS.ACHIEVEMENTS, JSON.stringify(next));
      return next;
    });

    setNotificationQueue(prev => [...prev, achievement]);
  }, [achievements]);

  const dismissNotification = useCallback((achievementId: string) => {
    setNotificationQueue(prev => prev.filter(a => a.id !== achievementId));
  }, []);

  const checkAllAchievements = useCallback((newCards: CardWithMeta[], updatedCollection: Record<string, CollectionItem>, updatedStats: Stats) => {
    // Use shared achievement checking functions
    const packMilestones = checkPackMilestones(updatedStats.packsOpened, achievements);
    const collectionAchievements = checkCollectionAchievements(updatedCollection, updatedStats, achievements);
    const packAchievements = checkPackAchievements(newCards, achievements);

    // Combine all achievements and unlock them
    const allNewAchievements = [...packMilestones, ...collectionAchievements, ...packAchievements];
    allNewAchievements.forEach(id => unlockAchievement(id));
  }, [achievements, unlockAchievement]);

  const handleCardsOpened = useCallback((newCards: CardWithMeta[]) => {
    // Calculate pack value
    const packValue = newCards.reduce((sum, card) => sum + getCardValue(card.rarity, card.isHolo), 0);
    const pokerHand = getPackMultiplier(newCards);
    const flexValue = packValue * pokerHand.multiplier;

    // Update stats using functional update to avoid stale closure
    let updatedStats: Stats = stats;
    setStats(prev => {
      const newStats: Stats = {
        ...prev,
        packsOpened: (prev.packsOpened || 0) + 1,
        holoCards: { ...prev.holoCards }
      };

      // Update highest pack value - compare against previous state
      if (flexValue > (prev.highestPackFlexValue || prev.highestPackValue || 0)) {
        newStats.highestPackFlexValue = flexValue;
        newStats.highestPackBaseValue = packValue;
        newStats.highestPackMultiplier = pokerHand.multiplier;
        newStats.highestPackHandName = pokerHand.name;
        newStats.highestPackCards = newCards;
      }

      // Track holo cards
      newCards.forEach(card => {
        if (card.isHolo) {
          newStats.holoCards[card.id] = true;
        }
      });

      localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(newStats));
      updatedStats = newStats;
      return newStats;
    });

    // Update collection - track holo and normal counts separately
    let updatedCollection: Record<string, CollectionItem> = {};
    setCollection((prev) => {
      const next = { ...prev };

      // Count normal and holo cards separately
      const normalCounts: Record<string, number> = {};
      const holoCounts: Record<string, number> = {};
      newCards.forEach((card) => {
        if (card.isHolo) {
          holoCounts[card.id] = (holoCounts[card.id] || 0) + 1;
        } else {
          normalCounts[card.id] = (normalCounts[card.id] || 0) + 1;
        }
      });

      // Get all unique card IDs from this pack
      const cardIds = new Set(newCards.map(c => c.id));
      cardIds.forEach((cardId) => {
        const card = newCards.find(c => c.id === cardId);
        if (!card) return;
        const existing = next[cardId];
        next[cardId] = {
          card: { id: card.id, name: card.name, rarity: card.rarity, image: card.image },
          normalCount: (existing?.normalCount || 0) + (normalCounts[cardId] || 0),
          holoCount: (existing?.holoCount || 0) + (holoCounts[cardId] || 0),
        };
      });

      localStorage.setItem(STORAGE_KEYS.COLLECTION, JSON.stringify(next));
      updatedCollection = next;
      return next;
    });

    // Check Hall of Fame milestones
    let updatedHallOfFame = { ...hallOfFame };
    const cardCounts: Record<string, number> = {};
    newCards.forEach(c => {
      cardCounts[c.id] = (cardCounts[c.id] || 0) + 1;
    });
    const maxCount = Math.max(...Object.values(cardCounts));

    // First 4 of a kind
    if (maxCount >= 4 && !hallOfFame.first4OfAKind) {
      const cardId = Object.entries(cardCounts).find(([, count]) => count >= 4)?.[0];
      if (cardId) {
        updatedHallOfFame.first4OfAKind = {
          achieved: true,
          date: Date.now(),
          cardId
        };
      }
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
      localStorage.setItem(STORAGE_KEYS.HALL_OF_FAME, JSON.stringify(updatedHallOfFame));
    }

    // Check achievements after a short delay to ensure state updates
    setTimeout(() => {
      // Create newAchievements array for pack value to add manually
      const newAchievements: string[] = [];
      if (flexValue === 5 && !achievements.pack_value_5) newAchievements.push('pack_value_5');
      if (flexValue >= 50 && !achievements.pack_value_50) newAchievements.push('pack_value_50');
      if (flexValue >= 100 && !achievements.pack_value_100) newAchievements.push('pack_value_100');
      if (flexValue >= 500 && !achievements.pack_value_500) newAchievements.push('pack_value_500');
      if (flexValue >= 1000 && !achievements.pack_value_1000) newAchievements.push('pack_value_1000');
      if (flexValue >= 2000 && !achievements.pack_value_2000) newAchievements.push('pack_value_2000');
      if (flexValue >= 3000 && !achievements.pack_value_3000) newAchievements.push('pack_value_3000');
      if (flexValue >= 4000 && !achievements.pack_value_4000) newAchievements.push('pack_value_4000');
      if (flexValue >= 5000 && !achievements.pack_value_5000) newAchievements.push('pack_value_5000');
      if (flexValue >= 6000 && !achievements.pack_value_6000) newAchievements.push('pack_value_6000');
      if (flexValue >= 7000 && !achievements.pack_value_7000) newAchievements.push('pack_value_7000');
      if (flexValue >= 8000 && !achievements.pack_value_8000) newAchievements.push('pack_value_8000');
      if (flexValue >= 9000 && !achievements.pack_value_9000) newAchievements.push('pack_value_9000');
      if (flexValue >= 10000 && !achievements.pack_value_10000) newAchievements.push('pack_value_10000');
      if (flexValue >= 10000000 && !achievements.pack_value_max) newAchievements.push('pack_value_max');
      newAchievements.forEach(id => unlockAchievement(id));

      checkAllAchievements(newCards, updatedCollection || collection, updatedStats);
    }, 100);
  }, [hallOfFame, collection, checkAllAchievements]);

  const isAnyModalOpen = isCollectionOpen || isAchievementsOpen || isHallOfFameOpen || isBestPackOpen;

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
            onClick={() => setIsBestPackOpen(true)}
          >
            Best Pack
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
        <HallOfFamePage
          onClose={() => setIsHallOfFameOpen(false)}
        />
      )}

      {/* Best Pack Page */}
      {isBestPackOpen && (
        <BestPackPage
          stats={stats}
          onClose={() => setIsBestPackOpen(false)}
        />
      )}

      {/* Collection Browser */}
      {isCollectionOpen && (
        <CollectionBrowser
          collection={collection}
          onClose={() => setIsCollectionOpen(false)}
        />
      )}
    </div>
  );
}

export default App;

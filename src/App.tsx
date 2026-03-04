import { useState, useEffect, useCallback, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import './styles/index.css';
import PackOpener from './components/pack/PackOpener';
import AchievementNotification from './components/achievements/AchievementNotification';
import BestPackPage from './components/pages/BestPackPage';
import AchievementsPage from './components/achievements/AchievementsPage';
import HallOfFamePage from './components/pages/HallOfFamePage';
import SettingsPage from './components/pages/SettingsPage';
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
} from './utils/achievementChecks';
import type { CollectionItem, Stats, HallOfFameData, Settings, AchievementData } from './types';
import swedenSrc from './assets/audio/Sweden.mp3';

const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  particlesEnabled: true,
};

function App() {
  const [collection, setCollection] = useState<Record<string, CollectionItem>>(() => getStoredData(STORAGE_KEYS.COLLECTION, {}));
  const [achievements, setAchievements] = useState<Record<string, AchievementData | number>>(() => getStoredData(STORAGE_KEYS.ACHIEVEMENTS, {}));
  const [stats, setStats] = useState<Stats>(() => getStoredData(STORAGE_KEYS.STATS, { packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
  const [hallOfFame, setHallOfFame] = useState<HallOfFameData>(() => getStoredData(STORAGE_KEYS.HALL_OF_FAME, {}));

  const [settings, setSettings] = useState<Settings>(() => getStoredData(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS));

  const [isCollectionOpen, setIsCollectionOpen] = useState(false);
  const [isAchievementsOpen, setIsAchievementsOpen] = useState(false);
  const [isHallOfFameOpen, setIsHallOfFameOpen] = useState(false);
  const [isBestPackOpen, setIsBestPackOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [notificationQueue, setNotificationQueue] = useState<Achievement[]>([]);
  const [currentPack, setCurrentPack] = useState<CardWithMeta[] | null>(null);

  const bgMusicRef = useRef<HTMLAudioElement | null>(null);

  // Play background music on page load
  useEffect(() => {
    const bgMusic = new Audio(swedenSrc);
    bgMusic.volume = 0.05;
    bgMusic.loop = true;
    bgMusicRef.current = bgMusic;

    if (settings.soundEnabled) {
      bgMusic.play().catch(() => { });
    }

    return () => {
      bgMusic.pause();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle sound toggle for background music
  useEffect(() => {
    if (bgMusicRef.current) {
      if (settings.soundEnabled) {
        bgMusicRef.current.play().catch(() => { });
      } else {
        bgMusicRef.current.pause();
      }
    }
  }, [settings.soundEnabled]);

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

  const unlockAchievement = useCallback((achievementId: string, pack?: CardWithMeta[]) => {
    const achievement = getAchievementById(achievementId);
    if (!achievement) return;

    let wasUnlocked = false;
    setAchievements(prev => {
      // Check inside functional update to avoid stale closure
      if (prev[achievementId]) return prev;

      wasUnlocked = true;
      const achievementData: AchievementData = {
        unlockedAt: Date.now(),
        pack: pack,
      };
      const next = { ...prev, [achievementId]: achievementData };
      localStorage.setItem(STORAGE_KEYS.ACHIEVEMENTS, JSON.stringify(next));
      return next;
    });

    // Only add to notification queue if we actually unlocked it
    // Use setTimeout to ensure state has updated
    setTimeout(() => {
      if (wasUnlocked) {
        setNotificationQueue(prev => {
          // Prevent duplicates in queue
          if (prev.some(a => a.id === achievementId)) return prev;
          return [...prev, achievement];
        });
      }
    }, 0);
  }, []);

  const dismissNotification = useCallback((achievementId: string) => {
    setNotificationQueue(prev => prev.filter(a => a.id !== achievementId));
  }, []);

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(newSettings));
  }, []);

  const handleImportSave = useCallback((data: string) => {
    try {
      const saveData = JSON.parse(data);

      // Validate save data structure
      if (!saveData.version || !saveData.exportedAt) {
        alert('Invalid save file format');
        return;
      }

      // Import each piece of data
      if (saveData.collection) {
        const collectionData = JSON.parse(saveData.collection);
        localStorage.setItem(STORAGE_KEYS.COLLECTION, saveData.collection);
        setCollection(collectionData);
      }
      if (saveData.achievements) {
        const achievementsData = JSON.parse(saveData.achievements);
        localStorage.setItem(STORAGE_KEYS.ACHIEVEMENTS, saveData.achievements);
        setAchievements(achievementsData);
      }
      if (saveData.stats) {
        const statsData = JSON.parse(saveData.stats);
        localStorage.setItem(STORAGE_KEYS.STATS, saveData.stats);
        setStats(statsData);
      }
      if (saveData.hallOfFame) {
        const hallOfFameData = JSON.parse(saveData.hallOfFame);
        localStorage.setItem(STORAGE_KEYS.HALL_OF_FAME, saveData.hallOfFame);
        setHallOfFame(hallOfFameData);
      }
      if (saveData.settings) {
        const settingsData = JSON.parse(saveData.settings);
        localStorage.setItem(STORAGE_KEYS.SETTINGS, saveData.settings);
        setSettings(settingsData);
      }

      alert('Save imported successfully!');
    } catch {
      alert('Failed to import save file. Please check the file format.');
    }
  }, []);

  const checkAllAchievements = useCallback((newCards: CardWithMeta[], updatedCollection: Record<string, CollectionItem>, updatedStats: Stats, currentAchievements: Record<string, AchievementData | number>) => {
    // Use shared achievement checking functions - pass current achievements to avoid stale state
    const packMilestones = checkPackMilestones(updatedStats.packsOpened, currentAchievements);
    const collectionAchievements = checkCollectionAchievements(updatedCollection, updatedStats, currentAchievements);
    const packAchievements = checkPackAchievements(newCards, currentAchievements);

    // Combine all achievements and unlock them with the pack data
    const allNewAchievements = [...packMilestones, ...collectionAchievements, ...packAchievements];
    allNewAchievements.forEach(id => unlockAchievement(id, newCards));
  }, [unlockAchievement]);

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

    // Store current pack for achievement viewing
    setCurrentPack(newCards);

    // Check pack value achievements - unlockAchievement handles duplicates internally
    const packValueAchievements: string[] = [];
    if (flexValue === 5) packValueAchievements.push('pack_value_5');
    if (flexValue >= 50) packValueAchievements.push('pack_value_50');
    if (flexValue >= 100) packValueAchievements.push('pack_value_100');
    if (flexValue >= 500) packValueAchievements.push('pack_value_500');
    if (flexValue >= 1000) packValueAchievements.push('pack_value_1000');
    if (flexValue >= 2000) packValueAchievements.push('pack_value_2000');
    if (flexValue >= 3000) packValueAchievements.push('pack_value_3000');
    if (flexValue >= 4000) packValueAchievements.push('pack_value_4000');
    if (flexValue >= 5000) packValueAchievements.push('pack_value_5000');
    if (flexValue >= 6000) packValueAchievements.push('pack_value_6000');
    if (flexValue >= 7000) packValueAchievements.push('pack_value_7000');
    if (flexValue >= 8000) packValueAchievements.push('pack_value_8000');
    if (flexValue >= 9000) packValueAchievements.push('pack_value_9000');
    if (flexValue >= 10000) packValueAchievements.push('pack_value_10000');
    if (flexValue >= 10000000) packValueAchievements.push('pack_value_max');
    packValueAchievements.forEach(id => unlockAchievement(id, newCards));

    // Check other achievements - get current state to avoid stale closure
    setAchievements(currentAchievements => {
      checkAllAchievements(newCards, updatedCollection || collection, updatedStats, currentAchievements);
      return currentAchievements;
    });
  }, [hallOfFame, collection, checkAllAchievements, unlockAchievement]);

  const isAnyModalOpen = isCollectionOpen || isAchievementsOpen || isHallOfFameOpen || isBestPackOpen || isSettingsOpen;

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
        <PackOpener onOpen={handleCardsOpened} cards={INITIAL_CARDS} disabled={isAnyModalOpen} settings={settings} />
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
          <button
            className="nav-btn"
            onClick={() => setIsSettingsOpen(true)}
          >
            Settings
          </button>
        </div>
      )}

      {/* Achievement Notifications */}
      <AnimatePresence>
        {notificationQueue.map((achievement, index) => (
          <AchievementNotification
            key={achievement.id}
            achievement={achievement}
            index={index}
            onDismiss={() => dismissNotification(achievement.id)}
          />
        ))}
      </AnimatePresence>

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

      {/* Settings Page */}
      {isSettingsOpen && (
        <SettingsPage
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onClose={() => setIsSettingsOpen(false)}
          onImportSave={handleImportSave}
        />
      )}
    </div>
  );
}

export default App;

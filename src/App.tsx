import { useMemo, useState, useEffect, useCallback } from 'react';
import './styles/index.css';
import PackOpener from './components/PackOpener';
import AchievementNotification from './components/AchievementNotification';
import BestPackPage from './components/BestPackPage';
import AchievementsPage from './components/AchievementsPage';
import HallOfFame from './components/HallOfFame';
import CardViewerModal from './components/CardViewerModal';
import { INITIAL_CARDS, Card, getCardValue } from './data/cards';
import { ACHIEVEMENTS, getAchievementById, Achievement } from './data/achievements';
import { CardWithMeta } from './components/Card';
import { getPackMultiplier, PokerHandResult } from './utils/poker';
import swedenSrc from './assets/audio/Sweden.mp3';

const COLLECTION_STORAGE_KEY = 'brainrot-found-collection-v1';
const ACHIEVEMENTS_STORAGE_KEY = 'brainrot-achievements-v1';
const STATS_STORAGE_KEY = 'brainrot-stats-v1';
const HALL_OF_FAME_STORAGE_KEY = 'brainrot-hall-of-fame-v1';

interface CollectionItem {
  card: Card;
  normalCount: number;
  holoCount: number;
}

interface Stats {
  packsOpened: number;
  holoCards: Record<string, boolean>;
  highestPackValue?: number; // legacy
  highestPackFlexValue?: number;
  highestPackBaseValue?: number;
  highestPackMultiplier?: number;
  highestPackHandName?: string;
  highestPackCards?: CardWithMeta[];
}

interface HallOfFameData {
  first4OfAKind?: {
    achieved: boolean;
    date: number;
    cardId: string;
  };
  firstFullHouse?: {
    achieved: boolean;
    date: number;
    cards: Record<string, number>;
  };
}

const getStoredData = <T,>(key: string, defaultValue: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultValue;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultValue;
    return parsed as T;
  } catch {
    return defaultValue;
  }
};

function App() {
  const [collection, setCollection] = useState<Record<string, CollectionItem>>(() => getStoredData(COLLECTION_STORAGE_KEY, {}));
  const [achievements, setAchievements] = useState<Record<string, number>>(() => getStoredData(ACHIEVEMENTS_STORAGE_KEY, {}));
  const [stats, setStats] = useState<Stats>(() => getStoredData(STATS_STORAGE_KEY, { packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
  const [hallOfFame, setHallOfFame] = useState<HallOfFameData>(() => getStoredData(HALL_OF_FAME_STORAGE_KEY, {}));

  const [isCollectionOpen, setIsCollectionOpen] = useState(false);
  const [isAchievementsOpen, setIsAchievementsOpen] = useState(false);
  const [isHallOfFameOpen, setIsHallOfFameOpen] = useState(false);
  const [isBestPackOpen, setIsBestPackOpen] = useState(false);
  const [notificationQueue, setNotificationQueue] = useState<Achievement[]>([]);
  const [selectedCard, setSelectedCard] = useState<{ card: Card; normalCount: number; holoCount: number } | null>(null);

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
    const retroactiveAchievements: string[] = [];

    // Pack milestones (retroactive)
    const packsOpened = stats.packsOpened || 0;
    if (packsOpened >= 1 && !achievements.first_pack) retroactiveAchievements.push('first_pack');
    if (packsOpened >= 10 && !achievements.packs_10) retroactiveAchievements.push('packs_10');
    if (packsOpened >= 41 && !achievements.packs_41) retroactiveAchievements.push('packs_41');
    if (packsOpened >= 67 && !achievements.packs_67) retroactiveAchievements.push('packs_67');
    if (packsOpened >= 100 && !achievements.packs_100) retroactiveAchievements.push('packs_100');
    if (packsOpened >= 420 && !achievements.packs_420) retroactiveAchievements.push('packs_420');
    if (packsOpened >= 1000 && !achievements.packs_1000) retroactiveAchievements.push('packs_1000');

    // Collection milestones (retroactive)
    const uniqueCards = Object.keys(collection).length;
    if (uniqueCards >= 5 && !achievements.collect_5) retroactiveAchievements.push('collect_5');
    if (uniqueCards >= 10 && !achievements.collect_10) retroactiveAchievements.push('collect_10');
    if (uniqueCards >= INITIAL_CARDS.length && !achievements.complete_collection) {
      retroactiveAchievements.push('complete_collection');
    }

    // Holo collection (retroactive)
    const holoCount = Object.keys(stats.holoCards || {}).length;
    if (holoCount >= 5 && !achievements.holo_collector) retroactiveAchievements.push('holo_collector');
    if (holoCount >= 10 && !achievements.holo_10) retroactiveAchievements.push('holo_10');
    if (holoCount >= INITIAL_CARDS.length && !achievements.holo_complete) {
      retroactiveAchievements.push('holo_complete');
    }

    // Check for holo legendary/brainrot in stats
    const holoCards = stats.holoCards || {};
    Object.keys(holoCards).forEach(cardId => {
      const card = INITIAL_CARDS.find(c => c.id === cardId);
      if (card?.rarity === 'LEGENDARY' && !achievements.holo_legendary) {
        retroactiveAchievements.push('holo_legendary');
      }
      if (card?.rarity === 'BRAINROT' && !achievements.holo_brainrot) {
        retroactiveAchievements.push('holo_brainrot');
      }
    });

    // Rarity discoveries (retroactive based on collection)
    const collectedRarities = new Set(Object.values(collection).map(item => item.card.rarity));
    if (collectedRarities.has('COMMON') && !achievements.first_common) retroactiveAchievements.push('first_common');
    if (collectedRarities.has('UNCOMMON') && !achievements.first_uncommon) retroactiveAchievements.push('first_uncommon');
    if (collectedRarities.has('RARE') && !achievements.first_rare) retroactiveAchievements.push('first_rare');
    if (collectedRarities.has('EPIC') && !achievements.first_epic) retroactiveAchievements.push('first_epic');
    if (collectedRarities.has('LEGENDARY') && !achievements.first_legendary) retroactiveAchievements.push('first_legendary');
    if (collectedRarities.has('BRAINROT') && !achievements.first_brainrot) retroactiveAchievements.push('first_brainrot');

    // First holo (retroactive)
    if (holoCount > 0 && !achievements.first_holo) retroactiveAchievements.push('first_holo');

    // Rarity completion (retroactive)
    const collectedByRarity = {
      COMMON: [] as string[],
      UNCOMMON: [] as string[],
      RARE: [] as string[],
      EPIC: [] as string[],
      LEGENDARY: [] as string[],
      BRAINROT: [] as string[],
    };
    Object.values(collection).forEach(item => {
      collectedByRarity[item.card.rarity].push(item.card.id);
    });

    const cardsByRarity = {
      COMMON: INITIAL_CARDS.filter(c => c.rarity === 'COMMON').length,
      UNCOMMON: INITIAL_CARDS.filter(c => c.rarity === 'UNCOMMON').length,
      RARE: INITIAL_CARDS.filter(c => c.rarity === 'RARE').length,
      EPIC: INITIAL_CARDS.filter(c => c.rarity === 'EPIC').length,
      LEGENDARY: INITIAL_CARDS.filter(c => c.rarity === 'LEGENDARY').length,
      BRAINROT: INITIAL_CARDS.filter(c => c.rarity === 'BRAINROT').length,
    };

    if (collectedByRarity.COMMON.length >= cardsByRarity.COMMON && cardsByRarity.COMMON > 0 && !achievements.all_commons) {
      retroactiveAchievements.push('all_commons');
    }
    if (collectedByRarity.UNCOMMON.length >= cardsByRarity.UNCOMMON && cardsByRarity.UNCOMMON > 0 && !achievements.all_uncommons) {
      retroactiveAchievements.push('all_uncommons');
    }
    if (collectedByRarity.RARE.length >= cardsByRarity.RARE && cardsByRarity.RARE > 0 && !achievements.all_rares) {
      retroactiveAchievements.push('all_rares');
    }
    if (collectedByRarity.EPIC.length >= cardsByRarity.EPIC && cardsByRarity.EPIC > 0 && !achievements.all_epics) {
      retroactiveAchievements.push('all_epics');
    }
    if (collectedByRarity.LEGENDARY.length >= cardsByRarity.LEGENDARY && cardsByRarity.LEGENDARY > 0 && !achievements.all_legendaries) {
      retroactiveAchievements.push('all_legendaries');
    }
    if (collectedByRarity.BRAINROT.length >= cardsByRarity.BRAINROT && cardsByRarity.BRAINROT > 0 && !achievements.all_brainrots) {
      retroactiveAchievements.push('all_brainrots');
    }

    // Apply retroactive achievements (without notifications to avoid spam on load)
    if (retroactiveAchievements.length > 0) {
      const timestamp = Date.now();
      setAchievements(prev => {
        const next = { ...prev };
        retroactiveAchievements.forEach(id => {
          if (!next[id]) next[id] = timestamp;
        });
        localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify(next));
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
      localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });

    setNotificationQueue(prev => [...prev, achievement]);
  }, [achievements]);

  const dismissNotification = useCallback((achievementId: string) => {
    setNotificationQueue(prev => prev.filter(a => a.id !== achievementId));
  }, []);

  const checkAchievements = useCallback((newCards: CardWithMeta[], updatedCollection: Record<string, CollectionItem>, updatedStats: Stats) => {
    const newAchievements: string[] = [];

    // Pack milestones
    const packsOpened = updatedStats.packsOpened;
    if (packsOpened >= 1 && !achievements.first_pack) newAchievements.push('first_pack');
    if (packsOpened >= 10 && !achievements.packs_10) newAchievements.push('packs_10');
    if (packsOpened >= 41 && !achievements.packs_41) newAchievements.push('packs_41');
    if (packsOpened >= 67 && !achievements.packs_67) newAchievements.push('packs_67');
    if (packsOpened >= 100 && !achievements.packs_100) newAchievements.push('packs_100');
    if (packsOpened >= 420 && !achievements.packs_420) newAchievements.push('packs_420');
    if (packsOpened >= 1000 && !achievements.packs_1000) newAchievements.push('packs_1000');

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
    const cardCounts: Record<string, number> = {};
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

    // 5 different rarities in one pack
    if (rarities.size >= 5 && !achievements.five_rarities) newAchievements.push('five_rarities');

    // No commons in pack
    if (!rarities.has('COMMON') && newCards.length === 5 && !achievements.no_commons) {
      newAchievements.push('no_commons');
    }

    // Holo pack achievements
    const holosInPack = newCards.filter(c => c.isHolo).length;
    if (holosInPack >= 2 && !achievements.double_holo) newAchievements.push('double_holo');
    if (holosInPack >= 5 && !achievements.all_holos) newAchievements.push('all_holos');

    // Holo + rarity combos in this pack
    const holoLegendary = newCards.some(c => c.isHolo && c.rarity === 'LEGENDARY');
    const holoBrainrot = newCards.some(c => c.isHolo && c.rarity === 'BRAINROT');
    if (holoLegendary && !achievements.holo_legendary) newAchievements.push('holo_legendary');
    if (holoBrainrot && !achievements.holo_brainrot) newAchievements.push('holo_brainrot');

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

    // Holo collection milestones
    const holoCount = Object.keys(updatedStats.holoCards || {}).length;
    if (holoCount >= 5 && !achievements.holo_collector) newAchievements.push('holo_collector');
    if (holoCount >= 10 && !achievements.holo_10) newAchievements.push('holo_10');
    if (holoCount >= INITIAL_CARDS.length && !achievements.holo_complete) {
      newAchievements.push('holo_complete');
    }

    // Rarity completion achievements
    const collectedByRarity = {
      COMMON: [] as string[],
      UNCOMMON: [] as string[],
      RARE: [] as string[],
      EPIC: [] as string[],
      LEGENDARY: [] as string[],
      BRAINROT: [] as string[],
    };
    Object.values(updatedCollection).forEach(item => {
      collectedByRarity[item.card.rarity].push(item.card.id);
    });

    const cardsByRarity = {
      COMMON: INITIAL_CARDS.filter(c => c.rarity === 'COMMON').length,
      UNCOMMON: INITIAL_CARDS.filter(c => c.rarity === 'UNCOMMON').length,
      RARE: INITIAL_CARDS.filter(c => c.rarity === 'RARE').length,
      EPIC: INITIAL_CARDS.filter(c => c.rarity === 'EPIC').length,
      LEGENDARY: INITIAL_CARDS.filter(c => c.rarity === 'LEGENDARY').length,
      BRAINROT: INITIAL_CARDS.filter(c => c.rarity === 'BRAINROT').length,
    };

    if (collectedByRarity.COMMON.length >= cardsByRarity.COMMON && cardsByRarity.COMMON > 0 && !achievements.all_commons) {
      newAchievements.push('all_commons');
    }
    if (collectedByRarity.UNCOMMON.length >= cardsByRarity.UNCOMMON && cardsByRarity.UNCOMMON > 0 && !achievements.all_uncommons) {
      newAchievements.push('all_uncommons');
    }
    if (collectedByRarity.RARE.length >= cardsByRarity.RARE && cardsByRarity.RARE > 0 && !achievements.all_rares) {
      newAchievements.push('all_rares');
    }
    if (collectedByRarity.EPIC.length >= cardsByRarity.EPIC && cardsByRarity.EPIC > 0 && !achievements.all_epics) {
      newAchievements.push('all_epics');
    }
    if (collectedByRarity.LEGENDARY.length >= cardsByRarity.LEGENDARY && cardsByRarity.LEGENDARY > 0 && !achievements.all_legendaries) {
      newAchievements.push('all_legendaries');
    }
    if (collectedByRarity.BRAINROT.length >= cardsByRarity.BRAINROT && cardsByRarity.BRAINROT > 0 && !achievements.all_brainrots) {
      newAchievements.push('all_brainrots');
    }

    // Unlock all new achievements
    newAchievements.forEach(id => unlockAchievement(id));
  }, [achievements, unlockAchievement]);

  const handleCardsOpened = useCallback((newCards: CardWithMeta[]) => {
    // Calculate pack value
    const packValue = newCards.reduce((sum, card) => sum + getCardValue(card.rarity, card.isHolo), 0);
    const pokerHand = getPackMultiplier(newCards);
    const flexValue = packValue * pokerHand.multiplier;

    // Update stats
    const updatedStats: Stats = {
      ...stats,
      packsOpened: (stats.packsOpened || 0) + 1,
      holoCards: { ...stats.holoCards }
    };

    // Update highest pack value
    if (flexValue > (stats.highestPackFlexValue || stats.highestPackValue || 0)) {
      updatedStats.highestPackFlexValue = flexValue;
      updatedStats.highestPackBaseValue = packValue;
      updatedStats.highestPackMultiplier = pokerHand.multiplier;
      updatedStats.highestPackHandName = pokerHand.name;
      updatedStats.highestPackCards = newCards;
    }

    // Track holo cards
    newCards.forEach(card => {
      if (card.isHolo) {
        updatedStats.holoCards[card.id] = true;
      }
    });

    setStats(updatedStats);
    localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(updatedStats));

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

      localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(next));
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
      localStorage.setItem(HALL_OF_FAME_STORAGE_KEY, JSON.stringify(updatedHallOfFame));
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

      checkAchievements(newCards, updatedCollection || collection, updatedStats);
    }, 100);
  }, [stats, hallOfFame, collection, checkAchievements]);

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
        <HallOfFame
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
            <button className="collection-close-btn" onClick={() => setIsCollectionOpen(false)}>&times;</button>
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
      )}

      {/* Card Viewer Modal - outside collection-browser for proper positioning */}
      {selectedCard && (
        <CardViewerModal
          card={selectedCard.card}
          hasNormal={selectedCard.normalCount > 0}
          hasHolo={selectedCard.holoCount > 0}
          initialHolo={selectedCard.holoCount > 0 && selectedCard.normalCount === 0}
          onClose={() => setSelectedCard(null)}
        />
      )}
    </div>
  );
}

export default App;

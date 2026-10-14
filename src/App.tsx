import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './styles/index.css';
import PackOpener from './components/pack/PackOpener';
import AchievementToasts, { type ToastItem } from './components/achievements/AchievementToasts';
import AppNav, { type NavTarget } from './components/ui/AppNav';
import MyProfilePage from './components/profile/MyProfilePage';
import ProfileViewerPage from './components/profile/ProfileViewerPage';
import AchievementsPage from './components/achievements/AchievementsPage';
import HallOfFamePage from './components/pages/HallOfFamePage';
import SettingsPage from './components/pages/SettingsPage';
import CollectionBrowser from './components/collection/CollectionBrowser';
import SetPicker from './components/sets/SetPicker';
import ShareSheet, { type ShareTarget } from './components/share/ShareSheet';
import Sheet from './components/ui/Sheet';
import PullViewerPage from './components/share/PullViewerPage';
import { cardPoints, scoreCards } from './data/cards';
import { getAchievementById } from './data/achievements';
import { CardWithMeta } from './components/cards/Card';
import { DEFAULT_SET_ID, SETS } from './content/sets';
import { extractProfile, extractProof } from './engine';
import { clearPendingPack, takePendingPack, type OpenedPack, type PullRef } from './game/pulls';
import { importPlayer } from './game/player';
import { backUpSave, hasProgress } from './game/move';
import { getStoredData } from './utils/storage';
import { musicLevel, readSettings } from './utils/settings';
import { CARD_BACKS, PACK_FOILS, TITLES, nextReward, usable } from './game/progression';
import { myStats, onReopenProgress } from './game/profiles';
import { getHistory } from './game/history';
import { CURRENT_DATA_VERSION, hydrateCollection, setDataVersion } from './utils/migrations';
import { STORAGE_KEYS } from './constants';
import {
  checkPackMilestones,
  checkCollectionAchievements,
  checkModifierAchievements,
  checkPackAchievements,
  checkPackScoreAchievements,
  checkHistoryAchievements,
} from './utils/achievementChecks';
import type { CollectionItem, Stats, HallOfFameData, Settings, AchievementData } from './types';
import swedenSrc from './assets/audio/Sweden.mp3';

/** Save-file fields and where they live in localStorage. */
const SAVE_FIELDS = [
  ['collection', STORAGE_KEYS.COLLECTION],
  ['achievements', STORAGE_KEYS.ACHIEVEMENTS],
  ['stats', STORAGE_KEYS.STATS],
  ['hallOfFame', STORAGE_KEYS.HALL_OF_FAME],
  ['pulls', STORAGE_KEYS.PULLS],
  ['history', STORAGE_KEYS.HISTORY],
  ['settings', STORAGE_KEYS.SETTINGS],
] as const;

/** A pull or profile link that got cut off or mangled on the way (chat apps do that). */
const isBrokenLink = (hash: string) => /^#\/(pull|profile)\//.test(hash) && !extractProof(hash) && !extractProfile(hash);

function App() {
  const [collection, setCollection] = useState<Record<string, CollectionItem>>(() => hydrateCollection(getStoredData(STORAGE_KEYS.COLLECTION, {})));
  const [achievements, setAchievements] = useState<Record<string, AchievementData | number>>(() => getStoredData(STORAGE_KEYS.ACHIEVEMENTS, {}));
  const [stats, setStats] = useState<Stats>(() => getStoredData(STORAGE_KEYS.STATS, { packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
  const [hallOfFame, setHallOfFame] = useState<HallOfFameData>(() => getStoredData(STORAGE_KEYS.HALL_OF_FAME, {}));

  const [settings, setSettings] = useState<Settings>(() => readSettings(getStoredData<unknown>(STORAGE_KEYS.SETTINGS, null)));

  const [isCollectionOpen, setIsCollectionOpen] = useState(false);
  const [isAchievementsOpen, setIsAchievementsOpen] = useState(false);
  const [isHallOfFameOpen, setIsHallOfFameOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [notificationQueue, setNotificationQueue] = useState<ToastItem[]>([]);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const [viewProof, setViewProof] = useState<string | null>(() => extractProof(window.location.hash));
  const [viewProfile, setViewProfile] = useState<string | null>(() => extractProfile(window.location.hash));
  const [brokenLink, setBrokenLink] = useState(() => isBrokenLink(window.location.hash));

  const playableSets = SETS.filter((s) => !s.archivedAt && (!s.draft || settings.showDraftSets));
  const [selectedSetId, setSelectedSetId] = useState<string>(() => localStorage.getItem(STORAGE_KEYS.SELECTED_SET) ?? DEFAULT_SET_ID);
  const selectedSet = playableSets.find((s) => s.id === selectedSetId) ?? playableSets.find((s) => s.id === DEFAULT_SET_ID) ?? playableSets[0];
  const selectSet = useCallback((setId: string) => {
    setSelectedSetId(setId);
    localStorage.setItem(STORAGE_KEYS.SELECTED_SET, setId);
  }, []);

  // Shared pull links: #/pull/<proof>
  useEffect(() => {
    const onHashChange = () => {
      setViewProof(extractProof(window.location.hash));
      setViewProfile(extractProfile(window.location.hash));
      setBrokenLink(isBrokenLink(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const closePullViewer = useCallback(() => {
    // Shared links arrive through a preview page (/p/<id>), which is only there for chat apps.
    const path = /\/p\/[^/]+$/.test(window.location.pathname) ? import.meta.env.BASE_URL : window.location.pathname + window.location.search;
    history.replaceState(null, '', path);
    setViewProof(null);
    setViewProfile(null);
    setBrokenLink(false);
  }, []);

  const bgMusicRef = useRef<HTMLAudioElement | null>(null);

  // Background music. Browsers (phones always) only allow sound after a tap or a key, so it starts on
  // the first one if it couldn't start on load; and it isn't downloaded until it plays, so it doesn't
  // hold up the pack art on a slow connection.
  useEffect(() => {
    const bgMusic = new Audio();
    bgMusic.preload = 'none';
    bgMusic.src = swedenSrc;
    bgMusic.volume = musicLevel(settings.musicVolume);
    bgMusic.loop = true;
    bgMusicRef.current = bgMusic;

    const events = ['pointerdown', 'keydown'] as const;
    const startOnInput = () => {
      events.forEach((e) => window.removeEventListener(e, startOnInput));
      if (bgMusic.volume > 0 && bgMusic.paused) bgMusic.play().catch(() => { });
    };
    if (settings.musicVolume > 0) {
      bgMusic.play().catch(() => events.forEach((e) => window.addEventListener(e, startOnInput)));
    }

    return () => {
      events.forEach((e) => window.removeEventListener(e, startOnInput));
      bgMusic.pause();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Level rewards in use (game/progression.ts), checked against the level this save has reached.
  // Re-read after every pack (myStats reads the pack history, which each pack adds to).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const level = useMemo(() => myStats().level, [stats.packsOpened]);
  // A level-up says so, with what it unlocked (otherwise it only shows if you open the profile).
  const shownLevel = useRef(level);
  useEffect(() => {
    const from = shownLevel.current;
    shownLevel.current = level;
    if (level <= from) return;
    const unlocked = [
      ...TITLES.filter((r) => r.level > from && r.level <= level).map((r) => `the title ${r.name}`),
      ...CARD_BACKS.filter((r) => r.level > from && r.level <= level).map((r) => `the ${r.name} card back`),
      ...PACK_FOILS.filter((r) => r.level > from && r.level <= level).map((r) => `the ${r.name} pack foil`),
    ];
    const next = nextReward(level);
    setNotificationQueue((prev) => [
      ...prev,
      {
        id: `level-${level}`,
        kicker: 'Level up',
        name: `Level ${level}`,
        description: unlocked.length ? `Unlocked ${unlocked.join(', ')}. Pick it in your profile.` : next ? `Next: ${next.name} at level ${next.level}.` : 'Keep opening.',
        opens: 'profile',
      },
    ]);
  }, [level]);

  useEffect(() => {
    document.documentElement.dataset.cardBack = usable(CARD_BACKS, settings.cardBack, level);
    document.documentElement.dataset.packFoil = usable(PACK_FOILS, settings.packFoil, level);
  }, [settings.cardBack, settings.packFoil, level]);

  // Follow the music slider (0 is off)
  useEffect(() => {
    const bgMusic = bgMusicRef.current;
    if (!bgMusic) return;
    bgMusic.volume = musicLevel(settings.musicVolume);
    if (settings.musicVolume === 0) bgMusic.pause();
    else if (bgMusic.paused) bgMusic.play().catch(() => { });
  }, [settings.musicVolume]);

  // Check retroactive achievements on mount
  useEffect(() => {
    // Use shared achievement checking functions
    const packAchievements = checkPackMilestones(stats.packsOpened || 0, achievements);
    const collectionAchievements = checkCollectionAchievements(collection, stats, achievements);
    // Finishes and misprints pulled before their achievements existed: from the pack history, and
    // from the collection's tallies for packs the history has no cards for.
    const pulled = getHistory().flatMap((e) => (e.cards ?? []).map((c) => ({ isHolo: c.holo, finish: c.finish, misprint: c.misprint })));
    const tallied = Object.values(collection).flatMap((item) => [
      ...Object.entries(item?.finishes ?? {}).filter(([, n]) => (n ?? 0) > 0).map(([finish]) => ({ isHolo: false, finish })),
      ...((item?.misprints ?? 0) > 0 ? [{ isHolo: false, misprint: true }] : []),
    ]);
    const modifierAchievements = checkModifierAchievements([...pulled, ...tallied], achievements);

    const retroactiveAchievements = [...packAchievements, ...collectionAchievements, ...modifierAchievements];

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

  // Packs in the history that never got their pack achievements (merged in from a save, or opened
  // before the achievement existed). Unlocked quietly, dated and linked to the pack that earned them.
  const unlockFromHistory = useCallback(() => {
    const history = getHistory();
    setAchievements(prev => {
      const found = checkHistoryAchievements(history, prev);
      if (found.length === 0) return prev;
      const next = { ...prev };
      for (const { id, entry, cards } of found) {
        next[id] = {
          unlockedAt: entry.openedAt,
          ...(cards ? { pack: cards } : {}),
          ref: { setId: entry.setId, setVersion: entry.setVersion, nonce: entry.nonce, publicKeyHex: entry.key },
        };
      }
      localStorage.setItem(STORAGE_KEYS.ACHIEVEMENTS, JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    unlockFromHistory();
    // Re-opened packs bring back the cards of packs the history only had a hand and score for.
    const stop = onReopenProgress((status) => {
      if (!status.running) unlockFromHistory();
    });
    return () => {
      stop();
    };
  }, [unlockFromHistory]);

  const unlockAchievement = useCallback((achievementId: string, pack?: CardWithMeta[], ref?: PullRef) => {
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
        ...(ref ? { ref } : {}),
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

  const dismissNotifications = useCallback((ids: string[]) => {
    setNotificationQueue(prev => prev.filter(a => !ids.includes(a.id)));
  }, []);

  const openNav = useCallback((target: NavTarget) => {
    ({
      collection: setIsCollectionOpen,
      achievements: setIsAchievementsOpen,
      hallOfFame: setIsHallOfFameOpen,
      profile: setIsProfileOpen,
      settings: setIsSettingsOpen,
    })[target](true);
  }, []);

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(newSettings));
  }, []);

  /** Load a backup file (Settings asks first if it would replace a different save). Returns an error to show, if any. */
  const handleImportSave = useCallback((data: string): string | null => {
    try {
      const saveData = JSON.parse(data);

      // Validate save data structure
      if (!saveData.version || !saveData.exportedAt) {
        return "That file isn't a Brainrot TCG save.";
      }

      // Write everything, then reload: the loader runs any migrations an older save needs
      // (saves from before timeline sets use old card ids and the old score scale).
      for (const [field] of SAVE_FIELDS) {
        if (typeof saveData[field] === 'string') JSON.parse(saveData[field]); // reject corrupt files before writing anything
      }
      // The save being replaced is kept, in case it was the wrong file.
      if (hasProgress()) backUpSave('brainrot-before-import-v1');
      for (const [field, key] of SAVE_FIELDS) {
        if (typeof saveData[field] === 'string') localStorage.setItem(key, saveData[field]);
      }
      if (typeof saveData.player === 'string' && !importPlayer(saveData.player)) {
        alert('The player key in this save is invalid; keeping your current one.');
      }
      setDataVersion(typeof saveData.dataVersion === 'number' ? saveData.dataVersion : saveData.version === 1 ? 1 : CURRENT_DATA_VERSION);

      window.location.reload();
      return null;
    } catch {
      return "Couldn't read that file. Is it a save exported from Settings?";
    }
  }, []);

  const checkAllAchievements = useCallback((newCards: CardWithMeta[], pullRef: PullRef, updatedCollection: Record<string, CollectionItem>, updatedStats: Stats, currentAchievements: Record<string, AchievementData | number>) => {
    // Use shared achievement checking functions - pass current achievements to avoid stale state
    const packMilestones = checkPackMilestones(updatedStats.packsOpened, currentAchievements);
    const collectionAchievements = checkCollectionAchievements(updatedCollection, updatedStats, currentAchievements);
    const packAchievements = checkPackAchievements(newCards, currentAchievements);

    // Combine all achievements and unlock them with the pack data
    const allNewAchievements = [...packMilestones, ...collectionAchievements, ...packAchievements];
    allNewAchievements.forEach(id => unlockAchievement(id, newCards, pullRef));
  }, [unlockAchievement]);

  const handlePackOpened = useCallback((pack: OpenedPack) => {
    clearPendingPack(pack.nonce);
    const newCards = pack.cards;
    const pullRef = { setId: pack.setId, setVersion: pack.setVersion, nonce: pack.nonce, publicKeyHex: pack.publicKeyHex };
    const { points: packValue, hand: pokerHand, score } = scoreCards(newCards);

    // Update stats using functional update to avoid stale closure
    let updatedStats: Stats = stats;
    setStats(prev => {
      const newStats: Stats = {
        ...prev,
        packsOpened: (prev.packsOpened || 0) + 1,
        holoCards: { ...prev.holoCards }
      };

      // Update highest pack value - compare against previous state
      if (score > (prev.highestPackFlexValue || prev.highestPackValue || 0)) {
        newStats.highestPackFlexValue = score;
        newStats.highestPackBaseValue = packValue;
        newStats.highestPackMultiplier = pokerHand.multiplier;
        newStats.highestPackHandName = pokerHand.name;
        newStats.highestPackCards = newCards;
        newStats.highestPackRef = pullRef;
        newStats.highestPackLegacy = false;
      }

      // Track holo cards
      newCards.forEach(card => {
        if (card.isHolo) {
          newStats.holoCards[card.key] = true;
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
          holoCounts[card.key] = (holoCounts[card.key] || 0) + 1;
        } else {
          normalCounts[card.key] = (normalCounts[card.key] || 0) + 1;
        }
      });

      // Get all unique card IDs from this pack
      const cardIds = new Set(newCards.map(c => c.key));
      cardIds.forEach((cardId) => {
        const card = newCards.find(c => c.key === cardId);
        if (!card) return;
        const existing = next[cardId];
        const finishes = { ...existing?.finishes };
        let misprints = existing?.misprints ?? 0;
        let modifierPoints = existing?.modifierPoints ?? 0;
        for (const copy of newCards.filter((c) => c.key === cardId)) {
          if (copy.finish) finishes[copy.finish] = (finishes[copy.finish] ?? 0) + 1;
          if (copy.misprint) misprints++;
          modifierPoints += cardPoints(copy.rarity, copy.isHolo, copy.finish, copy.misprint) - cardPoints(copy.rarity, copy.isHolo);
        }
        next[cardId] = {
          card: { key: card.key, setId: card.setId, id: card.id, name: card.name, rarity: card.rarity, image: card.image },
          normalCount: (existing?.normalCount || 0) + (normalCounts[cardId] || 0),
          holoCount: (existing?.holoCount || 0) + (holoCounts[cardId] || 0),
          ...(Object.keys(finishes).length ? { finishes } : {}),
          ...(misprints ? { misprints } : {}),
          ...(modifierPoints ? { modifierPoints } : {}),
        };
      });

      localStorage.setItem(STORAGE_KEYS.COLLECTION, JSON.stringify(next));
      updatedCollection = next;
      return next;
    });

    // Check Hall of Fame milestones
    const updatedHallOfFame = { ...hallOfFame };
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

    // Check pack value achievements - unlockAchievement handles duplicates internally
    const packValueAchievements = checkPackScoreAchievements(score, {});
    packValueAchievements.forEach(id => unlockAchievement(id, newCards, pullRef));

    // Check other achievements - get current state to avoid stale closure
    setAchievements(currentAchievements => {
      checkAllAchievements(newCards, pullRef, updatedCollection || collection, updatedStats, currentAchievements);
      return currentAchievements;
    });
  }, [stats, hallOfFame, collection, checkAllAchievements, unlockAchievement]);

  // A pack whose reveal never finished (a reload, a closed tab): its ticket is spent, so it still counts.
  useEffect(() => {
    const pending = takePendingPack();
    if (pending) handlePackOpened(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sharePack = useCallback((pack: OpenedPack) => {
    setShareTarget({ ref: { setId: pack.setId, setVersion: pack.setVersion, nonce: pack.nonce, publicKeyHex: pack.publicKeyHex }, cards: pack.cards, score: pack.score });
  }, []);

  // For the NEW sticker: the collection as it was before the pack being opened.
  const isOwned = useCallback((cardKey: string) => !!collection[cardKey], [collection]);

  // Progress shown on the counting achievements that are still locked.
  const achievementProgress = useMemo(() => {
    const packs = stats.packsOpened || 0;
    const items = Object.values(collection);
    const unique = items.length;
    const holos = items.reduce((n, item) => n + (item?.holoCount || 0), 0);
    const out: Record<string, [number, number, string]> = {};
    for (const n of [10, 41, 67, 100, 420, 1000]) out[`packs_${n}`] = [packs, n, 'packs'];
    for (const n of [5, 10]) out[`collect_${n}`] = [unique, n, 'cards'];
    for (const n of [25, 100]) out[`total_holos_${n}`] = [holos, n, 'holos'];
    return out;
  }, [stats.packsOpened, collection]);

  const isAnyModalOpen = isCollectionOpen || isAchievementsOpen || isHallOfFameOpen || isProfileOpen || isSettingsOpen || !!shareTarget || !!viewProof || !!viewProfile;

  return (
    <div className={`app ${packBusy ? 'is-focus' : ''}`}>
      <header className="app-header">
        <h1 className="app-logo" aria-label="Brainrot TCG">
          {'Brainrot TCG'.split('').map((char, i) =>
            char === ' ' ? (
              <span key={i} className="title-space" aria-hidden="true" />
            ) : (
              <span key={i} className="title-char" aria-hidden="true" style={{ animationDelay: `${i * 0.08}s` }}>
                {char}
              </span>
            ),
          )}
        </h1>
        <AppNav onOpen={openNav} />
      </header>

      <main className="app-main">
        <SetPicker sets={playableSets} selectedId={selectedSet.id} onSelect={selectSet} collection={collection} disabled={packBusy} />
        <PackOpener
          key={selectedSet.id}
          onOpen={handlePackOpened}
          onShare={sharePack}
          onBusyChange={setPackBusy}
          set={selectedSet}
          disabled={isAnyModalOpen}
          settings={settings}
          cardBack={usable(CARD_BACKS, settings.cardBack, level)}
          isOwned={isOwned}
        />
      </main>

      <AchievementToasts
        queue={notificationQueue}
        onDismiss={dismissNotifications}
        onOpen={(target) => (target === 'profile' ? setIsProfileOpen(true) : setIsAchievementsOpen(true))}
        paused={isAnyModalOpen}
      />

      {/* Achievements Page */}
      {isAchievementsOpen && (
        <AchievementsPage
          unlockedAchievements={achievements}
          onClose={() => setIsAchievementsOpen(false)}
          progress={achievementProgress}
          onSharePull={(ref, cards) => setShareTarget({ ref, cards, score: scoreCards(cards) })}
        />
      )}

      {/* Hall of Fame Page */}
      {isHallOfFameOpen && (
        <HallOfFamePage
          onClose={() => setIsHallOfFameOpen(false)}
        />
      )}

      {isProfileOpen && (
        <MyProfilePage
          stats={stats}
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onClose={() => setIsProfileOpen(false)}
          onSharePull={(entry, cards) =>
            setShareTarget({
              ref: { setId: entry.setId, setVersion: entry.setVersion, nonce: entry.nonce, publicKeyHex: entry.key },
              cards,
              score: scoreCards(cards),
            })
          }
        />
      )}

      {/* Collection Browser */}
      {isCollectionOpen && (
        <CollectionBrowser
          collection={collection}
          onClose={() => setIsCollectionOpen(false)}
        />
      )}

      {shareTarget && <ShareSheet target={shareTarget} onClose={() => setShareTarget(null)} />}

      {viewProof && <PullViewerPage proof={viewProof} onClose={closePullViewer} />}

      {viewProfile && <ProfileViewerPage proof={viewProfile} onClose={closePullViewer} />}

      {brokenLink && (
        <Sheet title="This link doesn't work" onClose={closePullViewer} size="sm">
          <p className="share-note">
            It looks cut off or changed, maybe when it was copied or pasted. Ask for the link again, or open a pack yourself.
          </p>
        </Sheet>
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

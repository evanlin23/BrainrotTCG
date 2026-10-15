import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Settings2 } from 'lucide-react';
import './styles/index.css';
import PackOpener from './components/pack/PackOpener';
import AchievementToasts, { type ToastItem } from './components/achievements/AchievementToasts';
import AppNav, { type NavTarget } from './components/ui/AppNav';
import DeferredSheet from './components/ui/DeferredSheet';
import SetPicker from './components/sets/SetPicker';
import type { ShareTarget } from './components/share/ShareSheet';
import Sheet from './components/ui/Sheet';
import { cardPoints, scoreCards } from './data/cards';
import { getAchievementById } from './data/achievements';
import { CardWithMeta } from './components/cards/Card';
import { DEFAULT_SET_ID, SETS } from './content/sets';
import { extractProfile, extractProof } from './engine';
import { clearPendingPack, savePendingPack, takePendingPacks, type OpenedPack, type PullRef } from './game/pulls';
import { importSaveFile } from './game/saveFile';
import { getStoredData, setStoredData } from './utils/storage';
import { readSelectedSet, saveSelectedSet } from './game/selectedSet';
import { collectionRecoveryDismissed, dismissCollectionRecovery, hasCollectionRecovery, persistCollection } from './game/collectionRecovery';
import { musicLevel, readSettings } from './utils/settings';
import { CARD_BACKS, PACK_FOILS, TITLES, nextReward, usable } from './game/progression';
import { myStats, onReopenProgress } from './game/profiles';
import { getHistory, recordMissing } from './game/history';
import { getPlayer } from './game/player';
import { hydrateCollection } from './utils/migrations';
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

// Keep loaders stable, and request a secondary screen only when its existing state opens it.
const loadPlayer = () => import('./components/profile/PlayerPage');
const loadProfile = () => import('./components/profile/MyProfilePage');
const loadPublicProfile = () => import('./components/profile/ProfileViewerPage');
const loadAchievements = () => import('./components/achievements/AchievementsPage');
const loadHallOfFame = () => import('./components/pages/HallOfFamePage');
const loadSettings = () => import('./components/pages/SettingsPage');
const loadCollection = () => import('./components/collection/CollectionBrowser');
const loadShare = () => import('./components/share/ShareSheet');
const loadPull = () => import('./components/share/PullViewerPage');

/** A pull or profile link that got cut off or mangled on the way (chat apps do that). */
const isBrokenLink = (hash: string) => /^#\/(pull|profile)\//.test(hash) && !extractProof(hash) && !extractProfile(hash);
const SAVE_WARNING = "Some changes couldn't be saved in this browser and may be lost when you close or reload. Backups only include data already saved.";
const COLLECTION_RECOVERY_NOTE = 'Unreadable collection data was kept aside in this browser. To recover it, open Player, then Save & restore, and export a backup.';
/** What adding a pack changes, so several packs can be added before React renders. */
type PackProgress = { stats: Stats; collection: Record<string, CollectionItem>; hallOfFame: HallOfFameData };

function App() {
  const [collection, setCollection] = useState<Record<string, CollectionItem>>(() => hydrateCollection(getStoredData(STORAGE_KEYS.COLLECTION, {})));
  const [achievements, setAchievements] = useState<Record<string, AchievementData | number>>(() => getStoredData(STORAGE_KEYS.ACHIEVEMENTS, {}));
  const [stats, setStats] = useState<Stats>(() => getStoredData(STORAGE_KEYS.STATS, { packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
  const [hallOfFame, setHallOfFame] = useState<HallOfFameData>(() => getStoredData(STORAGE_KEYS.HALL_OF_FAME, {}));

  const [settings, setSettings] = useState<Settings>(() => readSettings(getStoredData<unknown>(STORAGE_KEYS.SETTINGS, null)));
  const [saveFailed, setSaveFailed] = useState(false);
  const [collectionArchived, setCollectionArchived] = useState(hasCollectionRecovery);
  // The player can hide the kept-aside note from the banner until something new is kept aside;
  // Settings keeps showing it.
  const [recoveryNoteHidden, setRecoveryNoteHidden] = useState(collectionRecoveryDismissed);
  const showRecoveryNote = collectionArchived && !recoveryNoteHidden;
  // One warning for every storage problem, in the banner and in Settings.
  const saveWarning = [saveFailed && SAVE_WARNING, collectionArchived && COLLECTION_RECOVERY_NOTE].filter(Boolean).join(' ') || undefined;
  const bannerWarning = [saveFailed && SAVE_WARNING, showRecoveryNote && COLLECTION_RECOVERY_NOTE].filter(Boolean).join(' ') || undefined;
  const hideRecoveryNote = useCallback(() => {
    dismissCollectionRecovery();
    setRecoveryNoteHidden(true);
  }, []);
  const achievementsRef = useRef(achievements);
  const previousProgress = useRef<Map<string, unknown> | null>(null);
  // Packs given to the collection that it hasn't stored yet: each stays on the pending shelf till then.
  const unsavedPacks = useRef<OpenedPack[]>([]);

  // Persist committed state, never during a React updater (which can be replayed).
  // Skip the initial snapshot and do not retry automatically or imply a multi-field commit.
  useEffect(() => {
    const fields: [string, unknown][] = [
      [STORAGE_KEYS.ACHIEVEMENTS, achievements], [STORAGE_KEYS.STATS, stats],
      [STORAGE_KEYS.HALL_OF_FAME, hallOfFame], [STORAGE_KEYS.SETTINGS, settings],
    ];
    const previous = previousProgress.current;
    previousProgress.current = new Map([[STORAGE_KEYS.COLLECTION, collection], ...fields]);
    if (!previous) return;
    let statsHandled = false;
    // The collection archives stored entries it couldn't read before replacing them (or keeps them).
    if (previous.get(STORAGE_KEYS.COLLECTION) !== collection) {
      const result = persistCollection(collection);
      const packs = unsavedPacks.current;
      if (result === 'blocked') {
        setSaveFailed(true);
        // Every pack the collection couldn't store goes (back) on the shelf for the next load to add (an
        // older build's pack goes back into its own entry, while it is still there: see game/pulls.ts).
        // Marked as counted first, then the stats that count them are stored; if they can't be (or a
        // full shelf can't take one), the packs go back unmarked so that load counts them (and the stats
        // wait for it).
        if (packs.length > 0) {
          const marked = packs.map((pack) => ({ ...pack, counted: true }));
          statsHandled = true;
          if (savePendingPack(...marked) && setStoredData(STORAGE_KEYS.STATS, stats)) unsavedPacks.current = marked;
          // Packs taken off the shelf at load may not fit back on it: they stay owed by this tab, and the
          // next collection change tries again.
          else if (!savePendingPack(...packs)) {
            console.error(`${packs.length} pack(s) couldn't be put back on the pending shelf: only this tab has them until its collection is stored.`);
          }
        }
      } else {
        unsavedPacks.current = [];
        if (packs.length > 0) clearPendingPack(...packs.map((pack) => pack.nonce));
      }
      // A ticket mapping the history couldn't take when its pack opened goes in once this save is done.
      if (packs.length > 0 && !recordMissing(packs, getPlayer().publicKeyHex)) setSaveFailed(true);
      // The archive can be written even when the collection then can't be.
      if (result !== 'saved' && hasCollectionRecovery()) {
        setCollectionArchived(true);
        setRecoveryNoteHidden(collectionRecoveryDismissed());
      }
    }
    for (const [key, value] of fields) {
      if (key === STORAGE_KEYS.STATS && statsHandled) continue;
      if (previous.get(key) !== value && !setStoredData(key, value)) setSaveFailed(true);
    }
  }, [collection, achievements, stats, hallOfFame, settings]);

  const [isCollectionOpen, setIsCollectionOpen] = useState(false);
  const [isAchievementsOpen, setIsAchievementsOpen] = useState(false);
  const [isHallOfFameOpen, setIsHallOfFameOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'sound' | 'save'>('sound');
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);
  const [notificationQueue, setNotificationQueue] = useState<ToastItem[]>([]);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const [viewProof, setViewProof] = useState<string | null>(() => extractProof(window.location.hash));
  const [viewProfile, setViewProfile] = useState<string | null>(() => extractProfile(window.location.hash));
  const [brokenLink, setBrokenLink] = useState(() => isBrokenLink(window.location.hash));

  const playableSets = SETS.filter((s) => !s.archivedAt && (!s.draft || settings.showDraftSets));
  const [selectedSetId, setSelectedSetId] = useState<string>(readSelectedSet);
  const selectedSet = playableSets.find((s) => s.id === selectedSetId) ?? playableSets.find((s) => s.id === DEFAULT_SET_ID) ?? playableSets[0];
  const selectSet = useCallback((setId: string) => {
    setSelectedSetId(setId);
    saveSelectedSet(setId);
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
        description: unlocked.length ? `Unlocked ${unlocked.join(', ')}. Pick it on your Player page.` : next ? `Next: ${next.name} at level ${next.level}.` : 'Keep opening.',
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
      const next = { ...achievementsRef.current };
      retroactiveAchievements.forEach(id => {
        if (!next[id]) next[id] = timestamp;
      });
      achievementsRef.current = next;
      setAchievements(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  // Packs in the history that never got their pack achievements (merged in from a save, or opened
  // before the achievement existed). Unlocked quietly, dated and linked to the pack that earned them.
  const unlockFromHistory = useCallback(() => {
    const found = checkHistoryAchievements(getHistory(), achievementsRef.current);
    if (found.length === 0) return;
    const next = { ...achievementsRef.current };
    for (const { id, entry, cards } of found) {
      next[id] = {
        unlockedAt: entry.openedAt,
        ...(cards ? { pack: cards } : {}),
        ref: { setId: entry.setId, setVersion: entry.setVersion, nonce: entry.nonce, publicKeyHex: entry.key },
      };
    }
    // Keep later live commands on the same snapshot; persistence follows the guarded effect.
    achievementsRef.current = next;
    setAchievements(next);
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

    // Commands can unlock several achievements before React renders; deduplicate immediately.
    if (achievementsRef.current[achievementId]) return;
    const achievementData: AchievementData = { unlockedAt: Date.now(), pack, ...(ref ? { ref } : {}) };
    const next = { ...achievementsRef.current, [achievementId]: achievementData };
    achievementsRef.current = next;
    setAchievements(next);
    setNotificationQueue(prev => prev.some(a => a.id === achievementId) ? prev : [...prev, achievement]);
  }, []);

  const dismissNotifications = useCallback((ids: string[]) => {
    setNotificationQueue(prev => prev.filter(a => !ids.includes(a.id)));
  }, []);

  const openNav = useCallback((target: NavTarget) => {
    setIsCollectionOpen(target === 'collection');
    setIsProfileOpen(target === 'profile');
    setIsAchievementsOpen(target === 'achievements');
    setIsHallOfFameOpen(target === 'hallOfFame');
    setIsPlayerOpen(target === 'player');
    setIsSettingsOpen(target === 'settings' || target === 'save');
    if (target === 'settings' || target === 'save') setSettingsSection(target === 'save' ? 'save' : 'sound');
  }, []);

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
  }, []);

  /** Load a backup file (Settings asks first if it would replace a different save). Returns an error to show, if any. */
  const handleImportSave = useCallback((data: string): string | null => {
    const error = importSaveFile(data);
    if (!error) window.location.reload();
    return error;
  }, []);

  const checkAllAchievements = useCallback((newCards: CardWithMeta[], pullRef: PullRef, updatedCollection: Record<string, CollectionItem>, updatedStats: Stats, currentAchievements: Record<string, AchievementData | number>, newPack = true) => {
    // Use shared achievement checking functions - pass current achievements to avoid stale state
    const packMilestones = newPack ? checkPackMilestones(updatedStats.packsOpened, currentAchievements) : [];
    const collectionAchievements = checkCollectionAchievements(updatedCollection, updatedStats, currentAchievements);
    const packAchievements = checkPackAchievements(newCards, currentAchievements);

    // Combine all achievements and unlock them with the pack data
    const allNewAchievements = [...packMilestones, ...collectionAchievements, ...packAchievements];
    allNewAchievements.forEach(id => unlockAchievement(id, newCards, pullRef));
  }, [unlockAchievement]);

  const handlePackOpened = useCallback((pack: OpenedPack, from: PackProgress = { stats, collection, hallOfFame }): PackProgress => {
    unsavedPacks.current.push(pack);
    if (pack.unrecorded) setSaveFailed(true);
    // A pack put back on the shelf counted when it opened (stats, pack milestones): it only adds its cards.
    const counted = pack.counted === true;
    const newCards = pack.cards;
    const pullRef = { setId: pack.setId, setVersion: pack.setVersion, nonce: pack.nonce, publicKeyHex: pack.publicKeyHex };
    const { points: packValue, hand: pokerHand, score } = scoreCards(newCards);

    // Compute progress in the event handler; React state updaters stay free of side effects.
    const updatedStats: Stats = {
      ...from.stats,
      packsOpened: (from.stats.packsOpened || 0) + 1,
      holoCards: { ...from.stats.holoCards }
    };

    // Update highest pack value - compare against previous state
    if (score > (from.stats.highestPackFlexValue || from.stats.highestPackValue || 0)) {
      updatedStats.highestPackFlexValue = score;
      updatedStats.highestPackBaseValue = packValue;
      updatedStats.highestPackMultiplier = pokerHand.multiplier;
      updatedStats.highestPackHandName = pokerHand.name;
      updatedStats.highestPackCards = newCards;
      updatedStats.highestPackRef = pullRef;
      updatedStats.highestPackLegacy = false;
    }

    // Track holo cards
    newCards.forEach(card => {
      if (card.isHolo) {
        updatedStats.holoCards[card.key] = true;
      }
    });

    if (!counted) setStats(updatedStats);

    // Update collection - track holo and normal counts separately
    const updatedCollection = { ...from.collection };

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
      const existing = updatedCollection[cardId];
      const finishes = { ...existing?.finishes };
      let misprints = existing?.misprints ?? 0;
      let modifierPoints = existing?.modifierPoints ?? 0;
      for (const copy of newCards.filter((c) => c.key === cardId)) {
        if (copy.finish) finishes[copy.finish] = (finishes[copy.finish] ?? 0) + 1;
        if (copy.misprint) misprints++;
        modifierPoints += cardPoints(copy.rarity, copy.isHolo, copy.finish, copy.misprint) - cardPoints(copy.rarity, copy.isHolo);
      }
      updatedCollection[cardId] = {
        card: { key: card.key, setId: card.setId, id: card.id, name: card.name, rarity: card.rarity, image: card.image },
        normalCount: (existing?.normalCount || 0) + (normalCounts[cardId] || 0),
        holoCount: (existing?.holoCount || 0) + (holoCounts[cardId] || 0),
        ...(Object.keys(finishes).length ? { finishes } : {}),
        ...(misprints ? { misprints } : {}),
        ...(modifierPoints ? { modifierPoints } : {}),
      };
    });

    setCollection(updatedCollection);

    // Check Hall of Fame milestones
    const updatedHallOfFame = { ...from.hallOfFame };
    const cardCounts: Record<string, number> = {};
    newCards.forEach(c => {
      cardCounts[c.id] = (cardCounts[c.id] || 0) + 1;
    });
    const maxCount = Math.max(...Object.values(cardCounts));

    // First 4 of a kind
    if (maxCount >= 4 && !from.hallOfFame.first4OfAKind) {
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
    if (hasThree && hasTwo && !from.hallOfFame.firstFullHouse) {
      updatedHallOfFame.firstFullHouse = {
        achieved: true,
        date: Date.now(),
        cards: cardCounts
      };
    }

    if (updatedHallOfFame !== from.hallOfFame) {
      setHallOfFame(updatedHallOfFame);
    }

    // Check pack value achievements - unlockAchievement handles duplicates internally
    const packValueAchievements = checkPackScoreAchievements(score, {});
    packValueAchievements.forEach(id => unlockAchievement(id, newCards, pullRef));

    // Check other achievements - get current state to avoid stale closure
    checkAllAchievements(newCards, pullRef, updatedCollection, counted ? from.stats : updatedStats, achievementsRef.current, !counted);
    return { stats: counted ? from.stats : updatedStats, collection: updatedCollection, hallOfFame: updatedHallOfFame };
  }, [stats, hallOfFame, collection, checkAllAchievements, unlockAchievement]);

  // Packs whose reveal never finished (a reload, a closed tab): their tickets are spent, so they still count.
  // Once per mount: an older build's pack stays in its entry until stored, so a second take would add it again.
  const pendingTaken = useRef(false);
  useEffect(() => {
    if (pendingTaken.current) return;
    pendingTaken.current = true;
    takePendingPacks().reduce<PackProgress | undefined>((from, pack) => handlePackOpened(pack, from), undefined);
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

  const isAnyModalOpen = isCollectionOpen || isAchievementsOpen || isHallOfFameOpen || isProfileOpen || isSettingsOpen || isPlayerOpen || !!shareTarget || !!viewProof || !!viewProfile;
  // A sheet that is none of the tabs (even one on top of My cards, like Share from Best pulls or a
  // shared link) leaves no tab current.
  const isNonTabSheetOpen = isAchievementsOpen || isSettingsOpen || isPlayerOpen || !!shareTarget || !!viewProof || !!viewProfile || brokenLink;
  const activeTab = isNonTabSheetOpen ? null : isCollectionOpen || isProfileOpen ? 'collection' : isHallOfFameOpen ? 'hallOfFame' : 'open';

  const personalNavigation = <nav className="personal-nav" aria-label="My cards">
    <button type="button" className="btn btn--secondary" aria-current={isCollectionOpen ? 'page' : undefined} onClick={() => openNav('collection')}>Cards</button>
    <button type="button" className="btn btn--secondary" aria-current={isProfileOpen ? 'page' : undefined} onClick={() => openNav('profile')}>Best pulls</button>
  </nav>;

  return (
    <div className={`app ${packBusy ? 'is-focus' : ''}`}>
      {bannerWarning && !isSettingsOpen && (
        <p role="alert" className="save-warning">
          {bannerWarning}
          {showRecoveryNote && <button type="button" className="link-btn save-warning-hide" onClick={hideRecoveryNote}>Hide note</button>}
        </p>
      )}
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
        <AppNav onOpen={openNav} active={activeTab} />
        <div className="app-utilities">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openNav('player')} disabled={packBusy}>Player</button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openNav('settings')} disabled={packBusy} aria-label="Sound & display" title="Sound & display"><Settings2 aria-hidden="true" size={20} /></button>
        </div>
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
        onOpen={(target) => openNav(target === 'profile' ? 'player' : 'achievements')}
        paused={isAnyModalOpen}
      />

      {/* Achievements Page */}
      {isAchievementsOpen && (
        <DeferredSheet load={loadAchievements} size="lg" title="Goals & rewards" screenProps={{
          unlockedAchievements: achievements,
          onClose: () => setIsAchievementsOpen(false),
          progress: achievementProgress,
          onSharePull: (ref, cards) => setShareTarget({ ref, cards, score: scoreCards(cards) }),
        }} />
      )}

      {/* Hall of Fame Page */}
      {isHallOfFameOpen && (
        <DeferredSheet load={loadHallOfFame} size="lg" title="Rankings" screenProps={{ onClose: () => setIsHallOfFameOpen(false) }} />
      )}

      {isProfileOpen && (
        <DeferredSheet load={loadProfile} size="lg" title="My cards" screenProps={{
          stats,
          navigation: personalNavigation,
          onClose: () => setIsProfileOpen(false),
          onSharePull: (entry, cards) =>
            setShareTarget({
              ref: { setId: entry.setId, setVersion: entry.setVersion, nonce: entry.nonce, publicKeyHex: entry.key },
              cards,
              score: scoreCards(cards),
            }),
        }} />
      )}

      {/* Collection Browser */}
      {isCollectionOpen && (
        <DeferredSheet load={loadCollection} size="lg" title="My cards" screenProps={{ collection, navigation: personalNavigation, onClose: () => setIsCollectionOpen(false) }} />
      )}

      {shareTarget && <DeferredSheet load={loadShare} title="Share your pull" screenProps={{ target: shareTarget, onClose: () => setShareTarget(null) }} />}

      {viewProof && <DeferredSheet load={loadPull} title="Shared pull" screenProps={{ proof: viewProof, onClose: closePullViewer }} />}

      {viewProfile && <DeferredSheet load={loadPublicProfile} size="lg" title="Shared profile" screenProps={{ proof: viewProfile, onClose: closePullViewer }} />}

      {brokenLink && (
        <Sheet title="This link doesn't work" onClose={closePullViewer} size="sm">
          <p className="share-note">
            It looks cut off or changed, maybe when it was copied or pasted. Ask for the link again, or open a pack yourself.
          </p>
        </Sheet>
      )}

      {isPlayerOpen && <DeferredSheet load={loadPlayer} size="sm" title="Player" screenProps={{
        level, settings, onSettingsChange: handleSettingsChange, onClose: () => setIsPlayerOpen(false),
        onOpenGoals: () => openNav('achievements'), onOpenSave: () => openNav('save'),
      }} />}

      {/* Settings Page */}
      {isSettingsOpen && (
        <DeferredSheet load={loadSettings} size="sm" title={settingsSection === 'save' ? 'Save & restore' : 'Sound & display'} screenProps={{
          section: settingsSection,
          settings,
          onSettingsChange: handleSettingsChange,
          onClose: () => setIsSettingsOpen(false),
          onImportSave: handleImportSave,
          saveWarning,
        }} />
      )}
    </div>
  );
}

export default App;

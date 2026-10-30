import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { Settings2 } from 'lucide-react';
import './styles/index.css';
import PackOpener from './components/pack/PackOpener';
import { useAnySheetOpen } from './components/ui/openSheets';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import type { ToastItem } from './components/achievements/AchievementToasts';
import AppNav from './components/ui/AppNav';
import KeptAsideActions from './components/ui/KeptAsideActions';
import AppPage, { type PageSection } from './components/ui/Page';
import DeferredSheet from './components/ui/DeferredSheet';
import { sheetLoader } from './components/ui/sheetEntry';
import SetPicker from './components/sets/SetPicker';
import type { ShareTarget } from './components/share/ShareSheet';
import Sheet from './components/ui/Sheet';
import { RANKINGS_HELP_ID } from './components/ui/rankingsRule';
import CardGuideButton from './components/ui/CardGuideButton';
import PackMilestoneGoal from './components/pack/PackMilestoneGoal';
import { getNextMilestone } from './game/nextMilestone';
import { scoreCards } from './data/cards';
import type { Achievement } from './data/achievements';
import { DEFAULT_SET_ID, SETS } from './content/sets';
import type { SetDefinition } from './engine';
import { canOpenSharedSet } from './game/sharedPullSet';
import { isCardOwned } from './game/versions';
import { warmUpForPack } from './game/warmUp';
import { takePendingPacks, type OpenedPack } from './game/pulls';
import { recordPack, type PackProgress } from './game/packProgress';
import { downloadSaveFile, exportSaveFile, importSaveFile, NEW_PLAYER_PARTIAL_NOTE, PARTIAL_IMPORT_NOTE, STALE_SAVE_WARNING, startNewPlayer } from './game/saveFile';
import { getStoredData } from './utils/storage';
import { readSelectedSet, saveSelectedSet } from './game/selectedSet';
import { collectionRecoveryDismissed, collectionRecoveryNote, collectionRecoveryState, dismissCollectionRecovery } from './game/collectionRecovery';
import { loadStats } from './game/statsRecovery';
import { setMotionSetting } from './utils/motion';
import { readSettings } from './utils/settings';
import { CARD_BACKS, PACK_FOILS, levelUpLine, usable } from './game/progression';
import { myStats } from './game/profiles';
import { historyAchievementsReady, watchMyPacks } from './game/packCache';
import { usePackCacheVersion } from './hooks/usePackCache';
import { playerUnreadable, sameSave, saveMark, watchPlayer, type SaveMark } from './game/player';
import { guardProgress, watchProgress } from './game/progressGuard';
import { isNewsToastId, readNewsToasts } from './game/news';
import { reloadPage } from './game/reload';
import { flushReopenCache } from './game/reopenCache';
import { isStaging, STAGING_NOTE } from './game/staging';
import { PAGE_TITLES, type Page } from './game/route';
import { useNewsToast } from './hooks/useNewsToast';
import { useRoute } from './hooks/useRoute';
import { linkedSetAtLoad, useSetLink } from './hooks/useSetLink';
import { useProgressWriter } from './hooks/useProgressWriter';
import { useAchievementReconciler } from './hooks/useAchievementReconciler';
import type { ProgressWriterHost } from './game/progressWriter';
import { hydrateCollection } from './utils/migrations';
import { STORAGE_KEYS } from './constants';
import { LOGO_MARK_PATH, LOGO_MARK_VIEWBOX } from './styles/logoMark';
import type { CollectionItem, Stats, HallOfFameData, Settings } from './types';

// Keep loaders stable. A page or sheet is requested when its route or state opens it, or a moment
// earlier when the player points at, focuses or presses what opens it: never at startup (unless the
// address opens it) or on idle. The toasts are neither: one is due within seconds of a pack, so
// their fetch is warmed once the sealed pack's art has settled and the page is idle (game/warmUp).
/** The toasts and their styles stay off the first screen's load: fetched ahead of the first pack once idle, or when the first is due. */
const loadToasts = sheetLoader(() => import('./components/achievements/AchievementToasts'));
const loadProfilePage = sheetLoader(() => import('./components/profile/ProfilePage'));
const loadPublicProfile = sheetLoader(() => import('./components/profile/ProfileViewerPage'));
const loadHallOfFame = sheetLoader(() => import('./components/pages/HallOfFamePage'));
const loadSettings = sheetLoader(() => import('./components/pages/SettingsPage'));
const loadNewsPage = sheetLoader(() => import('./components/pages/NewsPage'));
const loadCollection = sheetLoader(() => import('./components/collection/CollectionBrowser'));
const loadShare = sheetLoader(() => import('./components/share/ShareSheet'));
const loadPull = sheetLoader(() => import('./components/share/PullViewerPage'));
const PREFETCH: Partial<Record<Page, () => Promise<unknown>>> = {
  cards: loadCollection, rankings: loadHallOfFame, profile: loadProfilePage, settings: loadSettings,
};
/** The document title on the packs screen: index.html's. */
const OPEN_TITLE = document.title;

const SAVE_WARNING = "Some changes couldn't be saved in this browser and may be lost when you close or reload. Backups only include data already saved.";
/** What adding a pack changes, so several packs can be added before React renders. */

function App() {
  const [collection, setCollection] = useState<Record<string, CollectionItem>>(() => hydrateCollection(getStoredData(STORAGE_KEYS.COLLECTION, {})));
  // Unreadable stats are kept aside and rebuilt (game/statsRecovery.ts), and the tickets they count from
  // the history never count again when their packs come off the pending shelf.
  const [loadedStats] = useState(() => loadStats(collection));
  const [stats, setStats] = useState<Stats>(loadedStats.stats);
  const [hallOfFame, setHallOfFame] = useState<HallOfFameData>(() => getStoredData(STORAGE_KEYS.HALL_OF_FAME, {}));

  const [settings, setSettings] = useState<Settings>(() => readSettings(getStoredData<unknown>(STORAGE_KEYS.SETTINGS, null)));
  const [saveFailed, setSaveFailed] = useState(false);
  const [staleSave, setStaleSave] = useState(false);
  // The save this tab loaded. Another tab can import a save (even the same player's), switch player
  // or clear storage while this one stays open: from then on everything held here is the old save's,
  // so nothing here unlocks achievements from the new player's history or stores progress over the
  // new save (a reload picks that save up). Once the stored save differs it stays changed for this
  // tab, even if the old one comes back: that tab may have written the old save's progress meanwhile.
  // First, before the kept-aside note: reading the player keeps an unreadable record aside (#1052).
  const [mountedSave] = useState(saveMark);
  // A stored player record with no key that can be read: packs stay sealed until it is restored or
  // replaced (Settings > Save & backup).
  const [recordUnreadable] = useState(playerUnreadable);
  const playerChanged = useRef(false);
  const samePlayer = useCallback(() => {
    if (!playerChanged.current && !sameSave(mountedSave, saveMark())) playerChanged.current = true;
    return !playerChanged.current;
  }, [mountedSave]);
  // Unreadable collection data kept aside (game/collectionRecovery), with Download and Discard beside
  // the note: in the banner, and in Settings > Save & backup. A stale tab shows neither (see recoveryCurrent).
  const [recoveryNote, setRecoveryNote] = useState(collectionRecoveryNote);
  // The player can hide the kept-aside note from the banner until something new is kept aside;
  // Settings keeps showing it.
  const [recoveryNoteHidden, setRecoveryNoteHidden] = useState(collectionRecoveryDismissed);
  const showRecoveryNote = !!recoveryNote && !recoveryNoteHidden && !staleSave;
  // One warning for every storage problem in the banner; Settings shows the kept-aside note in Save & backup.
  const saveWarning = [staleSave && STALE_SAVE_WARNING, saveFailed && SAVE_WARNING].filter(Boolean).join(' ') || undefined;
  const bannerWarning = [saveWarning, showRecoveryNote && recoveryNote].filter(Boolean).join(' ') || undefined;
  const hideRecoveryNote = useCallback(() => {
    dismissCollectionRecovery();
    setRecoveryNoteHidden(true);
  }, []);
  // An archive storage won't read may or may not be there: keep whatever note is showing.
  const recoveryChanged = useCallback(() => {
    if (collectionRecoveryState() !== 'unavailable') setRecoveryNote(collectionRecoveryNote());
  }, []);
  // The progress this tab loaded. Another tab of the same player can store packs into it meanwhile (no
  // import or switch, so samePlayer can't tell): everything held here is then older, and storing it would
  // drop that tab's packs, cards and unlocks. As with a changed save, this tab stores no more progress
  // and asks for a reload. Latched like samePlayer.
  const [progress] = useState(guardProgress);
  const progressChanged = useRef(false);
  const progressCurrent = useCallback(() => {
    if (!progressChanged.current && !progress.current()) progressChanged.current = true;
    return !progressChanged.current;
  }, [progress]);
  // For pages that write the save themselves (Profile's name): refuse, and say why, once it changed.
  const canWriteSave = useCallback(() => {
    if (samePlayer()) return true;
    setStaleSave(true);
    return false;
  }, [samePlayer]);
  const packCache = usePackCacheVersion();
  // Every pack in the history is readable (saved packs read in, yours and then other players'), or
  // only other players' failed to: until then, achievements found in the history couldn't name the
  // right pack and date.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const historyReady = useMemo(() => historyAchievementsReady(), [stats.packsOpened, packCache]);
  const [notificationQueue, setNotificationQueue] = useState<ToastItem[]>([]);
  const announceAchievement = useCallback((achievement: Achievement) => {
    setNotificationQueue((prev) => (prev.some((a) => a.id === achievement.id) ? prev : [...prev, achievement]));
  }, []);
  const { achievements, snapshot: achievementsNow, unlock: unlockAchievement } = useAchievementReconciler({
    stats, collection, historyReady, samePlayer, announce: announceAchievement,
  });
  // Stores progress once React commits it, refusing once the save changed under this tab, and owes
  // packs to the pending shelf until a stored collection holds them (see game/progressWriter.ts).
  // The writer reads its host once, so it is memoized (useProgressWriter warns in development if it changes).
  const writerHost = useMemo<ProgressWriterHost>(() => ({
    samePlayer, progressCurrent, noted: progress.noted,
    storing: progress.storing, unstored: progress.unstored, dropped: progress.dropped,
    stale: () => setStaleSave(true),
    failed: () => setSaveFailed(true),
    keptAside: (note, dismissed) => {
      setRecoveryNote(note);
      setRecoveryNoteHidden(dismissed);
    },
  }), [samePlayer, progressCurrent, progress]);
  const { packAdded, packsTaken, putBack } = useProgressWriter({ collection, achievements, stats, hallOfFame, settings }, writerHost);
  // Download and Discard of the kept-aside data, checked on every click and again on the confirm. After
  // another tab's import or player switch the archive can hold that save's data (saveFile keeps it there):
  // discarding would delete its only copy, and a download would mix it with this tab's unsaved payloads.
  // After another tab of this player stored progress, this tab is stale too. Either way the note and its
  // buttons leave with the reload warning up.
  const recoveryCurrent = useCallback(() => {
    if (samePlayer() && progressCurrent()) return true;
    setStaleSave(true);
    putBack();
    return false;
  }, [samePlayer, progressCurrent, putBack]);

  // The page showing (Open has no hash), and any shared link open over it: see useRoute.
  const { route, proof: viewProof, profile: viewProfile, broken: brokenLink, navigate, closePage, closeLink } = useRoute();
  // A part of the page to bring into view (a toast's achievements, Profile's link to Save & backup).
  const [section, setSection] = useState<PageSection>(null);
  const sectionRequests = useRef(0);
  // Focus follows the route only once it changes in this visit: a page loaded directly starts like any page load.
  const [initialRoute] = useState(route);
  const [routeMoved, setRouteMoved] = useState(false);
  if (!routeMoved && route !== initialRoute) setRouteMoved(true);
  const logoRef = useRef<HTMLHeadingElement>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  /** A pack is open, from the tear to leaving it: the chrome steps aside (see index.css). Not busy: it disables nothing. */
  const [packFocus, setPackFocus] = useState(false);
  // The sealed pack falls in the first time it is on screen in a page load (not while hidden under a page); after that it only rises in, even on a new set's opener.
  const [packArrived, setPackArrived] = useState(false);
  const arriveAtPack = useCallback(() => setPackArrived(true), []);
  /** A big pull is on show: notices wait until it ends, so none lands in the player's screenshot. */
  const [packShowcase, setPackShowcase] = useState(false);

  const playableSets = SETS.filter((s) => !s.archivedAt && (!s.draft || settings.showDraftSets));
  const [selectedSetId, setSelectedSetId] = useState<string>(() => linkedSetAtLoad(playableSets) ?? readSelectedSet());
  const selectedSet = playableSets.find((s) => s.id === selectedSetId) ?? playableSets.find((s) => s.id === DEFAULT_SET_ID) ?? playableSets[0];
  const selectSet = useCallback((setId: string) => {
    setSelectedSetId(setId);
    saveSelectedSet(setId);
  }, [setSelectedSetId]);
  // A set's link opens the packs screen on that set (see useSetLink).
  useSetLink(playableSets, packBusy, selectSet);

  // Each page names the tab; back on the packs screen, focus returns to the top of it (the page's
  // own heading takes focus itself, see Page). Back over a pack, the chrome has stepped aside (on a
  // phone the logo too), so focus goes back into the pack: its summary's heading, or else its X.
  useEffect(() => {
    document.title = route === 'open' ? OPEN_TITLE : PAGE_TITLES[route];
    if (route !== 'open' || !routeMoved) return;
    const main = mainRef.current;
    const target = main?.querySelector<HTMLElement>('.summary-title') ?? main?.querySelector<HTMLElement>('.pack-close') ?? logoRef.current;
    target?.focus({ preventScroll: true });
  }, [route, routeMoved]);

  // Saved packs (IndexedDB) are read a page at a time while the app runs, aborted on unmount.
  useEffect(() => watchMyPacks(), []);
  // Hear about another tab's import, player switch or clear before this one next writes (see samePlayer),
  // and warn when storage refuses this tab's ticket count over another tab's lower one.
  useEffect(() => watchPlayer(() => {
    if (!samePlayer()) setStaleSave(true);
  }, () => setSaveFailed(true)), [samePlayer]);
  // And about another tab of this player storing progress (see progressCurrent), so packs stop opening here.
  useEffect(() => watchProgress(() => {
    if (progressCurrent()) return;
    setStaleSave(true);
    putBack();
  }), [progressCurrent, putBack]);
  // Level rewards in use (game/progression.ts), checked against the level this save has reached.
  // Re-read after every pack (myStats reads the pack history, which each pack adds to), and when
  // saved packs are read. Null until they are (or when they couldn't be): meanwhile only the rewards
  // that need no level apply, and the saved choice stays as it is for when the level is known.
  // After another tab switches player (see samePlayer) this tab keeps the level of the player it
  // loaded, as last read: the new player's packs are no level-up here, and unlock no rewards.
  // samePlayer reads its latch ref here on purpose: the level must stop following storage once it does.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/refs
  const ownStats = useMemo(() => (samePlayer() ? myStats() : undefined), [stats.packsOpened, packCache, samePlayer]);
  const [mountedStats, setMountedStats] = useState(ownStats ?? null);
  if (ownStats !== undefined && ownStats !== mountedStats) setMountedStats(ownStats);
  const verifiedStats = ownStats === undefined ? mountedStats : ownStats;
  const level = verifiedStats?.level ?? null;
  const rewardLevel = level ?? 1;
  // The next goal (#212) reads the same stats (a level, a set's cards), so it shows only once they are known.
  const milestoneGoal = useMemo(() => (verifiedStats ? getNextMilestone(verifiedStats, selectedSet) : null), [verifiedStats, selectedSet]);
  // A level-up says so, with what it unlocked (otherwise it only shows if you open the profile).
  // Reading saved packs isn't a level-up: no toast until a known level rises.
  const shownLevel = useRef(level);
  useEffect(() => {
    const from = shownLevel.current;
    shownLevel.current = level;
    if (level === null || from === null || level <= from) return;
    setNotificationQueue((prev) => [
      ...prev,
      {
        id: `level-${level}`,
        kicker: 'Level up',
        name: `Level ${level}`,
        description: levelUpLine(from, level),
        opens: 'profile',
      },
    ]);
  }, [level]);

  // Before paint, so a changed Motion setting never shows a frame of the old one.
  useLayoutEffect(() => setMotionSetting(settings.motion ?? 'auto'), [settings.motion]);

  useEffect(() => {
    document.documentElement.dataset.cardBack = usable(CARD_BACKS, settings.cardBack, rewardLevel);
    document.documentElement.dataset.packFoil = usable(PACK_FOILS, settings.packFoil, rewardLevel);
  }, [settings.cardBack, settings.packFoil, rewardLevel]);

  // Closing a reveal early still records the pack: say where its cards went, ahead of any unlocks.
  // Not when it couldn't be saved: the save warning says so instead (see visibleNotifications).
  const keptNotices = useRef(0);
  const noticeKeptPack = useCallback((pack: OpenedPack) => {
    if (pack.unrecorded) return;
    keptNotices.current += 1;
    const notice: ToastItem = { id: `pack-kept-${keptNotices.current}`, kicker: 'Pack kept', name: 'Its cards are in Cards', description: 'Tap to see them.', opens: 'collection' };
    setNotificationQueue((prev) => [notice, ...prev]);
  }, []);

  // Packs the last visit left mid-reveal, added to the collection on this load: one notice for all of
  // them, not one each. Shown like the early-close one, so a failed or refused save hides it too.
  const noticeRecoveredPacks = useCallback((count: number) => {
    if (count < 1) return;
    keptNotices.current += 1;
    const notice: ToastItem = {
      id: `pack-kept-${keptNotices.current}`,
      kicker: 'Pack kept',
      name: count === 1 ? 'A pack from your last visit is in Cards' : `${count} packs from your last visit are in Cards`,
      description: count === 1 ? 'Tap to see it.' : 'Tap to see them.',
      opens: 'collection',
    };
    setNotificationQueue((prev) => [notice, ...prev]);
  }, []);

  const dismissNotifications = useCallback((ids: string[]) => {
    // A news toast that was shown or opened is read, whichever way it left (its own timer, X, swipe, tap).
    readNewsToasts(ids);
    setNotificationQueue(prev => prev.filter(a => !ids.includes(a.id)));
  }, []);

  /** Start fetching a page on intent, so it is usually there by the click; not while a pack opens. */
  const prefetch = useCallback((page: Page) => {
    if (!packBusy) PREFETCH[page]?.().catch(() => {});
  }, [packBusy]);
  const intent = (page: Page) => ({ onPointerEnter: () => prefetch(page), onFocus: () => prefetch(page), onPointerDown: () => prefetch(page) });

  /** Go to a page (adding a history entry), and to one of its sections when given. */
  const openPage = useCallback((page: Page, sectionId?: string) => {
    setSection(sectionId ? { id: sectionId, n: ++sectionRequests.current } : null);
    navigate(page);
  }, [navigate]);

  /** "How Rankings work", opened and scrolled to, from the notes on why a pull has no Submit. */
  const openRankingsHelp = useCallback(() => openPage('rankings', RANKINGS_HELP_ID), [openPage]);

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
  }, []);

  // Work left on a timer when the app goes away: the reload it no longer needs is dropped, and the
  // reopen cache's batched write lands now rather than after the page is gone.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    flushReopenCache();
  }, []);

  /** Load a backup file (Settings asks first if it would replace a different save). Returns an error to show, if any. */
  const handleImportSave = useCallback((data: string, keepCopy = true, expectedSave?: SaveMark): string | null => {
    if (!samePlayer() || (expectedSave && !sameSave(expectedSave, saveMark()))) {
      setStaleSave(true);
      return STALE_SAVE_WARNING;
    }
    // Without a copy in storage, this file is all that would keep the save if the import is left half done.
    const before = keepCopy ? null : exportSaveFile();
    const error = importSaveFile(data, { keepCopy, expectedSave });
    if (!error) reloadPage();
    else if (error.startsWith(PARTIAL_IMPORT_NOTE)) {
      // The app still holds the save from before; only a reload shows what storage now holds.
      if (before !== null && window.confirm(`${error}\n\nDownload the save from before the import first? OK downloads it, then reloads.`)) {
        downloadSaveFile(before);
        reloadTimer.current = setTimeout(reloadPage, 1000); // give the download a moment to start
      } else {
        if (before === null) window.alert(error);
        reloadPage();
      }
    }
    return error;
  }, [samePlayer]);

  /** Start a new player in place of an unreadable record (Settings asks first). Returns an error to show, if any. */
  const handleStartNewPlayer = useCallback((): string | null => {
    if (!samePlayer()) {
      setStaleSave(true);
      return STALE_SAVE_WARNING;
    }
    const error = startNewPlayer({ expectedSave: mountedSave });
    if (error === STALE_SAVE_WARNING) setStaleSave(true);
    if (!error) reloadPage();
    else if (error === NEW_PLAYER_PARTIAL_NOTE) {
      // The app still holds the save from before; only a reload shows what storage now holds.
      window.alert(error);
      reloadPage();
    }
    return error;
  }, [samePlayer, mountedSave]);

  const handlePackOpened = useCallback((pack: OpenedPack, from: PackProgress = { stats, collection, hallOfFame }): PackProgress => {
    packAdded(pack);
    if (pack.unrecorded) setSaveFailed(true);
    // Compute progress in the event handler; React state updaters stay free of side effects.
    const { progress, unlocks } = recordPack(from, pack, achievementsNow());
    if (progress.stats !== from.stats) setStats(progress.stats);
    setCollection(progress.collection);
    setHallOfFame(progress.hallOfFame);
    const pullRef = { setId: pack.setId, setVersion: pack.setVersion, nonce: pack.nonce, publicKeyHex: pack.publicKeyHex };
    unlocks.forEach(id => unlockAchievement(id, pack.cards, pullRef));
    return progress;
  }, [stats, hallOfFame, collection, unlockAchievement, achievementsNow, packAdded]);

  // Packs whose reveal never finished (a reload, a closed tab): their tickets are spent, so they still count.
  // Once per mount: an older build's pack stays in its entry until stored, so a second take would add it again.
  const pendingTaken = useRef(false);
  useEffect(() => {
    if (pendingTaken.current) return;
    pendingTaken.current = true;
    const taken = takePendingPacks().map((pack) => (loadedStats.counted.has(pack.nonce) ? { ...pack, counted: true } : pack));
    // Rebuilt stats replace the unreadable ones at once (their copy is kept aside first), so a discard
    // sticks and an export finds them readable; the writer stores them after the packs taken here. Once
    // per mount, like the packs: a new copy of the same stats is what has the writer store them. Not
    // while the player record is unreadable: they were rebuilt from a stand-in key's empty history, and
    // no pack can open until a backup or a new player replaces the record (and the page reloads).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (loadedStats.rebuilt && !recordUnreadable) setStats((current) => ({ ...current }));
    packsTaken(taken);
    taken.reduce<PackProgress | undefined>((from, pack) => handlePackOpened(pack, from), undefined);
    // Not for a tab already known to be stale: it stores nothing, and the notice would flash before the warning.
    if (samePlayer() && progressCurrent()) noticeRecoveredPacks(taken.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sharePack = useCallback((pack: OpenedPack) => {
    setShareTarget({ ref: { setId: pack.setId, setVersion: pack.setVersion, nonce: pack.nonce, publicKeyHex: pack.publicKeyHex }, cards: pack.cards, score: pack.score });
  }, []);

  // For the NEW sticker: the collection as it was before the pack being opened.
  const isOwned = useCallback((cardKey: string) => isCardOwned(collection[cardKey]), [collection]);

  // Progress shown on the counting achievements that are still locked.
  const achievementProgress = useMemo(() => {
    const packs = stats.packsOpened || 0;
    const items = Object.values(collection).filter(isCardOwned);
    const unique = items.length;
    const holos = items.reduce((n, item) => n + (item?.holoCount || 0), 0);
    const out: Record<string, [number, number, string]> = {};
    for (const n of [10, 41, 67, 100, 420, 1000]) out[`packs_${n}`] = [packs, n, 'packs'];
    for (const n of [5, 10]) out[`collect_${n}`] = [unique, n, 'cards'];
    for (const n of [25, 100]) out[`total_holos_${n}`] = [holos, n, 'holos'];
    return out;
  }, [stats.packsOpened, collection]);

  // A collection write can fail, or be refused for a stale tab, after its pack's notice is queued: once
  // a save warning shows, the "Pack kept" notice would contradict it, so it never shows (neither clears).
  // A news toast waits behind the save warning too: the toast region sits over the banner, so it would
  // cover the warning and its buttons. It stays queued and comes in once the warning is gone.
  const visibleNotifications = useMemo(
    () => {
      const warned = saveFailed || staleSave;
      return warned || bannerWarning ? notificationQueue.filter((toast) => !(warned && toast.id.startsWith('pack-kept-')) && !isNewsToastId(toast.id)) : notificationQueue;
    },
    [saveFailed, staleSave, bannerWarning, notificationQueue],
  );
  const isAnyModalOpen = !!shareTarget || !!viewProof || !!viewProfile;
  // Any sheet at all (the summary's card close-up too): a toast over one covers its title or takes a tap meant for it (#803).
  const anySheetOpen = useAnySheetOpen();
  const reducedMotion = usePrefersReducedMotion();
  // Once loaded they stay mounted, so the last toast can still fade or fly out. A failed fetch is asked
  // again when the next toast is due; the queue keeps what was waiting.
  const [toastsLoaded, setToastsLoaded] = useState(!!loadToasts.loaded);
  const toastsDue = visibleNotifications.length > 0;
  // Ahead of the first pack, so opening one offline still gets its toast; a failure is left to the due-fetch below.
  useEffect(() => {
    if (toastsLoaded) return;
    let live = true;
    const cancel = warmUpForPack(() => {
      loadToasts().then(() => live && setToastsLoaded(true), () => {});
    });
    return () => {
      live = false;
      cancel();
    };
  }, [toastsLoaded]);
  useEffect(() => {
    if (toastsLoaded || !toastsDue) return;
    let live = true;
    loadToasts().then(() => live && setToastsLoaded(true), () => {});
    return () => {
      live = false;
    };
  }, [toastsLoaded, toastsDue, visibleNotifications]);
  const AchievementToasts = toastsLoaded ? loadToasts.loaded : undefined;
  // A sheet (Share, or a shared link) leaves no tab current; Settings is none of the tabs either.
  const activeTab = shareTarget || viewProof || viewProfile || brokenLink ? null : route;
  // A new player sees only the logo and the pack until their first pack is saved (#222, #312): no tabs,
  // no set picker. A save with cards but no pack count (an old one, or stats that couldn't be read) is
  // not a new player's. A pack is saved in focus mode (which hides both) or as the player leaves it, so
  // neither appears mid-reveal. A torn pack left while its ticket is on its way (busy, out of focus mode)
  // is theirs already: both come back with the chrome then, not later under the player when it lands.
  // A pack whose save failed still counts in memory, so its cards stay reachable this session. If the
  // pending shelf kept it, the next load restores and counts it, so the tabs show at once; only a total
  // storage refusal makes the next load a new player's. Settings' "Show every page" switch brings both
  // back at once for someone who knows the game (#222); once the pages are there on their own, Settings
  // leaves the switch out (#902), so it asks the same question.
  const pagesUnlocked = (stats.packsOpened || 0) > 0 || Object.values(collection).some(isCardOwned) || (packBusy && !packFocus);
  const showNav = pagesUnlocked || settings.showAllPages === true;
  const onPage = route !== 'open';
  // Settings shows these problems in its own sections, so the banner leaves it.
  const saveWarningShown = !!bannerWarning && route !== 'settings';
  // The latest unread announcement, once, as a toast behind the others: only after a pack is put away in this visit, and while the pack screen is at rest.
  const announceToast = useCallback((toast: ToastItem) => {
    setNotificationQueue((prev) => (prev.some((t) => t.id === toast.id) ? prev : [...prev, toast]));
  }, []);
  const withdrawNewsToast = useCallback(() => {
    setNotificationQueue((prev) => (prev.some((t) => isNewsToastId(t.id)) ? prev.filter((t) => !isNewsToastId(t.id)) : prev));
  }, []);
  useNewsToast({ atRest: pagesUnlocked && route !== 'news', packOpen: packBusy || packFocus, viewing: route === 'news', announce: announceToast, withdraw: withdrawNewsToast });
  const logoMark = (
    <svg className="app-logo-mark" viewBox={LOGO_MARK_VIEWBOX} aria-hidden="true" focusable="false">
      <path fill="currentColor" d={LOGO_MARK_PATH} />
    </svg>
  );
  const logoChars = 'Brainrot TCG'.split('').map((char, i) =>
    char === ' ' ? (
      <span key={i} className="title-space" aria-hidden="true" />
    ) : (
      <span key={i} className="title-char" aria-hidden="true" style={{ animationDelay: `${i * 0.08}s` }}>
        {char}
      </span>
    ),
  );

  return (
    <div className={`app${packFocus && !onPage ? ' is-focus' : ''}${showNav ? '' : ' no-nav'}`} data-toasts-ready={toastsLoaded || undefined}>
      {isStaging() && <p role="note" className="save-warning staging-banner">{STAGING_NOTE}</p>}
      {saveWarningShown && (
        <p role="alert" className="save-warning save-warning--capped">
          {bannerWarning}
          {staleSave && <button type="button" ref={reloadRef} className="link-btn save-warning-action quiet-focus" onClick={() => reloadPage()}>Reload</button>}
          {showRecoveryNote && (
            <>
              <KeptAsideActions variant="banner" canAct={recoveryCurrent} onGone={() => {
                recoveryChanged();
                // The note and its buttons leave: focus goes to the open page's heading, or the logo.
                (document.querySelector<HTMLElement>('.page-title') ?? logoRef.current)?.focus();
              }} onChanged={recoveryChanged} onLeave={() => {
                (reloadRef.current ?? document.querySelector<HTMLElement>('.page-title') ?? logoRef.current)?.focus();
              }} />
              <button type="button" className="link-btn save-warning-action" onClick={() => {
                hideRecoveryNote();
                // The note and its buttons leave: focus goes to the open page's heading, or the logo.
                (document.querySelector<HTMLElement>('.page-title') ?? logoRef.current)?.focus();
              }}>Hide note</button>
            </>
          )}
        </p>
      )}
      <header className="app-header">
        {/* One h1 per view: the logo on the packs screen; on a page, that page's title (see Page). */}
        {onPage ? (
          <a
            className="app-logo app-logo--link"
            href={import.meta.env.BASE_URL}
            aria-label="Brainrot TCG, home"
            onClick={(e) => {
              // Let the browser handle modified clicks (new tab, window); a plain one is the Packs tab.
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              openPage('open');
            }}
          >{logoMark}{logoChars}</a>
        ) : (
          <h1 ref={logoRef} className="app-logo" aria-label="Brainrot TCG" tabIndex={-1}>{logoMark}{logoChars}</h1>
        )}
        {showNav && <AppNav onOpen={openPage} onPrefetch={prefetch} active={activeTab} />}
        <div className="app-utilities">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            {...intent('settings')}
            onClick={() => openPage('settings')}
            disabled={packBusy}
            aria-label="Settings"
            title="Settings"
            aria-current={route === 'settings' ? 'page' : undefined}
          >
            <Settings2 aria-hidden="true" size={20} />
          </button>
        </div>
      </header>

      {/* Right under the header, and the save warning when it shows: a toast takes no room: on a phone it lies over the header, on a wide screen it is at the top right, narrowed to clear the pack (Toasts.css). Held while a pack is torn and revealed, so it is never over the pack. */}
      <div className="toast-region" role="status" aria-live="polite">
        {AchievementToasts && (
          <AchievementToasts
            queue={visibleNotifications}
            onDismiss={dismissNotifications}
            onOpen={(target) => (target === 'collection' ? openPage('cards') : target === 'news' ? openPage('news') : openPage('profile', target === 'achievements' ? 'achievements' : 'rewards'))}
            paused={isAnyModalOpen || onPage || anySheetOpen || packBusy}
            held={packShowcase}
            reduced={reducedMotion}
          />
        )}
      </div>

      {/* Stays mounted under a page, so a pack in progress is still there on the way back. */}
      <main ref={mainRef} className="app-main" hidden={onPage} inert={onPage}>
        {showNav && <SetPicker sets={playableSets} selectedId={selectedSet.id} onSelect={selectSet} collection={collection} disabled={packBusy} />}
        <PackOpener
          key={selectedSet.id}
          onOpen={handlePackOpened}
          onShare={sharePack}
          onBusyChange={setPackBusy}
          onFocusChange={setPackFocus}
          onShowcaseChange={setPackShowcase}
          set={selectedSet}
          disabled={isAnyModalOpen || onPage}
          openBlocked={staleSave}
          mountedSave={mountedSave}
          onOpenSave={() => openPage('settings', 'save-backup')}
          onOpenRankingsHelp={openRankingsHelp}
          settings={settings}
          cardBack={usable(CARD_BACKS, settings.cardBack, rewardLevel)}
          isOwned={isOwned}
          onLeaveEarly={noticeKeptPack}
          openCue={!showNav}
          arrived={packArrived}
          onArrive={arriveAtPack}
          shown={!onPage}
        />
        {/* A quiet way into the card guide once a first pack is saved (a new player sees only the pack); it steps aside with the chrome once a pack is torn. */}
        {showNav && !packFocus && !packBusy && (
          <div className="card-guide-entry">
            <CardGuideButton set={selectedSet} />
            {/* The next goal (#212) takes the row beside the guide link. */}
            {pagesUnlocked && !saveWarningShown && milestoneGoal && (
              <PackMilestoneGoal
                goal={milestoneGoal}
                onNavigate={(target) => (target === 'rewards' ? openPage('profile', 'rewards') : openPage('cards'))}
                disabled={isAnyModalOpen}
              />
            )}
          </div>
        )}
      </main>

      {route === 'cards' && (
        <AppPage load={loadCollection} title="Cards" onClose={closePage} autoFocus={routeMoved} screenProps={{ collection, recentSetId: selectedSet.id }} />
      )}

      {route === 'rankings' && (
        <AppPage load={loadHallOfFame} title="Rankings" skeleton="rows" section={section} onClose={closePage} autoFocus={routeMoved} screenProps={{ section }} />
      )}

      {route === 'profile' && (
        <AppPage load={loadProfilePage} title="Profile" section={section} onClose={closePage} autoFocus={routeMoved} screenProps={{
          stats,
          level,
          settings,
          onSettingsChange: handleSettingsChange,
          unlockedAchievements: achievements,
          achievementProgress,
          onSharePull: (entry, cards) =>
            setShareTarget({
              ref: { setId: entry.setId, setVersion: entry.setVersion, nonce: entry.nonce, publicKeyHex: entry.key },
              cards,
              score: scoreCards(cards),
            }),
          onSharePack: (ref, cards) => setShareTarget({ ref, cards, score: scoreCards(cards) }),
          onShareAchievementPull: (ref, cards) => setShareTarget({ ref, cards, score: scoreCards(cards) }),
          onOpenSave: () => openPage('settings', 'save-backup'),
          onOpenPacks: () => openPage('open'),
          canSave: canWriteSave,
          onSaveFailed: () => setSaveFailed(true),
          section,
        }} />
      )}

      {route === 'settings' && (
        <AppPage load={loadSettings} title="Settings" width="md" section={section} onClose={closePage} autoFocus={routeMoved} screenProps={{
          settings,
          onSettingsChange: handleSettingsChange,
          onImportSave: handleImportSave,
          saveWarning,
          onReload: staleSave ? () => reloadPage() : undefined,
          recoveryNote: staleSave ? undefined : recoveryNote,
          recoveryAllowed: recoveryCurrent,
          onRecoveryChanged: recoveryChanged,
          playerUnreadable: recordUnreadable && !staleSave,
          onStartNewPlayer: handleStartNewPlayer,
          guideSet: selectedSet,
          pagesUnlocked,
          onOpenNews: () => openPage('news'),
        }} />
      )}

      {route === 'news' && <AppPage load={loadNewsPage} title="What's new" width="md" onClose={closePage} autoFocus={routeMoved} screenProps={{}} />}

      {shareTarget && <DeferredSheet load={loadShare} title="Share your pull" screenProps={{ target: shareTarget, onClose: () => setShareTarget(null), onOpenRankingsHelp: openRankingsHelp }} />}

      {viewProof && <DeferredSheet key={viewProof} load={loadPull} title="Shared pull" screenProps={{
        proof: viewProof,
        onClose: closeLink,
        // Not while a pack is open: the set can't change under it.
        canOpenSet: (s: SetDefinition) => canOpenSharedSet(s, playableSets, packBusy),
        onOpenSet: (setId: string) => {
          selectSet(setId);
          closeLink();
        },
      }} />}

      {viewProfile && <DeferredSheet load={loadPublicProfile} size="lg" title="Shared profile" screenProps={{ proof: viewProfile, onClose: closeLink }} />}

      {brokenLink && (
        <Sheet title="This link doesn't work" onClose={closeLink} size="sm">
          <p className="share-note">
            It looks cut off or changed, maybe when it was copied or pasted. Ask for the link again, or open a pack yourself.
          </p>
        </Sheet>
      )}

    </div>
  );
}

export default App;

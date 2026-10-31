import type { ComponentProps } from 'react';
import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence, useIsPresent } from 'framer-motion';
import type { CardWithMeta } from '../cards/Card';
import type { Settings } from '../../types';
import type { SetDefinition } from '../../engine';
import { openPack, prefetchNextPack, type OpenedPack, type PullRef } from '../../game/pulls';
import { holdLive } from '../../game/admission';
import { reloadPage } from '../../game/reload';
import { whenIdle } from '../../game/idle';
import { buzz, prefersReducedMotion } from '../../utils/motion';
import { useOpenCue } from '../../hooks/useOpenCue';
import { usePackCutter } from '../../hooks/usePackCutter';
import { useAudio } from '../../hooks/useAudio';
import { useKeyboardControls } from '../../hooks/useKeyboardControls';
import { useStageClickGuard } from '../../hooks/useStageClickGuard';
import { usePackHistory } from '../../hooks/usePackHistory';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { BRAINROT_VOICES, EFFECT_SOUNDS, CARD_FLIP_SRC, EFFECT_DELAY_MS } from '../../constants/audio';
import { effectsLevel } from '../../utils/settings';
import PackCuttingUI from './PackCuttingUI';
import CardRevealUI from './CardRevealUI';
import PackSummaryUI, { type PackChoices } from './PackSummaryUI';
import PackTopBar from './PackTopBar';
import ShowcaseRibbon from './ShowcaseRibbon';
import { revealAnnouncement } from '../cards/cardLabel';
import { REFUSAL_COPY } from './refusal';
import { usePackLifecycle } from './usePackLifecycle';
import { stageEntrance } from './stageEntrance';
import { loadConfetti } from './loadConfetti';
import { packImageUrl } from '../../content/art';
import { PlayerUnreadableError, StaleSaveError, type SaveMark } from '../../game/player';
import { isBigPull, isSpecialReveal, markNew, nextSpecialRevealIndex, revealOrder, SPECIAL_REVEAL_DURATION_MS } from '../../game/reveal';
import '../../styles/PackOpener.css';

const Motion = motion;

/**
 * A stage inside the pack/reveal AnimatePresence that takes itself out of the flow the render it
 * starts leaving (PackOpener.css, `.lifted[data-leaving]`), so it overlaps whatever comes in. This is
 * what AnimatePresence's popLayout mode does, but popLayout measures the leaving element in the commit
 * that drops it (framer-motion 14 reads its computed style), and that commit is the one that brings
 * the first card in: the browser lays the page out there, in the middle of the longest stall on a
 * slow phone (#266). The attribute is rendered, so nothing is read.
 */
const Lifted = ({ className, ...props }: ComponentProps<typeof Motion.div>) => {
  const present = useIsPresent();
  return <Motion.div {...props} className={`lifted ${className ?? ''}`} data-leaving={present ? undefined : ''} />;
};

/**
 * Where the sealed pack's stage rests. It names the scale its exit grows: a stage the player brings back
 * after the exit finished but before React took it away is the same element, at the exit's end, and
 * framer leaves a value no state names where it is, so it stayed at 1.25 for good.
 */
const STAGE_AT_REST = { y: 0, opacity: 1, rotate: 0, scale: 1 };

/**
 * Focus follows the stage (#312) onto a control that just appeared, unless the player has put it
 * somewhere else on the page: only from nowhere (the control it was on just went) or from the pack.
 */
const focusIfFree = (el: HTMLElement | null) => {
  if (!el) return;
  const active = document.activeElement;
  if (!active || active === document.body || active.closest('.pack-opener-container')) el.focus({ preventScroll: true });
};

/** The pack as the engine dealt it, face up: what's recorded and shared (the reveal order is only for show). */
const faceUp = (pack: OpenedPack): OpenedPack => ({ ...pack, cards: pack.cards.map((card) => ({ ...card, isRevealed: true })) });

interface PreloadedAssets {
  brainrotVoices: HTMLAudioElement[];
  cardFlip: HTMLAudioElement;
  effects: HTMLAudioElement[];
}

interface PackOpenerProps {
  /** Called once every card has been revealed. */
  onOpen: (pack: OpenedPack) => void;
  onShare: (pack: OpenedPack) => void;
  /** True while a pack is being opened (its ticket is spent but it isn't recorded yet). */
  onBusyChange?: (busy: boolean) => void;
  /** True from the tear until the player leaves the pack (while its X shows): the app's focus mode. */
  onFocusChange?: (focus: boolean) => void;
  /**
   * True while a revealed big pull is being showcased (its ribbon and halo are up), or a skip is on
   * its way to the next one: the app holds its notices.
   */
  onShowcaseChange?: (showcase: boolean) => void;
  set: SetDefinition;
  /** The other packs the summary can point to ("Try another pack"); left out, it doesn't. */
  packChoices?: PackChoices;
  /** Mounted by a pick from the summary's Packs sheet: the opener it came from has gone, so the new sealed pack takes focus. */
  focusPackOnMount?: boolean;
  disabled?: boolean;
  /** No new pack may start (the save changed in another tab); one already opening still finishes. */
  openBlocked?: boolean;
  /** The save this tab loaded: a tear claims a ticket only while storage still holds it. */
  mountedSave?: SaveMark;
  settings: Settings;
  /** The chosen, unlocked back, shared by the active card and the remaining stack. */
  cardBack?: string;
  /** Whether the collection already had this card before the pack (for the NEW sticker). */
  isOwned?: (cardKey: string) => boolean;
  /** The player closed a reveal with cards still face down; they're recorded anyway, so say so (unless the save failed). */
  onLeaveEarly?: (pack: OpenedPack) => void;
  /** No pack is saved yet: the sealed pack plays its opening cue (a finger tearing along the seam) a couple of times. */
  openCue?: boolean;
  /**
   * The sealed pack has already come into the packs screen once in this page load, so it only rises in
   * (stageEntrance.ts). It outlives this opener, which a set change remounts; left out, the first stage falls.
   */
  arrived?: boolean;
  /** The sealed pack's stage was shown for the first time. */
  onArrive?: () => void;
  /**
   * The packs screen is on screen. It stays mounted, hidden, under a page, so a load straight into one
   * (#/cards) mounts the stage unseen: it waits at its starting place until the screen is shown, and its
   * entrance plays then.
   */
  shown?: boolean;
  /** Go to Settings, Save & backup: where an unreadable player record's refusal sends the player. */
  onOpenSave?: () => void;
  /** Go to Rankings' "How Rankings work", from the results screen's note on why a pull has no Submit. */
  onOpenRankingsHelp?: () => void;
}

const PackOpener = ({ onOpen, onShare, onBusyChange, onFocusChange, onShowcaseChange, set, packChoices, focusPackOnMount = false, disabled = false, openBlocked = false, mountedSave, settings, cardBack, isOwned, onLeaveEarly, openCue = false, arrived = false, onArrive, shown = true, onOpenSave, onOpenRankingsHelp }: PackOpenerProps) => {
  // Where the pack is, from the tear to the packs screen (packLifecycle.ts). What the stage doesn't say is
  // the reveal's own state below: which card is up, what is locked, what is being celebrated.
  const [stage, send] = usePackLifecycle();
  const isPackCut = stage.kind !== 'sealed';
  const isOpening = stage.kind === 'revealing' || stage.kind === 'summary';
  const showSummary = stage.kind === 'summary';
  const reducedMotion = usePrefersReducedMotion();
  // The stage falls in once and rises in after that: it has landed once it has been on screen.
  const [landed, setLanded] = useState(arrived);
  const markLanded = () => {
    if (landed) return;
    setLanded(true);
    onArrive?.();
  };
  // The first fall passes over the header and any warning above the stage. Until it first reaches its place
  // the stage takes no presses (PackOpener.css), so a tap aimed at the Settings gear or a banner's Download
  // then reaches them, not the pack falling past. From there it only settles, so a tap on the pack lands.
  // Reduced motion puts it in its place at once, so it never passes over them.
  const [falling, setFalling] = useState(!arrived);
  const reachedPlace = useRef(arrived);
  const markInPlace = () => {
    if (reachedPlace.current) return;
    reachedPlace.current = true;
    setFalling(false);
  };
  /** Why the last tear didn't open a pack, shown under it with a way to try again. */
  const refusal = stage.kind === 'sealed' ? stage.refusal : null;
  /** The player left a torn pack while its ticket was still being worked out: keep it, don't show it. */
  const leavingOpen = stage.kind === 'waiting' && stage.leaving !== false;
  const [openedPack, setOpenedPack] = useState<OpenedPack | null>(null);
  const [openedCards, setOpenedCards] = useState<CardWithMeta[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [preloadedAssets, setPreloadedAssets] = useState<PreloadedAssets | null>(null);
  const [revealLocked, setRevealLocked] = useState(false);
  const [celebratingCardId, setCelebratingCardId] = useState<CardWithMeta['uniqueId'] | null>(null);
  const [skipping, setSkipping] = useState(false);
  const packDesign = packImageUrl(set.id);
  const [hasMovedMouse, setHasMovedMouse] = useState(false);
  const effectsVolume = effectsLevel(settings.effectsVolume);
  const pauseBigPulls = settings.pauseBigPulls !== false;

  /** When the player left while a ticket was still mining and then taps or swipes the pack, say it is opening. */
  const [leavingWaiting, setLeavingWaiting] = useState(false);

  const { playAndCleanup, preloadAudio, loadDeferred, cleanupAudio, playRandom, stopAll } = useAudio();

  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleInteractionRef = useRef<() => void>(() => {});
  // Set synchronously before React renders: rapid taps and held keys share the same guard.
  const revealLockedUntilRef = useRef(0);
  const celebrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const effectTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  /** The card whose confetti is still on its way (a slow import), so a late arrival can tell it's out of date. */
  const burstForRef = useRef<CardWithMeta['uniqueId'] | null>(null);
  const skippingRef = useRef(false);
  /** What a ticket that lands after the player left needs, as of the latest render. */
  const preloadedRef = useRef<PreloadedAssets | null>(null);
  const landingRef = useRef({ onOpen, onLeaveEarly, resetCutState: () => {} });
  /** Whether a tear may still spend its ticket, as of the latest render (see handleCutComplete). */
  const openBlockedRef = useRef(openBlocked);

  const startOpening = useCallback(async () => {
    let pack: OpenedPack;
    try {
      // Usually instant: the ticket was mined while the pack was on screen.
      pack = await openPack(set, mountedSave);
    } catch (error) {
      // Another tab replacing the save mid-open is a refusal the pack states, as when it lands before the
      // tear; only a real failure is an error (#1139).
      if (!(error instanceof StaleSaveError)) console.error('Could not open pack', error);
      const { from } = send({ type: 'failed', refusal: error instanceof PlayerUnreadableError ? 'unreadable' : error instanceof StaleSaveError || openBlockedRef.current ? 'blocked' : 'failed' });
      // Already back on the packs screen: nothing was dealt, so there's nothing to say.
      if (from.kind === 'waiting' && from.leaving === 'left') landingRef.current.resetCutState();
      return;
    }
    const landed = send({ type: 'landed', pack });
    if (landed.record) {
      // The player left while it was on its way: the pack is recorded face up, as leaving a reveal
      // early does, and the "Pack kept" notice says where its cards went. An opener that unmounted
      // has no packs screen to go back to or notice to show: only the record is left.
      const { onOpen: record, onLeaveEarly: kept, resetCutState: reset } = landingRef.current;
      const dealt = faceUp(landed.record);
      record(dealt);
      if (landed.from.kind === 'waiting' && landed.from.leaving === 'left') {
        kept?.(dealt);
        reset();
      }
      return;
    }
    if (landed.stage === landed.from) return;
    // Fetched once the reveal is on screen (below), so they don't hold up its card backs.
    const brainrotVoices = preloadAudio(BRAINROT_VOICES, { defer: true });
    const cardFlip = preloadAudio([CARD_FLIP_SRC], { defer: true })[0];
    const effects = preloadAudio(EFFECT_SOUNDS, { defer: true });

    // Also kept in a ref: a leave before React renders this still cleans them up (finishPack).
    preloadedRef.current = { brainrotVoices, cardFlip, effects };
    setPreloadedAssets(preloadedRef.current);
    setOpenedPack(pack);
    // Shown rarest last, with NEW on cards the collection didn't have yet. The pack itself (and its
    // proof and history) keeps the engine's order.
    setOpenedCards(markNew(revealOrder(pack.cards), (key) => isOwned?.(key) ?? true));
    setCurrentIndex(0);
  }, [set, mountedSave, preloadAudio, isOwned, send]);

  // The reveal's sounds download once it has been drawn and the page is idle, and not at all while
  // effects are muted (each one only plays when effectsVolume > 0).
  const effectsOn = effectsVolume > 0;
  useEffect(() => {
    if (!isOpening || !preloadedAssets || !effectsOn) return;
    return whenIdle(() => loadDeferred([preloadedAssets.cardFlip, ...preloadedAssets.effects, ...preloadedAssets.brainrotVoices]));
  }, [isOpening, preloadedAssets, loadDeferred, effectsOn]);

  // Fetched as the reveal opens, well before its first flip, so the first burst isn't held up. Not
  // under reduced motion, which never bursts.
  const particlesOn = settings.particlesEnabled && !reducedMotion;
  useEffect(() => {
    if (isOpening && particlesOn) loadConfetti().catch(() => {});
  }, [isOpening, particlesOn]);

  // Mine the next pack's ticket while this one is on screen. Its art is fetched only if nothing covers
  // Open when this runs, so a cover's change runs it again. A fetch already under way carries on
  // through those changes; only unmounting stops it, so no picture loads into a page that is gone.
  const mounted = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!isOpening) prefetchNextPack(set, disabled, mounted.current?.signal);
  }, [isOpening, set, disabled]);

  // From the tear on, the ticket is spent: the app mustn't swap sets (or open a sheet over it) until
  // the pack is recorded. The ticket can still be mining here on a slow phone.
  // The summary comes after it's recorded, so it isn't busy (focus mode still hides the chrome there).
  // It changes before paint, as the stage below lets go of its size.
  const busy = (isOpening && !showSummary) || (isPackCut && !isOpening);
  useLayoutEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  // Mining taking a while: say so, rather than leave a torn pack sitting still.
  const [slowOpen, setSlowOpen] = useState(false);
  /**
   * A press on the pack landed below the band a swipe can start in ('miss'), or a swipe was let go too
   * short to open ('short'), so it shows where, or how, to swipe for a moment. A tap opens the pack.
   */
  const [nudging, setNudging] = useState<false | 'miss' | 'short'>(false);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudge = useCallback((kind: 'miss' | 'short') => {
    setNudging(kind);
    if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = setTimeout(() => setNudging(false), 1800);
  }, []);
  const nudgeMiss = useCallback(() => nudge('miss'), [nudge]);
  const nudgeShort = useCallback(() => nudge('short'), [nudge]);
  useEffect(() => {
    if (!isPackCut || isOpening) return;
    const timer = window.setTimeout(() => setSlowOpen(true), 1200);
    return () => {
      window.clearTimeout(timer);
      setSlowOpen(false);
    };
  }, [isPackCut, isOpening]);

  /** A swipe on a pack another tab holds the save for answers as a tap does (handleOpen, below). */
  const handleOpenRef = useRef<() => void>(() => {});
  const swipeBlocked = useCallback(() => handleOpenRef.current(), []);

  const handleCutComplete = useCallback(() => {
    if (leavingOpen) {
      landingRef.current.resetCutState();
      setLeavingWaiting(true);
      return;
    }
    const torn = send({ type: 'tear' });
    if (torn.stage === torn.from) return;
    // A key can tear the pack mid-fall. The fall's watch reads the stage each frame, which must stop
    // before the wait for the cards, the longest stall on a slow phone (#266).
    reachedPlace.current = true;
    setFalling(false);
    if (openTimeoutRef.current) {
      window.clearTimeout(openTimeoutRef.current);
    }
    openTimeoutRef.current = window.setTimeout(() => {
      openTimeoutRef.current = null;
      // Another tab may have changed the save since the tear: then the pack goes back sealed rather than
      // spend a ticket this tab can't store, and says why.
      const spent = send({ type: 'spend', blocked: openBlockedRef.current });
      if (spent.stage.kind === 'sealed') landingRef.current.resetCutState();
      // Started: from here the ticket is spent, so leaving keeps the pack rather than cancelling it.
      else if (spent.stage !== spent.from) void startOpening();
    }, 460);
  }, [startOpening, send, leavingOpen]);

  const {
    packRef,
    isCutting,
    isPressing,
    cutPoints,
    sparkCanvasRef,
    resetCutState,
    completeCut,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    endCutAttempt,
    cleanup: cleanupCutter,
  } = usePackCutter({
    onCutComplete: handleCutComplete,
    isOpening,
    isPackCut: isPackCut && !leavingOpen,
    volume: leavingOpen ? 0 : effectsVolume,
    particlesEnabled: settings.particlesEnabled,
    disabled,
    blocked: openBlocked,
    onMiss: nudgeMiss,
    onShortSwipe: nudgeShort,
    onBlockedSwipe: swipeBlocked,
  });

  const resetCut = useCallback(() => {
    setLeavingWaiting(false);
    resetCutState();
  }, [resetCutState]);

  useEffect(() => {
    landingRef.current = { onOpen, onLeaveEarly, resetCutState: resetCut };
  });

  useEffect(() => {
    openBlockedRef.current = openBlocked;
  });

  // From the first swipe until the summary, re-opening and checking other pulls start no new ticket
  // (one already mining finishes), so this pack's ticket and animations get the device; the summary
  // then holds them until its cards have decoded (PackSummaryUI). Not while a
  // sheet covers the pack: a check opened there (a shared pull or profile link) shouldn't wait for a
  // reveal it hides. This pack's own ticket still holds while it mines (ticketMiner).
  const live = !disabled && (isCutting || (isOpening && !showSummary) || (isPackCut && !isOpening));
  useEffect(() => (live ? holdLive() : undefined), [live]);

  // A pack that refused to open can be torn again, as its refusal offers.
  useEffect(() => {
    if (refusal) resetCutState();
  }, [refusal, resetCutState]);

  /**
   * A tap, a click, or Space or Enter with focus on the pack: exactly a finished swipe, through the
   * same cut, tear and ticket. A save another tab changed opens nothing, and says so.
   */
  const { cue, end: endCue, touch: touchPack } = useOpenCue(openCue);
  const handleOpen = useCallback(() => {
    if (disabled || isOpening) return;
    if (leavingOpen) {
      touchPack();
      setLeavingWaiting(true);
      return;
    }
    if (isPackCut) return;
    touchPack();
    if (openBlocked) {
      send({ type: 'refuse', refusal: 'blocked' });
      return;
    }
    completeCut();
  }, [disabled, isOpening, leavingOpen, isPackCut, openBlocked, completeCut, touchPack, send]);
  useEffect(() => {
    handleOpenRef.current = handleOpen;
  });

  /** Set when the player goes back to the sealed pack, so the pack takes focus once it's there. */
  const focusOpenRef = useRef(focusPackOnMount);

  const retryOpen = useCallback(() => {
    if (refusal === 'blocked') {
      reloadPage();
      return;
    }
    if (refusal === 'unreadable' && onOpenSave) {
      onOpenSave();
      return;
    }
    // Try again goes as the pack is torn again (busy while the ticket is on its way): focus moves to
    // the pack rather than falling to the page for the whole wait.
    focusIfFree(packRef.current);
    handleOpen();
  }, [refusal, handleOpen, packRef, onOpenSave]);
  /** The sealed pack's stage, which scrolls on a desktop window (PackOpener.css). */
  const stageRef = useRef<HTMLDivElement>(null);
  /** Whether the player has scrolled the stage since it was last at the top. */
  const stageScrolledRef = useRef(false);
  const markStageScrolled = useCallback(() => { stageScrolledRef.current = true; }, []);
  // The stage is on its way out when the cards come in, and the reveal must not inherit anything it
  // scrolled to: it goes back to the top as opening starts. Setting scrollTop makes the browser lay
  // the whole page out inside the commit that brings the cards in, which on a slow phone is the
  // longest stall between the tear and the first card (#266). A stage that never scrolled (every
  // phone, and most packs on a desktop) is already at the top, so it is left alone.
  useLayoutEffect(() => {
    if (!isOpening || !stageScrolledRef.current) return;
    stageScrolledRef.current = false;
    if (stageRef.current) stageRef.current.scrollTop = 0;
  }, [isOpening]);
  // A refusal replaces the button the player was on: its Try again takes focus.
  const retryButtonRef = useCallback((el: HTMLButtonElement | null) => focusIfFree(el), []);

  const clearEffectTimers = useCallback(() => {
    effectTimersRef.current.forEach(clearTimeout);
    effectTimersRef.current.clear();
    burstForRef.current = null;
  }, []);

  const finishPack = useCallback(() => {
    clearEffectTimers();
    skippingRef.current = false;
    setSkipping(false);
    if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    celebrationTimerRef.current = null;
    revealLockedUntilRef.current = 0;
    setRevealLocked(false);
    setCelebratingCardId(null);
    stopAll();
    const assets = preloadedRef.current;
    preloadedRef.current = null;
    if (assets) {
      cleanupAudio(assets.brainrotVoices);
      cleanupAudio([assets.cardFlip]);
      cleanupAudio(assets.effects);
    }
    setPreloadedAssets(null);
    setOpenedPack(null);
    setOpenedCards([]);
    setCurrentIndex(0);
    setHasMovedMouse(false);
    resetCutState();
    focusOpenRef.current = true;
  }, [resetCutState, cleanupAudio, stopAll, clearEffectTimers]);

  // What a card shared from the summary links to: this pull (one object, so its proof is signed once).
  const pullRef = useMemo((): PullRef | undefined => openedPack
    ? { setId: openedPack.setId, setVersion: openedPack.setVersion, nonce: openedPack.nonce, publicKeyHex: openedPack.publicKeyHex }
    : undefined, [openedPack]);
  /** The shown pack, face up (see faceUp). */
  const dealtPack = useCallback((): OpenedPack | null => (openedPack ? faceUp(openedPack) : null), [openedPack]);

  /** Hands the pack a transition gave to the collection (packLifecycle gives it once, from the stage, not from what React last rendered). */
  const recordPack = useCallback((pack: OpenedPack) => onOpen(faceUp(pack)), [onOpen]);

  const nextCard = useCallback(() => {
    if (pauseBigPulls && performance.now() < revealLockedUntilRef.current) return;
    if (currentIndex < openedCards.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      const { record } = send({ type: 'finish' });
      if (record) recordPack(record);
    }
  }, [currentIndex, openedCards, recordPack, pauseBigPulls, send]);

  /** With the pause enabled, Skip still gives each valuable card its full reveal. */
  const skipAll = useCallback(() => {
    if (disabled || skippingRef.current || (pauseBigPulls && performance.now() < revealLockedUntilRef.current)) return;
    if (!pauseBigPulls) {
      setOpenedCards(openedCards.map((card) => ({ ...card, isRevealed: true })));
      const { record } = send({ type: 'finish' });
      if (record) recordPack(record);
      return;
    }
    skippingRef.current = true;
    setSkipping(true);
  }, [disabled, pauseBigPulls, openedCards, recordPack, send]);

  const closeSummary = useCallback(() => {
    if (send({ type: 'close' }).from.kind === 'summary') finishPack();
  }, [finishPack, send]);

  /**
   * Any stage of a pack, from the tear to the summary: the pack's X, Escape and browser Back. A torn
   * pack the player left while its ticket is on its way already looks sealed again; it stays busy
   * (isPackCut) until the ticket lands and is recorded. A pack another tab's save kept sealed isn't
   * one: the app's banner and Settings, which offer the same reload, stay in reach.
   */
  const stageInPack = (isPackCut && !leavingOpen) || isOpening || refusal === 'failed';

  // Focus mode (#312): the app's chrome stays out of the way for the whole pack, summary included, and
  // comes back as soon as the player leaves it, even while a left pack's ticket is still on its way. It
  // changes before paint, in the same frame as the stage below takes or lets go of its size.
  useLayoutEffect(() => onFocusChange?.(stageInPack), [stageInPack, onFocusChange]);
  // Unmounted mid-pack (the set changed under its summary): the pack is gone, so the chrome comes back.
  // onFocusChange is a state setter, so this runs on unmount only, never between renders.
  useEffect(() => () => onFocusChange?.(false), [onFocusChange]);

  // The pack is fitted to its stage, and the stage would grow into the room the chrome leaves as the
  // pack tears: the pack got bigger as it opened. The stage keeps the size and place it had at rest
  // until the pack is done, unless the window itself resizes, or chrome that wasn't there at rest comes
  // in above or below it (a new player's first pack, left while its ticket is on its way, brings the
  // set picker and tabs): either fits the pack to the room it has now. A pack left while its ticket is
  // on its way is done when the ticket lands (the card guide comes back then).
  const holdStage = stageInPack || busy;
  /** Moves the held stage back to its place at rest as the room around it moves. */
  const followRoomRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const room = stage?.parentElement;
    if (!holdStage || !stage || !room) return;
    const height = parseFloat(getComputedStyle(stage).height);
    if (!(height > 0)) return; // Not laid out (jsdom).
    const rest = room.getBoundingClientRect();
    let held = true;
    stage.style.flex = 'none';
    stage.style.height = `${height}px`;
    const follow = () => {
      if (!held) return;
      const now = room.getBoundingClientRect();
      // Held there, the stage would run under that chrome.
      if (now.top > rest.top + 0.5 || now.height < rest.height - 0.5) release();
      else stage.style.top = `${rest.top - now.top}px`;
    };
    followRoomRef.current = follow;
    const observer = new ResizeObserver(follow);
    observer.observe(room);
    const release = () => {
      held = false;
      followRoomRef.current = null;
      observer.disconnect();
      window.removeEventListener('resize', release);
      stage.style.flex = stage.style.height = stage.style.top = '';
    };
    window.addEventListener('resize', release);
    return release;
  }, [holdStage]);
  // The room moves as the chrome above it goes or comes back, in the app's render of the focus change
  // above, which ends before this task does: the held stage follows it in the same task. The observer
  // catches anything else that moves the room, before paint.
  useLayoutEffect(() => {
    const follow = followRoomRef.current;
    if (follow) queueMicrotask(follow);
  }, [stageInPack]);

  /**
   * Back to the packs screen from any stage, keeping whatever the pack already spent. It works during
   * a big pull's pause too (ending its celebration): the pause holds the cards, not the player.
   */
  const leavePack = useCallback(() => {
    // A second leave before React renders (a held key, a double tap) finds the first one's stage.
    const left = send({ type: 'leave' });
    if (left.stage === left.from) return;
    switch (left.from.kind) {
      case 'revealing': {
        // Mid-reveal: the pack is recorded with every card, as finishing it would.
        // Before React has rendered the reveal there are no cards shown yet: that is leaving early too.
        const leftEarly = openedCards.length === 0 || openedCards.some((card) => !card.isRevealed);
        const pack = faceUp(left.record!);
        recordPack(left.record!);
        finishPack();
        if (leftEarly) onLeaveEarly?.(pack);
        break;
      }
      case 'summary':
        // Already recorded.
        finishPack();
        break;
      case 'tearing':
        // Torn, but its ticket isn't spent yet: put the pack back sealed.
        if (openTimeoutRef.current) window.clearTimeout(openTimeoutRef.current);
        openTimeoutRef.current = null;
        resetCutState();
        focusOpenRef.current = true;
        break;
      case 'waiting':
        // Its ticket is spent and still on its way: startOpening records it when it lands.
        resetCutState();
        setLeavingWaiting(false);
        focusOpenRef.current = true;
        break;
      case 'sealed':
        // A refusal dismissed.
        resetCutState();
        focusOpenRef.current = true;
        break;
    }
  }, [send, openedCards, recordPack, finishPack, onLeaveEarly, resetCutState]);

  // Back on the sealed pack (a torn pack put back, a refusal dismissed, Try again): the X the player
  // left by has gone, so focus goes to the pack rather than the page.
  useEffect(() => {
    if (!focusOpenRef.current || stageInPack || !packRef.current) return;
    focusOpenRef.current = false;
    focusIfFree(packRef.current);
  });

  // Like skipAll: an open sheet disables the opener, so a stray press or key behind it does nothing.
  const leaveFromUi = useCallback(() => {
    if (!disabled) leavePack();
  }, [disabled, leavePack]);

  // Browser Back goes through the same guard: behind a sheet it leaves nothing, and the pack keeps its entry.
  usePackHistory(stageInPack, leaveFromUi);

  const handleFlip = useCallback(() => {
    const currentCard = openedCards[currentIndex];
    if (!currentCard || currentCard.isRevealed || !preloadedAssets) return;

    if (isSpecialReveal(currentCard)) {
      // The celebration always plays; the setting controls only the input lock.
      setCelebratingCardId(currentCard.uniqueId);
      revealLockedUntilRef.current = pauseBigPulls ? performance.now() + SPECIAL_REVEAL_DURATION_MS : 0;
      setRevealLocked(pauseBigPulls);
      if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
      celebrationTimerRef.current = setTimeout(() => {
        revealLockedUntilRef.current = 0;
        celebrationTimerRef.current = null;
        setRevealLocked(false);
        setCelebratingCardId(null);
      }, SPECIAL_REVEAL_DURATION_MS);
    }

    if (effectsVolume > 0) {
      playAndCleanup(preloadedAssets.cardFlip, effectsVolume);
      const effects = preloadedAssets.effects;
      const timer = setTimeout(() => {
        effectTimersRef.current.delete(timer);
        playRandom(effects, effectsVolume);
      }, EFFECT_DELAY_MS);
      effectTimersRef.current.add(timer);
    }

    setOpenedCards(openedCards.map((card, index) => index === currentIndex ? { ...card, isRevealed: true } : card));

    // A short buzz on phones: a tick for any card, a double for big pulls. None under reduced motion.
    buzz(isBigPull(currentCard) ? [18, 60, 30] : 8);

    if (settings.particlesEnabled && !prefersReducedMotion()) {
      // A finish or misprint gets at least an Epic's confetti.
      const modified = !!currentCard.finish || !!currentCard.misprint;
      const plainish = currentCard.rarity === 'COMMON' || currentCard.rarity === 'UNCOMMON' || currentCard.rarity === 'RARE';
      const rarity = modified && plainish ? 'EPIC' : currentCard.rarity;
      const holo = currentCard.isHolo;
      const flipped = currentCard.uniqueId;
      burstForRef.current = flipped;
      loadConfetti().then(
        ({ triggerRarityConfetti, triggerHoloSparkles }) => {
          // Late (the first load was slow): a later flip or the end of the pack has moved on.
          if (burstForRef.current !== flipped) return;
          triggerRarityConfetti(rarity);
          if (holo) triggerHoloSparkles();
        },
        () => {},
      );
    }
  }, [openedCards, currentIndex, preloadedAssets, playAndCleanup, playRandom, settings, effectsVolume, pauseBigPulls]);

  // A skip is a short sequence: mount each valuable card face down, flip it, wait for its lock,
  // then move to the next. Already revealed cards don't repeat their celebration.
  useEffect(() => {
    if (!skipping || (revealLocked && pauseBigPulls) || !isOpening || showSummary || disabled) return;
    // Give a newly mounted card a frame face down before starting its flip.
    const frame = requestAnimationFrame(() => {
      const nextIndex = pauseBigPulls ? nextSpecialRevealIndex(openedCards) : -1;
      if (nextIndex === -1) {
        setOpenedCards(openedCards.map((card) => ({ ...card, isRevealed: true })));
        const { record } = send({ type: 'finish' });
        if (record) recordPack(record);
        skippingRef.current = false;
        setSkipping(false);
      } else if (currentIndex !== nextIndex) {
        setOpenedCards(openedCards.map((card, index) => index < nextIndex ? { ...card, isRevealed: true } : card));
        setCurrentIndex(nextIndex);
      } else {
        handleFlip();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [skipping, revealLocked, pauseBigPulls, isOpening, showSummary, disabled, openedCards, currentIndex, handleFlip, recordPack, send]);

  const handleInteraction = useCallback(() => {
    if (!isOpening || showSummary || disabled || skippingRef.current || (pauseBigPulls && performance.now() < revealLockedUntilRef.current)) return;

    const currentItem = openedCards[currentIndex];
    if (currentItem && !currentItem.isRevealed) {
      handleFlip();
    } else {
      nextCard();
    }
  }, [isOpening, showSummary, disabled, openedCards, currentIndex, handleFlip, nextCard, pauseBigPulls]);

  // Held Space reads the current interaction without a stale closure.
  useEffect(() => {
    handleInteractionRef.current = handleInteraction;
  }, [handleInteraction]);

  // The summary's settle window starts as it appears. Its clicks, its data-settling attribute and the keyboard
  // all read this one state, so Space and Enter work the moment the attribute clears (#972).
  const summaryGuard = useStageClickGuard(undefined, showSummary);

  // Use keyboard controls hook
  useKeyboardControls({
    isOpening,
    showSummary,
    summarySettling: summaryGuard.settling,
    disabled,
    onCloseSummary: closeSummary,
    onOpenPack: handleOpen,
    handleInteractionRef,
    inPack: stageInPack,
    onLeave: leaveFromUi,
  });

  // Play "what kind of brainrot" when a new card appears
  useEffect(() => {
    if (isOpening && preloadedAssets && openedCards[currentIndex] && !openedCards[currentIndex].isRevealed && effectsVolume > 0) {
      const timer = setTimeout(() => {
        playRandom(preloadedAssets.brainrotVoices, effectsVolume);
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [isOpening, currentIndex, preloadedAssets, openedCards, playRandom, effectsVolume]);

  // Hide mouse hint after user moves mouse
  useEffect(() => {
    if (!isOpening || hasMovedMouse) return;
    const handleMouseMove = () => setHasMovedMouse(true);
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isOpening, hasMovedMouse]);

  // Pointer event listeners for cutting. Losing focus or hiding the page (switching apps, often
  // without a pointerup) ends a stroke and drops its pending frame, sparks and sound (#266).
  useEffect(() => {
    const endWhenHidden = () => {
      if (document.visibilityState === 'hidden') endCutAttempt();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    window.addEventListener('blur', endCutAttempt);
    document.addEventListener('visibilitychange', endWhenHidden);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
      window.removeEventListener('blur', endCutAttempt);
      document.removeEventListener('visibilitychange', endWhenHidden);
    };
  }, [handlePointerDown, handlePointerMove, handlePointerEnd, endCutAttempt]);

  // Unmounted mid-reveal (the set list changed under it): the pack still goes to the collection. One
  // still waiting for its ticket is kept when the ticket lands (startOpening).
  // It records through the onOpen of its last render. App's handlePackOpened then has a stale default
  // progress, but the App can't unmount an opener holding a pack: the opener is keyed by set, and
  // switching sets, set links and Settings are disabled while a pack is busy.
  const recordOnUnmountRef = useRef(recordPack);
  useEffect(() => {
    recordOnUnmountRef.current = recordPack;
  }, [recordPack]);

  useEffect(() => () => {
    const { record } = send({ type: 'unmount' });
    if (record) recordOnUnmountRef.current(record);
  }, [send]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (celebrationTimerRef.current) clearTimeout(celebrationTimerRef.current);
    clearEffectTimers();
    if (openTimeoutRef.current) {
      window.clearTimeout(openTimeoutRef.current);
    }
    cleanupCutter();
  }, [cleanupCutter, clearEffectTimers]);

  const currentCard = openedCards[currentIndex];
  // The showcase lasts as long as the celebration: its timer, moving on, the X or the summary ends it.
  const showcase = isOpening && !showSummary && !!currentCard?.isRevealed
    && celebratingCardId === currentCard.uniqueId && isSpecialReveal(currentCard);
  // A skip still heading for a big pull keeps the hold between showcases, so a notice can't flash
  // in the frames it takes to reach the next one (#460).
  const holdNotices = showcase || (skipping && pauseBigPulls && isOpening && !showSummary && nextSpecialRevealIndex(openedCards) !== -1);
  // Before paint, so a notice can't flash in the frame the ribbon first shows.
  useLayoutEffect(() => {
    if (!holdNotices) return;
    onShowcaseChange?.(true);
    return () => onShowcaseChange?.(false);
  }, [holdNotices, onShowcaseChange]);

  const waiting = (slowOpen && isPackCut && !isOpening && !leavingOpen) || (leavingOpen && leavingWaiting);
  // The pack's one polite live region, for every stage: why a pack stayed sealed, the wait for a slow
  // ticket, and each card as it turns face up (never before, so nothing is spoiled). It is always
  // mounted, so a change is read. The summary says itself: its heading takes focus.
  const announcement = refusal
    ? REFUSAL_COPY[refusal].message
    : waiting
      ? 'Opening the pack…'
      : isOpening && !showSummary && currentCard
        ? revealAnnouncement(currentCard, currentIndex, openedCards.length) ?? ''
        : '';

  return (
    <div className="pack-opener-container">
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {stageInPack && (
        <PackTopBar
          onLeave={leaveFromUi}
          progress={isOpening && !showSummary ? { index: currentIndex, total: openedCards.length } : undefined}
          showcase={showcase ? <ShowcaseRibbon card={currentCard} holding={revealLocked && pauseBigPulls} /> : undefined}
        />
      )}
      {/* The torn pack flies off as the first card back fades in, not before it: waiting for the exit
          left an empty stage between the tear and the reveal (#312 P2-6). The leaving one lifts itself
          out of the flow (Lifted), so the two overlap in place. */}
      <AnimatePresence>
        {!isOpening ? (
          <Lifted
            key="pack"
            ref={stageRef}
            onScroll={markStageScrolled}
            {...stageEntrance(landed, reducedMotion)}
            onAnimationStart={(definition) => {
              markLanded();
              if (definition !== STAGE_AT_REST || reachedPlace.current) return;
              // Each frame, how far above its place the stage is drawn. An onUpdate prop could say, but it
              // takes all of the stage's animations off the compositor (framer-motion), and under reduced
              // motion the torn pack's exit then never ends. The completion catches a fall that stops short.
              const element = stageRef.current;
              const watch = () => {
                if (reachedPlace.current || !element?.isConnected) return;
                const { transform } = getComputedStyle(element);
                const matrix = /^matrix(3d)?\((.*)\)$/.exec(transform);
                const y = transform === 'none' ? 0 : matrix ? Number(matrix[2].split(',')[matrix[1] ? 13 : 5]) : NaN;
                if (y >= 0) markInPlace();
                else requestAnimationFrame(watch);
              };
              requestAnimationFrame(watch);
            }}
            onAnimationComplete={(definition) => {
              if (definition === STAGE_AT_REST) markInPlace();
            }}
            data-falling={(falling && !reducedMotion) || undefined}
            animate={shown ? STAGE_AT_REST : false}
            // Quick, on its own timing: the drop-in spring's long tail left the screen blank before the reveal.
            exit={{ scale: 1.25, opacity: 0, transition: { duration: 0.25, ease: 'easeIn' } }}
            className="pack-display"
          >
            <PackCuttingUI
              packRef={packRef}
              packDesign={packDesign}
              set={set}
              isCutting={isCutting}
              pressing={isPressing}
              isPackCut={isPackCut && !leavingOpen}
              waiting={waiting}
              refusal={refusal}
              onOpen={handleOpen}
              onRetry={retryOpen}
              retryButtonRef={retryButtonRef}
              nudging={nudging === 'miss'}
              fellShort={nudging === 'short'}
              cutPoints={cutPoints}
              sparkCanvasRef={sparkCanvasRef}
              cue={cue}
              onCueEnd={endCue}
              onTouch={touchPack}
            />
          </Lifted>
        ) : (
          <Lifted
            key="opening"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            className="card-reveal-area"
          >
            {!showSummary ? (
              <CardRevealUI
                currentCard={currentCard}
                cardBack={cardBack}
                currentIndex={currentIndex}
                totalCards={openedCards.length}
                hasMovedMouse={hasMovedMouse}
                onInteraction={handleInteraction}
                onSkip={skipAll}
                revealLocked={revealLocked && pauseBigPulls}
                celebrating={celebratingCardId === currentCard?.uniqueId}
                skipping={skipping}
                setName={set.name}
                firstPack={openCue}
              />
            ) : (
              <PackSummaryUI
                openedCards={openedCards}
                set={set}
                onClose={closeSummary}
                onShare={openedPack ? () => onShare(dealtPack()!) : undefined}
                pack={pullRef}
                onOpenRankingsHelp={onOpenRankingsHelp}
                holdOptional={!disabled}
                guard={summaryGuard}
                packChoices={packChoices}
              />
            )}
          </Lifted>
        )}
      </AnimatePresence>
    </div>
  );
};

export default PackOpener;
